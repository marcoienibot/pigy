import { expect, type Page, test } from "../fixtures.ts";

// What the content security policy refuses reaches pigy: the browser
// reports it to the endpoint that the policy names, and the Worker takes
// it, apps/worker/src/policy-reports.ts. The Worker tests cover what the
// endpoint does with a report and what it writes into the log. These are
// about the built app and a real browser.
//
// The Chromium of the tests queues a report of the Reporting API for the
// endpoint and never sends it: in every round of delivery the report is
// taken up and put back without an attempt, with or without the switch
// that shortens the round, the permission for background sync, a profile
// of its own or an address of the endpoint in full. Most likely because
// the endpoint is not HTTPS here, which a deployed pigy's is: PLAN.md
// section 19 has it. So the first test shows what Chromium makes of the policy and
// hands that to the endpoint itself, and the second has a real delivery,
// by `report-uri`, which is what a browser without the Reporting API uses.
//
// The endpoint answers 204 also for a report that it drops, so these
// tests cannot tell whether it wrote the line. The bodies that Chromium
// makes here are in apps/worker/test/chromium-reports.ts, as they were,
// and a Worker test holds the line to them: take them again from here,
// with a line that prints `report` and the body that `delivered` sent,
// when Chromium changes what it sends.

/** Writes a script into `page`, which the policy must refuse. */
async function injectScript(page: Page): Promise<void> {
  const ran = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.pigyInjected = true";
    document.head.append(script);
    return "pigyInjected" in window;
  });
  expect(ran).toBe(false);
}

/** A report as the DevTools protocol has it, as far as the test reads it. */
type Report = {
  type: string;
  destination: string;
  initiatorUrl: string;
  body: Record<string, unknown>;
};

test("Chromium reports a refusal of the built app to the endpoint that its headers name, in a form that the endpoint takes", async ({
  page,
  policyViolations,
}) => {
  // The reports that Chromium has queued for the page, as DevTools shows
  // them.
  const cdp = await page.context().newCDPSession(page);
  const reports: Report[] = [];
  cdp.on("Network.reportingApiReportAdded", ({ report }) =>
    reports.push(report as Report),
  );
  await cdp.send("Network.enableReportingApi", { enable: true });

  await page.goto("/sign-in");
  // The page is drawn: its own scripts were let through.
  await expect(page.locator("#root > *").first()).toBeVisible();
  await injectScript(page);
  await expect.poll(() => policyViolations).toHaveLength(1);
  // The violation of the test's own, which must not fail it.
  policyViolations.length = 0;

  // `report-to csp` of the policy, and `csp` of `Reporting-Endpoints`:
  // Chromium took both.
  await expect.poll(() => reports).toHaveLength(1);
  const [report] = reports;
  expect(report).toMatchObject({
    type: "csp-violation",
    destination: "csp",
    body: {
      documentURL: new URL("/sign-in", page.url()).href,
      effectiveDirective: "script-src-elem",
      blockedURL: "inline",
    },
  });

  // What Chromium would send, in the envelope of the Reporting API: the
  // endpoint takes it as it is, from a browser that nobody is signed in
  // on.
  const answer = await page.request.post("/api/policy-reports", {
    headers: { "Content-Type": "application/reports+json" },
    data: JSON.stringify([
      {
        age: 0,
        type: report?.type,
        url: report?.initiatorUrl,
        user_agent: await page.evaluate(() => navigator.userAgent),
        body: report?.body,
      },
    ]),
  });
  expect(answer.status()).toBe(204);
});

test("a browser that reports by report-uri reaches the endpoint, which takes the report", async ({
  page,
  policyViolations,
}) => {
  // The policy of the page without `report-to`: Chromium then reports by
  // `report-uri`, as a browser without the Reporting API does, and sends
  // the report at once, from the page.
  await page.route("**/sign-in", async (route) => {
    const response = await route.fetch();
    const policy = response.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("; report-to csp; report-uri ");
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy": policy.replace("; report-to csp", ""),
      },
    });
  });
  await page.goto("/sign-in");
  await expect(page.locator("#root > *").first()).toBeVisible();

  const delivered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/policy-reports",
  );
  await injectScript(page);
  await expect.poll(() => policyViolations).toHaveLength(1);
  policyViolations.length = 0;

  const response = await delivered;
  expect(response.status()).toBe(204);
  expect(response.request().headers()["content-type"]).toBe(
    "application/csp-report",
  );
  expect(JSON.parse(response.request().postData() ?? "{}")).toMatchObject({
    "csp-report": {
      "document-uri": new URL("/sign-in", page.url()).href,
      "effective-directive": "script-src-elem",
      "blocked-uri": "inline",
    },
  });
});
