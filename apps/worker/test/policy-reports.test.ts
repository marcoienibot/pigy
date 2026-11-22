import { mediaFilePath, sandboxImagePath } from "@pigy/core";
import { expect, it } from "vitest";
import { mediaLinkPath } from "../src/media/links.ts";
import {
  maxLinesPerRequest,
  maxPageSegments,
  maxReportBytes,
  maxReportsPerRequest,
  policyReportPath,
} from "../src/policy-reports.ts";
import { chromiumReportingApi, chromiumReportUri } from "./chromium-reports.ts";
import {
  entriesOf,
  expectWarnings,
  logged,
  setup,
  type TestSetup,
} from "./helpers.ts";

/**
 * Where browsers report what the content security policy of a page of
 * pigy refused: src/policy-reports.ts. Anybody can send there, so what it
 * takes is bounded, and what it logs says nothing of a person.
 */

const origin = "https://pigy.test";

/**
 * A report of the Reporting API, as Chromium sends it: a list, of which
 * each entry has a type and a body.
 */
const reportingApi = (
  body: Record<string, unknown>,
  type = "csp-violation",
) => ({
  age: 0,
  type,
  url: body.documentURL,
  user_agent: "Mozilla/5.0",
  body: {
    disposition: "enforce",
    originalPolicy: "default-src 'none'; report-to csp",
    statusCode: 200,
    ...body,
  },
});

/** Sends `body` to the endpoint as `type`, the way a browser sends it. */
function report(
  test: TestSetup,
  body: string | ReadableStream<Uint8Array>,
  type = "application/reports+json",
  headers: Record<string, string> = {},
) {
  // No cookie and no `Origin`: a browser sends neither with a report of
  // the Reporting API.
  return test.browser().send(
    new Request(`${origin}${policyReportPath}`, {
      method: "POST",
      headers: { "Content-Type": type, ...headers },
      body,
      // For a body that is a stream.
      ...(typeof body !== "string" && { duplex: "half" }),
    } as RequestInit),
  );
}

it("logs a refusal that the Reporting API reports, with the directive, the origin of what was blocked and the page as a pattern", async () => {
  const test = setup();
  const warnings = expectWarnings();

  const response = await report(
    test,
    JSON.stringify([
      reportingApi({
        documentURL: `${origin}/settings/api?draft=0193&code=a-secret#top`,
        blockedURL: "https://cdn.example/a/b.js?token=abc",
        effectiveDirective: "script-src-elem",
      }),
      // The same again, on the same page: one line, which says how often.
      reportingApi({
        documentURL: `${origin}/settings/api`,
        blockedURL: "https://cdn.example/other.js",
        effectiveDirective: "script-src-elem",
      }),
      reportingApi({
        documentURL: `${origin}/sent`,
        blockedURL: "eval",
        effectiveDirective: "script-src",
      }),
      // Another kind of report, which the endpoint is not for.
      reportingApi({ documentURL: `${origin}/` }, "deprecation"),
    ]),
  );

  expect(response.status).toBe(204);
  expect(entriesOf(warnings)).toEqual([
    {
      level: "warn",
      kind: "policy",
      message: "The content security policy refused something on a page",
      directive: "script-src-elem",
      blocked: "https://cdn.example",
      page: "/settings/api",
      disposition: "enforce",
      count: 2,
    },
    expect.objectContaining({
      directive: "script-src",
      blocked: "eval",
      page: "/sent",
      count: 1,
    }),
  ]);
});

it("logs the refusals that Chromium reported of the built app, each way, as it sent them", async () => {
  const test = setup();
  const warnings = expectWarnings();

  // What the end-to-end tests saw Chromium make, from a page whose policy
  // has `report-to`, and from one whose policy has only `report-uri`.
  const api = await report(test, chromiumReportingApi(origin));
  const uri = await report(
    test,
    chromiumReportUri(origin),
    "application/csp-report",
  );

  expect([api.status, uri.status]).toEqual([204, 204]);
  const line = {
    level: "warn",
    kind: "policy",
    message: "The content security policy refused something on a page",
    directive: "script-src-elem",
    blocked: "inline",
    page: "/sign-in",
    disposition: "enforce",
    count: 1,
  };
  expect(entriesOf(warnings)).toEqual([line, line]);
});

