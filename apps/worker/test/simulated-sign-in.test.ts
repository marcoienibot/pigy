import { errorResponseSchema } from "@pigy/core";
import { expect, it, onTestFinished, vi } from "vitest";
import { users } from "../src/db/schema.ts";
import { type Browser, locationOf, me, setup } from "./helpers.ts";

// Where `pnpm dev` serves the app. The simulated Google answers only when
// the app is reached on the machine it runs on.
const local = "http://localhost:5173";

// The app as `pnpm dev` runs it after a fresh clone: no Google credentials,
// no ADMIN_EMAILS, and a simulated Google built in.
function setupSimulated(env: { ADMIN_EMAILS?: string } = {}) {
  return setup({
    simulatedGoogle: true,
    env: {
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      ADMIN_EMAILS: undefined,
      ...env,
    },
  });
}

/** Signs in through the pages of the simulated Google, as a person would. */
async function signInThroughPages(browser: Browser, email: string) {
  const start = await browser.fetch("/api/auth/google/start");
  const consentUrl = locationOf(start);
  // The consent form posts to the address it was loaded from. A form
  // submission is not a JSON request, so it is sent without the helper.
  const submitted = await browser.send(
    new Request(consentUrl, {
      method: "POST",
      body: new URLSearchParams({
        email,
        email_verified: "on",
        action: "continue",
      }),
    }),
  );
  return browser.fetch(locationOf(submitted));
}

it("sends the browser to a consent page that the app itself serves", async () => {
  const test = setupSimulated();
  const browser = test.browser(local);

  const start = await browser.fetch("/api/auth/google/start");

  // A browser could not reach the simulated Google on Google's hosts.
  const consentUrl = new URL(locationOf(start));
  expect(consentUrl.origin).toBe(local);
  expect(consentUrl.pathname).toBe("/sim/google/o/oauth2/v2/auth");
  const page = await browser.fetch(consentUrl.pathname + consentUrl.search);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("Simulation");
  // The default admin is offered, so that a fresh clone needs no reading.
  expect(html).toContain("admin@example.com");
});

it("signs in the default admin without any configuration", async () => {
  const test = setupSimulated();
  const browser = test.browser(local);

  const response = await signInThroughPages(browser, "admin@example.com");

  expect(locationOf(response)).toBe("/");
  expect(await me(browser)).toMatchObject({
    user: { email: "admin@example.com" },
    role: "admin",
  });
});

it("still refuses somebody who is not invited", async () => {
  const test = setupSimulated();
  const browser = test.browser(local);

  const response = await signInThroughPages(browser, "eve@example.com");

  expect(locationOf(response)).toBe("/invite-only");
  expect(await test.db.select().from(users)).toEqual([]);
});

it("has no default admin once ADMIN_EMAILS is set", async () => {
  const test = setupSimulated({ ADMIN_EMAILS: "owner@example.com" });

  const asDefaultAdmin = await signInThroughPages(
    test.browser(local),
    "admin@example.com",
  );
  const asOwner = await signInThroughPages(
    test.browser(local),
    "owner@example.com",
  );

  expect(locationOf(asDefaultAdmin)).toBe("/invite-only");
  expect(locationOf(asOwner)).toBe("/");
});

it.each([
  "https://pigy.example.workers.dev",
  "https://localhost.evil.example",
  "http://192.168.1.20:5173",
])("does not simulate Google when the app is reached at %s", async (origin) => {
  // The build has a simulated Google, but the app is not reached on the
  // machine it runs on. A deployment of such a build would look like this.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const test = setupSimulated();
  const browser = test.browser(origin);

  const start = await browser.fetch("/api/auth/google/start");
  const page = await browser.fetch("/sim/google/o/oauth2/v2/auth");

  expect(locationOf(start)).toBe("/sign-in?error=not_configured");
  expect(page.status).toBe(404);
});

it("uses the real Google and serves no simulated pages once credentials are set", async () => {
  // A build with a simulated Google, such as `pnpm dev`, but with Google
  // credentials in .dev.vars.
  const test = setup({ simulatedGoogle: true });
  const browser = test.browser(local);

  const start = await browser.fetch("/api/auth/google/start");
  const simulatedPage = await browser.fetch(
    "/sim/google/o/oauth2/v2/auth?client_id=x",
  );

  expect(new URL(locationOf(start)).origin).toBe("https://accounts.google.com");
  expect(simulatedPage.status).toBe(404);
  expect(errorResponseSchema.parse(await simulatedPage.json()).error).toBe(
    "NotFoundError",
  );
});

it("refuses to sign anybody in without Google credentials and without a simulated Google", async () => {
  // A production build that was deployed without its secrets.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const test = setup({
    env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined },
  });
  const browser = test.browser(local);

  const start = await browser.fetch("/api/auth/google/start");
  // Even with a callback made up to look complete.
  const callback = await browser.fetch(
    "/api/auth/google/callback?code=x&state=y",
  );
  const simulatedPage = await browser.fetch("/sim/google/o/oauth2/v2/auth");

  expect(locationOf(start)).toBe("/sign-in?error=not_configured");
  expect(locationOf(callback)).toBe("/sign-in?error=failed");
  expect(simulatedPage.status).toBe(404);
  expect(browser.cookies.size).toBe(0);
  // Whoever deployed it finds the reason in the logs.
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("GOOGLE_CLIENT_ID"),
  );
});

it("needs both the client ID and the secret to use the real Google", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const test = setup({ env: { GOOGLE_CLIENT_SECRET: "" } });

  const start = await test.browser().fetch("/api/auth/google/start");

  expect(locationOf(start)).toBe("/sign-in?error=not_configured");
});
