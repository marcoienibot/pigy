import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Fetch, type MeResponse, meResponseSchema } from "@pigy/core";
import { createBlueskySimulator } from "@pigy/simulators/bluesky";
import { createGoogleSimulator } from "@pigy/simulators/google";
import { createLinkedInSimulator } from "@pigy/simulators/linkedin";
import { createMastodonSimulator } from "@pigy/simulators/mastodon";
import { createPushSimulator } from "@pigy/simulators/push";
import { createThreadsSimulator } from "@pigy/simulators/threads";
import { createWebSimulator } from "@pigy/simulators/web";
import { createWorld } from "@pigy/simulators/world";
import { drizzle } from "drizzle-orm/d1";
import { expect, onTestFinished, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { allowedEmails } from "../src/db/schema.ts";
import {
  developmentBlueskyClientKeys,
  developmentCredentialKeys,
  developmentVapidKey,
} from "../src/development-keys.ts";
import type { Bindings } from "../src/env.ts";
import { createSimulatedGoogle } from "../src/simulated-google.ts";
import { clock, deployment } from "./clock.ts";

const origin = "https://pigy.test";
export const adminEmail = "admin@example.com";

const googleClient = {
  clientId: "pigy-test.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUris: [`${origin}/api/auth/google/callback`],
};

type Secrets =
  | "ADMIN_EMAILS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "CREDENTIAL_KEYS"
  | "BLUESKY_CLIENT_KEYS"
  | "LINKEDIN_CLIENT_ID"
  | "LINKEDIN_CLIENT_SECRET"
  | "THREADS_APP_ID"
  | "THREADS_APP_SECRET"
  | "VAPID_PRIVATE_KEY";

/**
 * A key for `CREDENTIAL_KEYS`, as a deployment has one: 32 bytes in
 * base64. `fill` makes it another key.
 */
export function credentialKey(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}

/** What the tests are deployed with, unless they say otherwise. */
export const credentialKeys = `1:${credentialKey(1)}`;

/**
 * The key that pigy signs with as a client of Bluesky in the tests, as a
 * deployment has one: a private key of P-256 in PKCS #8, in base64.
 */
export const blueskyClientKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLKTOP/n55STmTVUO6OHIiB6tk/s5+qnJQd2wtiLBq7ChRANCAARCS0Vke+s9u6zO22Dlw7lXDGhSwhaYfBdSYOMPykLs0B96UK5egNuaG2d78w+ETNIDlUWj9z6uOicvqcDaHh9R";

/** `BLUESKY_CLIENT_KEYS` of the tests, unless they say otherwise. */
export const blueskyClientKeys = `1:${blueskyClientKey}`;

/**
 * The key that pigy signs with as a sender of push messages in the tests
 * of those, as a deployment has one: a private key of P-256 in PKCS #8, in
 * base64. A test that is about push messages deploys it, with
 * `env: { VAPID_PRIVATE_KEY: vapidPrivateKey }`. The others run a pigy
 * without it, which sends nothing: the object of a workspace then has no
 * sending under way when a test ends.
 */
export const vapidPrivateKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgn8HzfFdn06Yd3luCfXg9Ga1rCTCA9KOaxpoY5xPod42hRANCAAQmPpw9nlZ77zULmYeBMmM5plB0FAk1DHUFr5FqDRsAxP7KpU7q7Mc7mLN/LlB8+bHH4maHxjuzTuYh03lS25WL";

/**
 * The Mastodon server that stands for a real one in the tests. It is in a
 * world of its own, behind the `fetch` that the app is given, which is
 * where the internet is in production. Its name is not that of the
 * simulated server of a sandbox, so that a test can tell which of the two
 * has answered.
 */
export const realMastodonDomain = "mastodon.test";

/**
 * The Bluesky account that stands for a real one, on a PDS of its own.
 * Bluesky's other hosts are the real ones, in a sandbox as here: its
 * accounts and its PDS have other names.
 */
export const realBlueskyHandle = "rosalind.bsky.test";
export const realBlueskyPds = "morel.host.bsky.test";

/** A file of the web app, as a build names one after its content. */
export const builtFile = "/assets/index-Dd-RQqH9.js";

/** What Cloudflare sends with `builtFile`: the rules of `_headers`. */
export const builtFileHeaders = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=31536000, immutable",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'",
  "X-Content-Type-Options": "nosniff",
};