it("logs a refusal that report-uri reports, in the form of CSP 3 and of the browsers before it", async () => {
  const test = setup();
  const warnings = expectWarnings();

  for (const fields of [
    { "effective-directive": "style-src-elem", "blocked-uri": "inline" },
    // The whole directive, with its sources, and no effective one.
    {
      "violated-directive": "img-src 'self' https:",
      "blocked-uri": "data:image/png;base64,AAAA",
    },
  ]) {
    const response = await report(
      test,
      JSON.stringify({
        "csp-report": {
          "document-uri": `${origin}/queue/calendar`,
          referrer: "",
          disposition: "report",
          "original-policy": "default-src 'none'",
          ...fields,
        },
      }),
      "application/csp-report",
    );
    expect(response.status).toBe(204);
  }

  expect(entriesOf(warnings)).toMatchObject([
    {
      directive: "style-src-elem",
      blocked: "inline",
      page: "/queue/calendar",
      disposition: "report",
    },
    // An address of another scheme, by its scheme alone.
    { directive: "img-src", blocked: "data:", page: "/queue/calendar" },
  ]);
});

it("writes into the log nothing of a page or an address but what pigy's own paths are made of", async () => {
  const test = setup();
  const warnings = expectWarnings();
  const id = "0193a1d9-7e50-7c08-a6a0-4187f6e57d2c";

  await report(
    test,
    JSON.stringify(
      [
        // Somebody typed an address of a person, which the app answers
        // with its shell, as it answers every path.
        `${origin}/someone@example.com`,
        `${origin}/sim/network/mastodon.example/oauth/authorize?state=s3cret`,
        `${origin}/settings/${id}`,
      ].map((documentURL) =>
        reportingApi({
          documentURL,
          blockedURL: "chrome-extension://abcdefgh/inject.js?user=someone",
          effectiveDirective: "script-src-elem",
        }),
      ),
    ),
  );

  expect(entriesOf(warnings).map(({ page }) => page)).toEqual([
    "/:other",
    "/sim/network/:other/oauth/authorize",
    "/settings/:id",
  ]);
  expect(entriesOf(warnings).map(({ blocked }) => blocked)).toEqual([
    "chrome-extension:",
    "chrome-extension:",
    "chrome-extension:",
  ]);
  const log = logged(warnings.mock.calls);
  for (const secret of ["someone", "example.com", "s3cret", "abcdefgh"]) {
    expect(log).not.toContain(secret);
  }
});

it("takes a report of an image that was opened by itself in a tab, and writes of its address the pattern of its route alone", async () => {
  const test = setup();
  const warnings = expectWarnings();
  const workspace = "0193a1d9-7e50-7c08-a6a0-4187f6e57d2c";
  const image = "0193a1d9-7e51-7a00-8000-4187f6e57d2d";

  // The bytes of an image are no page, and their policy is asked of none
  // in the app: only of an image that somebody opens by itself in a tab,
  // a document of its own, which `sandbox` of the policy gives an origin
  // of its own too. Its address is still pigy's, and says what it is.
  await report(
    test,
    JSON.stringify(
      [
        mediaFilePath(workspace, image, "original"),
        // A signed link is a secret while it lasts, and its signature is
        // in the query.
        `${mediaLinkPath}/${workspace}/${image}/variants/jpeg-1000000-0?expires=1795389859516&signature=c2lnbmVkLWJ5LXBpZ3k`,
        sandboxImagePath(
          "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
        ),
      ].map((path) =>
        reportingApi({
          documentURL: `${origin}${path}`,
          blockedURL: "inline",
          effectiveDirective: "style-src-elem",
        }),
      ),
    ),
  );

  expect(entriesOf(warnings).map(({ page }) => page)).toEqual([
    "/api/workspaces/:id/media/:id/original",
    "/api/media-links/:id/:id/variants/:other",
    "/api/sandbox/images/:other",
  ]);
  const log = logged(warnings.mock.calls);
  for (const secret of ["c2lnbmVkLWJ5LXBpZ3k", "1795389859516", "bafkrei"]) {
    expect(log).not.toContain(secret);
  }
});

it("says no more of a long path than a path of pigy has", async () => {
  const test = setup();
  const warnings = expectWarnings();

  // An address of thousands of segments, which the app answers with its
  // shell: the line would be longer than the report.
  await report(
    test,
    JSON.stringify([
      reportingApi({
        documentURL: `${origin}/settings${"/a".repeat(10_000)}`,
        blockedURL: "eval",
        effectiveDirective: "script-src",
      }),
    ]),
  );

  const [line] = entriesOf(warnings);
  expect(line?.page).toBe(
    `/settings${"/:other".repeat(maxPageSegments - 1)}/…`,
  );
});

it("drops what is reported of a page that is not pigy's", async () => {
  const test = setup();
  const warnings = expectWarnings();

  // Another site whose policy names this endpoint, or anybody who sends.
  const response = await report(
    test,
    JSON.stringify([
      reportingApi({
        documentURL: "https://elsewhere.example/settings",
        blockedURL: "eval",
        effectiveDirective: "script-src",
      }),
      reportingApi({ blockedURL: "eval", effectiveDirective: "script-src" }),
    ]),
  );

  expect(response.status).toBe(204);
  expect(entriesOf(warnings)).toEqual([]);
});

