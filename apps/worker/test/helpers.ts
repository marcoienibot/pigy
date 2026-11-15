import { env } from "cloudflare:workers";
import { type Fetch, type MeResponse, meResponseSchema } from "@pigy/core";
import { createGoogleSimulator } from "@pigy/simulators/google";
import { drizzle } from "drizzle-orm/d1";
import { expect, onTestFinished, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { allowedEmails } from "../src/db/schema.ts";
import type { Bindings } from "../src/env.ts";
import { createSimulatedGoogle } from "../src/simulated-google.ts";
import { clock } from "./clock.ts";

const origin = "https://pigy.test";
export const adminEmail = "admin@example.com";

const googleClient = {
  clientId: "pigy-test.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUris: [`${origin}/api/auth/google/callback`],
};

type Secrets = "ADMIN_EMAILS" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET";

/**
 * The app as it runs in production, with Google credentials, except that
 * the `fetch` it is given leads to a simulated Google and its clock is
 * `clock`, which is also the clock of the workspace objects. The bindings
 * are listed one by one, so that nothing from a `.dev.vars` on this machine
 * gets into the tests.
 */
export function setup(
  options: {
    /** Replaces the secrets of the same name. Undefined leaves one unset. */
    env?: { [Name in Secrets]?: string | undefined };
    /** Builds in a simulated Google, as in development. */
    simulatedGoogle?: boolean;
    /** Stands between the app and Google, to change what Google answers. */
    intercept?: (google: Fetch) => Fetch;
  } = {},
) {
  clock.time = new Date("2026-11-14T10:00:00Z");
  clock.googleLagMs = 0;
  const now = () => clock.time;
  const google = createGoogleSimulator({
    now: () => new Date(clock.time.getTime() - clock.googleLagMs),
    client: googleClient,
  });
  const app = createApp({
    fetch: options.intercept?.(google.fetch) ?? google.fetch,
    now,
    simulatedGoogle: options.simulatedGoogle
      ? createSimulatedGoogle(now)
      : undefined,
  });
  const secrets = {
    ADMIN_EMAILS: adminEmail,
    GOOGLE_CLIENT_ID: googleClient.clientId,
    GOOGLE_CLIENT_SECRET: googleClient.clientSecret,
    ...options.env,
  };
  const bindings: Bindings = {
    DB: env.DB,
    VERSION: env.VERSION,
    WORKSPACE: env.WORKSPACE,
  };
  for (const name of Object.keys(secrets) as Secrets[]) {
    const value = secrets[name];
    if (value !== undefined) bindings[name] = value;
  }
  return {
    clock,
    google,
    db: drizzle(env.DB),
    /** A browser with no cookies yet. */
    browser: (browserOrigin = origin) =>
      new Browser(
        (request) => app.request(request, undefined, bindings),
        browserOrigin,
      ),
    /** Moves the clock of the app, of the workspaces and of Google forward. */
    advance(milliseconds: number) {
      clock.time = new Date(clock.time.getTime() + milliseconds);
    },
  };
}

export type TestSetup = ReturnType<typeof setup>;

/**
 * As much of a browser as the tests need: it keeps cookies, and sends the
 * `Origin` header the way browsers do.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** The `Set-Cookie` headers of the last response, as they were sent. */
  lastSetCookies: string[] = [];

  constructor(
    /** Sends a request as it is, without cookies and without keeping any. */
    readonly send: (request: Request) => Response | Promise<Response>,
    private readonly origin: string,
  ) {}

  /**
   * Sends a request to the app. Redirects are not followed. `headers`
   * replace what a browser would send, to imitate other clients: a null
   * leaves a header out.
   */
  async fetch(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      headers?: Record<string, string | null>;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = new Headers();
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    // Browsers send it with every request that is not a GET or a HEAD.
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Origin", this.origin);
    }
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }

    const response = await this.send(
      new Request(new URL(path, this.origin), {
        method,
        headers,
        ...(init.json !== undefined && { body: JSON.stringify(init.json) }),
      }),
    );

    this.lastSetCookies = response.headers.getSetCookie();
    for (const cookie of this.lastSetCookies) {
      const [pair = "", ...attributes] = cookie.split("; ");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const deleted = attributes.some(
        (attribute) => attribute.toLowerCase() === "max-age=0",
      );
      if (deleted) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

/** Where a redirect leads, as a path within the app or a full address. */
export function locationOf(response: Response): string {
  expect(response.status).toBe(302);
  const location = response.headers.get("Location");
  if (!location) throw new Error("The redirect has no Location");
  return location;
}

export type GoogleAccount = {
  email: string;
  name?: string;
  /** The account ID. Derived from the email when left out. */
  sub?: string;
  /** False for an email address that Google has not verified. */
  verified?: boolean;
};

/**
 * Answers Google's consent page at `authorizationUrl` as `account` and
 * returns the address Google sends the browser back to.
 */
export async function consent(
  { google }: Pick<TestSetup, "google">,
  authorizationUrl: string,
  account: GoogleAccount,
): Promise<string> {
  const form = new URLSearchParams({
    email: account.email,
    action: "continue",
  });
  if (account.name) form.set("name", account.name);
  if (account.sub) form.set("sub", account.sub);
  if (account.verified !== false) form.set("email_verified", "on");
  const response = await google.fetch(authorizationUrl, {
    method: "POST",
    body: form,
  });
  return locationOf(response);
}

/**
 * A whole sign-in: the app sends the browser to Google, `account` consents,
 * Google sends the browser back. Returns the app's answer to that last step.
 */
export async function signIn(
  test: TestSetup,
  browser: Browser,
  account: GoogleAccount,
  returnTo?: string,
): Promise<Response> {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
  const start = await browser.fetch(`/api/auth/google/start${query}`);
  const callback = await consent(test, locationOf(start), account);
  return browser.fetch(callback);
}

/** A browser that is signed in as `account`. */
export async function signedIn(
  test: TestSetup,
  account: GoogleAccount,
): Promise<Browser> {
  const browser = test.browser();
  const response = await signIn(test, browser, account);
  // "/" is where a successful sign-in ends. A refusal leads elsewhere.
  expect(locationOf(response)).toBe("/");
  return browser;
}

/** Who the app takes `browser` for, or null if it is not signed in. */
export async function me(browser: Browser): Promise<MeResponse | null> {
  const response = await browser.fetch("/api/me");
  if (response.status === 401) return null;
  expect(response.status).toBe(200);
  return meResponseSchema.parse(await response.json());
}

/**
 * For a test in which the app logs a warning: keeps it out of the test
 * output and returns what was logged.
 */
export function expectWarnings() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  return warn;
}

/** Puts `email` on the allowlist without going through the API. */
export async function invite(
  { db, clock }: Pick<TestSetup, "db" | "clock">,
  email: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  await db.insert(allowedEmails).values({ email, role, createdAt: clock.time });
}