/**
 * The files of the web app, as the binding `ASSETS` answers for them: the
 * tests run the Worker without a build. It has one file. Every other path
 * gets the app shell with the status 200, which is what Cloudflare does
 * with `not_found_handling` set to `single-page-application`, and with the
 * headers that `_headers` gives the path.
 */
const assets = {
  fetch: async (input: RequestInfo | URL) => {
    const { pathname } = new URL(urlOf(input));
    return pathname === builtFile
      ? new Response("export {};", { headers: builtFileHeaders })
      : new Response("<!doctype html><title>pigy</title>", {
          headers: {
            ...builtFileHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
  },
} as Fetcher;

// Google's addresses. The simulated Google has the last word on which of
// them exist.
const googleHost = /(^|\.)(google\.com|googleapis\.com)$/;

/**
 * The app as it runs in production, with Google credentials and a key for
 * the credentials of the channels, except that the `fetch` it is given
 * leads to a simulated Google and to `network`, which stands for the real
 * networks, and that its clock is `clock`, which is also the clock of the
 * Durable Objects. The bindings are listed one by one, so that nothing from
 * a `.dev.vars` on this machine gets into the tests.
 */
export function setup(
  options: {
    /** Replaces the secrets of the same name. Undefined leaves one unset. */
    env?: { [Name in Secrets]?: string | undefined };
    /** Builds in a simulated Google, as in development. */
    simulatedGoogle?: boolean;
    /** Builds in the development keys, as in development. */
    developmentCredentialKeys?: boolean;
    /** Stands between the app and Google, to change what Google answers. */
    intercept?: (google: Fetch) => Fetch;
    /** The same between the app and the networks. */
    interceptNetwork?: (network: Fetch) => Fetch;
    /** The same between the app and the push services of the browsers. */
    interceptPush?: (push: Fetch) => Fetch;
    /**
     * Counts the requests of the keys of the public API in place of the
     * limiter of the local runtime, for a test that is about the limit.
     */
    rateLimiter?: RateLimit;
    /**
     * Counts the reports of the content security policy that a client
     * sends, in place of the limiter of the local runtime.
     */
    policyReportLimiter?: RateLimit;
    /** The same for the reports of all clients together. */
    policyReportTotalLimiter?: RateLimit;
  } = {},
) {
  clock.time = new Date("2026-11-14T10:00:00Z");
  clock.googleLagMs = 0;
  const now = () => clock.time;
  const google = createGoogleSimulator({
    now: () => new Date(clock.time.getTime() - clock.googleLagMs),
    client: googleClient,
  });
  const googleFetch = options.intercept?.(google.fetch) ?? google.fetch;

  // What stands for the real networks: one Mastodon server with one
  // account, Bluesky with one account, and a record of every request that
  // the app made to a network.
  const world = createWorld({ now });
  const mastodon = createMastodonSimulator(world);
  mastodon.addInstance(realMastodonDomain);
  const bluesky = createBlueskySimulator(world, {
    // What Bluesky reads at the address of a client: here, what the app
    // serves there, as it would be read from the internet.
    clients: async (clientId) => {
      const response = await app.request(
        clientId,
        undefined,
        bindings,
        executionContext(),
      );
      return response.ok ? response.json() : undefined;
    },
  });
  bluesky.addPds(realBlueskyPds);
  const linkedin = createLinkedInSimulator(world);
  // The application that whoever runs this pigy has made at LinkedIn, with
  // the callback address of the app of the tests.
  const linkedinClient = linkedin.addClient({
    name: "pigy",
    redirectUris: [`${origin}/connect/linkedin/callback`],
  });
  const threads = createThreadsSimulator(world);
  // The same for Threads: the app that whoever runs this pigy has made at
  // Meta.
  const threadsApp = threads.addApp({
    name: "pigy",
    redirectUris: [`${origin}/connect/threads/callback`],
  });
  const network = {
    world,
    mastodon,
    account: mastodon.addAccount(
      realMastodonDomain,
      "rosalind",
      "Rosalind Franklin",
    ),
    bluesky,
    blueskyAccount: bluesky.addAccount({
      handle: realBlueskyHandle,
      pds: realBlueskyPds,
      name: "Rosalind Franklin",
    }),
    linkedin,
    linkedinClient,
    linkedinMember: linkedin.addMember("Rosalind Franklin"),
    threads,
    threadsApp,
    threadsUser: threads.addUser({
      username: "rosalind",
      name: "Rosalind Franklin",
    }),
    /** The requests that left the app for a network, as "METHOD address". */
    requests: [] as string[],
  };
  // Each network answers on its own hosts, as on the internet.
  const networks: Fetch = (input, init) => {
    const { host } = new URL(urlOf(input));
    // The web is among them: the pages that the links of a post lead
    // to, which here are those of the simulated web.
    const owner = [bluesky, linkedin, threads, createWebSimulator()].find(
      (simulator) => simulator.owns(host),
    );
    return (owner ?? mastodon).fetch(input, init);
  };
  const networkFetch = options.interceptNetwork?.(networks) ?? networks;
  // The push services of the browsers, with the devices that a test makes
  // up, and every request that the app sent them.
  const push = Object.assign(createPushSimulator({ now }), {
    /** The requests that left the app for a push service. */
    requests: [] as { url: string; headers: Headers }[],
  });
  const pushFetch = options.interceptPush?.(push.fetch) ?? push.fetch;

  const appFetch: Fetch = async (input, init) => {
    const url = urlOf(input);
    // Before Google: the push service of Chrome is at a host of Google's.
    if (push.owns(new URL(url).host)) {
      push.requests.push({ url, headers: new Headers(init?.headers) });
      return pushFetch(input, init);
    }
    if (googleHost.test(new URL(url).hostname)) {
      return googleFetch(input, init);
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    network.requests.push(`${method} ${url}`);
    return networkFetch(input, init);
  };
  const app = createApp({
    fetch: appFetch,
    now,
    simulatedGoogle: options.simulatedGoogle
      ? createSimulatedGoogle(now)
      : undefined,
    developmentCredentialKeys: options.developmentCredentialKeys
      ? developmentCredentialKeys
      : undefined,
    developmentBlueskyClientKeys: options.developmentCredentialKeys
      ? developmentBlueskyClientKeys
      : undefined,
    developmentVapidKey: options.developmentCredentialKeys
      ? developmentVapidKey
      : undefined,
    // The simulated push service of the build for the end-to-end tests
    // is not what the tests here go through: theirs is behind `fetch`.
    simulatedPush: undefined,
  });
  const secrets = {
    ADMIN_EMAILS: adminEmail,
    GOOGLE_CLIENT_ID: googleClient.clientId,
    GOOGLE_CLIENT_SECRET: googleClient.clientSecret,
    CREDENTIAL_KEYS: credentialKeys,
    BLUESKY_CLIENT_KEYS: blueskyClientKeys,
    LINKEDIN_CLIENT_ID: linkedinClient.clientId,
    LINKEDIN_CLIENT_SECRET: linkedinClient.clientSecret,
    THREADS_APP_ID: threadsApp.appId,
    THREADS_APP_SECRET: threadsApp.appSecret,
    ...options.env,
  };
  const bindings: Bindings = {
    DB: env.DB,
    VERSION: env.VERSION,
    WORKSPACE: env.WORKSPACE,
    SIM_WORLD: env.SIM_WORLD,
    PUBLISH: env.PUBLISH,
    API_RATE_LIMITER: options.rateLimiter ?? env.API_RATE_LIMITER,
    POLICY_REPORT_LIMITER:
      options.policyReportLimiter ?? env.POLICY_REPORT_LIMITER,
    POLICY_REPORT_TOTAL_LIMITER:
      options.policyReportTotalLimiter ?? env.POLICY_REPORT_TOTAL_LIMITER,
    ASSETS: assets,
    MEDIA: env.MEDIA,
    IMAGES: env.IMAGES,
  };
  // The publishing workflow is not built here: the runtime constructs it.
  // It reads what this app was built and deployed with from `deployment`.
  deployment.fetch = appFetch;
  deployment.secrets = {};
  deployment.providerOf = undefined;
  deployment.pauses = [];
  const configure = (values: { [Name in Secrets]?: string | undefined }) => {
    for (const name of Object.keys(values) as Secrets[]) {
      const value = values[name];
      if (value === undefined) {
        delete bindings[name];
        delete deployment.secrets[name];
      } else {
        bindings[name] = value;
        deployment.secrets[name] = value;
      }
    }
  };
  configure(secrets);
  // What the app has handed to `waitUntil`, in any of its requests.
  const keptAlive: Promise<unknown>[] = [];
  /**
   * The execution context of a request, as the runtime gives every request
   * one. It notes what the app asks to be kept going.
   */
  const executionContext = () => {
    const context = createExecutionContext();
    const waitUntil = context.waitUntil.bind(context);
    context.waitUntil = (promise) => {
      keptAlive.push(promise);
      waitUntil(promise);
    };
    return context;
  };
  return {
    clock,
    google,
    network,
    /**
     * What stands for the push services of the browsers: `subscribe`
     * makes up a device, and `received` is what it got, decrypted.
     */
    push,
    db: drizzle(env.DB),
    /**
     * The work that the app has asked the runtime to keep going, with
     * `waitUntil`. It is all that goes on of a request once its client is
     * gone. In a test everything goes on, so a test that is about a client
     * that left waits for this and for nothing else of the request.
     */
    keptAlive,
    /**
     * Gives the app other secrets from the next request on, as a new
     * deployment does: its data stays. Undefined takes a secret away.
     */
    redeploy: configure,
    /** A browser with no cookies yet. */
    browser: (browserOrigin = origin) =>
      new Browser(
        (request) =>
          app.request(request, undefined, bindings, executionContext()),
        browserOrigin,
      ),
    /**
     * Moves the clock of the app, of the Durable Objects, of Google and of
     * the networks forward.
     */
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
   * Sends a request to the app. Redirects are not followed. `form` is what
   * a form of a page posts. `headers` replace what a browser would send, to
   * imitate other clients: a null leaves a header out.
   */
  async fetch(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      form?: Record<string, string>;
      /** Bytes, as the chunk of an upload is sent. */
      body?: Uint8Array;
      headers?: Record<string, string | null>;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.form ? "POST" : "GET");
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
    if (init.body) {
      headers.set("Content-Type", "application/octet-stream");
      headers.set("Content-Length", String(init.body.length));
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
        ...(init.form && { body: new URLSearchParams(init.form) }),
        ...(init.body && { body: init.body as Uint8Array<ArrayBuffer> }),
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

  /**
   * Starts the handshake of a WebSocket the way a browser does: with the
   * cookies and with `Origin`. The answer has the socket if the app took
   * it. `headers` are as for `fetch`.
   */
  webSocket(
    path: string,
    headers: Record<string, string | null> = {},
  ): Promise<Response> {
    return this.fetch(path, {
      headers: { Upgrade: "websocket", Origin: this.origin, ...headers },
    });
  }
}

/** The address that a call of `fetch` is for. */
export function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
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

/**
 * Signs in through the pages of the simulated Google, as a person does
 * where sign-in is simulated: `setup({ simulatedGoogle: true })` without
 * Google credentials, reached at a local address.
 */
export async function signInThroughPages(
  browser: Browser,
  email: string,
): Promise<Response> {
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

/** The same for a test in which the app logs an error. */
export function expectErrors() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  return error;
}

/** A line of the log, read back: src/log.ts writes them. */
export type LogEntry = {
  level: "warn" | "error";
  kind: string;
  message: string;
  error?: { name: string; message: string; [field: string]: unknown };
  [field: string]: unknown;
};

type Spied = { mock: { calls: unknown[][] } };

/**
 * What the app logged at the level that `spy` is on, line by line. What
 * is no line of the app's log is left out: the runtime and the test
 * runner write to the same console.
 */
export function entriesOf(spy: Spied): LogEntry[] {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      const entry: unknown = JSON.parse(String(line));
      return typeof entry === "object" && entry !== null && "kind" in entry
        ? [entry as LogEntry]
        : [];
    } catch {
      return [];
    }
  });
}

/** The same, as what each line says in words. */
export function saidBy(spy: Spied): string[] {
  return entriesOf(spy).map(({ message }) => message);
}

/** Every text and number that `value`, read from a line of the log, holds. */
function leaves(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [String(value)];
  return Object.values(value).flatMap(leaves);
}

/**
 * What a log holds of `entry`, as text. Of a line of the app's log that is
 * every text in it, as it was before JSON escaped it: the message, the
 * fields, and of an error its message, its stack and the same of the
 * errors beneath it. Of an error that was logged as it is, that is what a
 * console prints: its stack, which begins with its message, whatever else
 * it carries, and the same of the errors beneath it.
 */
export function logged(entry: unknown): string {
  if (Array.isArray(entry)) return entry.map(logged).join("\n");
  if (typeof entry === "string") {
    try {
      return leaves(JSON.parse(entry)).join("\n");
    } catch {
      return entry;
    }
  }
  if (!(entry instanceof Error)) {
    // A log prints what a plain object holds, an error among it.
    return typeof entry === "object" &&
      entry !== null &&
      Object.getPrototypeOf(entry) === Object.prototype
      ? Object.values(entry).map(logged).join("\n")
      : String(entry);
  }
  return [
    entry.stack,
    JSON.stringify({ ...entry }),
    ...(entry instanceof AggregateError ? [logged(entry.errors)] : []),
    ...(entry.cause === undefined ? [] : [logged(entry.cause)]),
  ].join("\n");
}

/**
 * Makes the database fail every statement whose SQL `fails` picks out, as
 * a D1 in trouble does, until the function that is returned is called or
 * the test ends. The statements are as Drizzle writes them: `from
 * "session"`, `delete from "oauth_state"`. The values that a statement was
 * run with when it failed are added to `values`, for a test that claims
 * that they went nowhere.
 */
export function breakDatabase(
  fails: (sql: string) => boolean,
  values: unknown[] = [],
): () => void {
  const prepare = env.DB.prepare.bind(env.DB);
  const broken = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (fails(sql)) {
      // It fails when it is run, like a statement of D1, and not before:
      // the error that the app gets is then what Drizzle makes of it.
      statement.bind = (...bound) => {
        values.push(...bound);
        throw new Error("D1_ERROR: The database is in trouble");
      };
    }
    return statement;
  });
  const mend = () => broken.mockRestore();
  onTestFinished(mend);
  return mend;
}

/**
 * Has `meanwhile` overtake a request: when the app is about to run the
 * first statement of D1 that `at` picks out, `meanwhile` begins, and the
 * statement runs once it is over. For a request that something else
 * comes in the middle of, at a point of the test's choosing, such as an
 * admin who removes an address while a sign-in is on its way. With
 * `late`, the statement runs first, and only its answer waits for
 * `meanwhile`: an answer that arrives after what `meanwhile` did, which
 * it is older than. The statements of `meanwhile` are not picked out,
 * and neither is a statement of a batch. Returns what `meanwhile`
 * returned, once it has begun.
 */
export function overtake(
  at: (sql: string) => boolean,
  meanwhile: () => Promise<unknown>,
  { late = false }: { late?: boolean } = {},
): () => Promise<unknown> | undefined {
  const prepare = env.DB.prepare.bind(env.DB);
  let picked = false;
  let over: Promise<unknown> | undefined;
  const begin = () => {
    over ??= meanwhile();
    return over;
  };
  const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (picked || !at(sql)) return statement;
    picked = true;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      const bound = bind(...values) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      for (const method of ["all", "raw", "run", "first"]) {
        const run = bound[method]?.bind(bound);
        if (!run) continue;
        bound[method] = async (...args) => {
          if (!late) await begin();
          const answer = await run(...args);
          if (late) await begin();
          return answer;
        };
      }
      return bound as unknown as D1PreparedStatement;
    };
    return statement;
  });
  onTestFinished(() => spy.mockRestore());
  return () => over;
}

/** Puts `email` on the allowlist without going through the API. */
export async function invite(
  { db, clock }: Pick<TestSetup, "db" | "clock">,
  email: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  await db.insert(allowedEmails).values({ email, role, createdAt: clock.time });
}