it("reads no more than a report can be, and nothing that is no report", async () => {
  const test = setup();
  const warnings = expectWarnings();

  // A body that says that it is too large is not read at all.
  const said = await report(test, "x".repeat(maxReportBytes + 1));
  expect(said.status).toBe(413);

  // One that does not say so is read up to the bound, and no further: it
  // would go on for ever.
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const read = await report(test, endless);
  expect(read.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulled * 16 * 1024).toBeLessThan(maxReportBytes + 64 * 1024);

  expect((await report(test, "{", "application/csp-report")).status).toBe(400);
  expect((await report(test, "[]", "text/plain")).status).toBe(415);
  expect(entriesOf(warnings)).toEqual([]);
});

it("logs no more of one request than a request may hold: the kinds that came most often", async () => {
  const test = setup();
  const warnings = expectWarnings();
  const refusal = (host: number) =>
    reportingApi({
      documentURL: `${origin}/`,
      blockedURL: `https://host-${host}.example/`,
      effectiveDirective: "img-src",
    });

  await report(
    test,
    JSON.stringify([
      // Kinds that come once, and after them one that comes three times
      // and one that comes twice, which are the ones that are written
      // first: as many reports as a request may hold.
      ...Array.from({ length: maxReportsPerRequest - 5 }, (_, index) =>
        refusal(index + 10),
      ),
      refusal(1),
      refusal(2),
      refusal(1),
      refusal(2),
      refusal(1),
      // Past what a request may hold: not looked at.
      ...Array.from({ length: 10 }, () => refusal(3)),
    ]),
  );

  const lines = entriesOf(warnings);
  expect(lines).toHaveLength(maxLinesPerRequest);
  expect(lines.slice(0, 2)).toMatchObject([
    { blocked: "https://host-1.example", count: 3 },
    { blocked: "https://host-2.example", count: 2 },
  ]);
  expect(lines.map(({ blocked }) => blocked)).not.toContain(
    "https://host-3.example",
  );
});

it("takes as many requests from a client as its limiter lets through, counted by its address, which it writes nowhere", async () => {
  const keys: string[] = [];
  const test = setup({
    policyReportLimiter: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.filter((seen) => seen === key).length <= 2 };
      },
    },
  });
  const warnings = expectWarnings();
  const body = JSON.stringify([
    reportingApi({
      documentURL: `${origin}/`,
      blockedURL: "eval",
      effectiveDirective: "script-src",
    }),
  ]);
  const from = (address: string) =>
    report(test, body, "application/reports+json", {
      "CF-Connecting-IP": address,
    });

  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    statuses.push((await from("192.0.2.1")).status);
  }
  // Another client has a count of its own.
  statuses.push((await from("192.0.2.2")).status);
  // An address of IPv6 counts with every other of its network of 64 bits:
  // whoever has one of them has all of them.
  for (const address of [
    "2001:db8:1:2::1",
    "2001:0db8:0001:0002:ffff:ffff:ffff:ffff",
    "2001:db8:1:2:0:0:0:3",
    "2001:db8:1:3::1",
  ]) {
    statuses.push((await from(address)).status);
  }

  expect(statuses).toEqual([204, 204, 429, 204, 204, 204, 429, 204]);
  expect(keys).toEqual([
    "192.0.2.1",
    "192.0.2.1",
    "192.0.2.1",
    "192.0.2.2",
    "2001:db8:1:2::/64",
    "2001:db8:1:2::/64",
    "2001:db8:1:2::/64",
    "2001:db8:1:3::/64",
  ]);
  expect(entriesOf(warnings)).toHaveLength(6);
  const log = logged(warnings.mock.calls);
  expect(log).not.toContain("192.0.2");
  expect(log).not.toContain("2001:db8");
});

it("takes no more requests from all clients together than its second limiter lets through, and reads nothing of one past it", async () => {
  const test = setup({
    policyReportTotalLimiter: {
      limit: async ({ key }) => {
        // One count for all of them.
        expect(key).toBe("all");
        return { success: false };
      },
    },
  });
  const warnings = expectWarnings();
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("[]"));
        controller.close();
      },
    },
    // Pulled when it is read, and not before.
    { highWaterMark: 0 },
  );

  const response = await report(test, body, "application/reports+json", {
    "CF-Connecting-IP": "192.0.2.9",
  });

  expect(response.status).toBe(429);
  expect(pulled).toBe(false);
  expect(entriesOf(warnings)).toEqual([]);
});
