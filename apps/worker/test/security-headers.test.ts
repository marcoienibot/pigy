import { sandboxMastodonDomain } from "@pigy/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  dataPolicy,
  pagePolicy,
  securityHeaders,
} from "../src/security-headers.ts";
import { consentUrl, pathOf } from "./channels.ts";
import { adminEmail, expectErrors, setup, signedIn } from "./helpers.ts";
import { workspaceIds } from "./sync-client.ts";

/** The source that allows exactly `text`, made as a browser makes it. */
async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** The headers that every answer of the Worker has, whatever it is. */
function expectCommonHeaders(response: Response) {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
    "same-origin",
  );
  expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
}

describe("an answer of the API", () => {
  it("allows a browser nothing, and asks for HTTPS at a deployed address", async () => {
    const response = await setup().browser().fetch("/api/health");

    expect(response.status).toBe(200);
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toBe(dataPolicy);
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    // What the route says of itself is still there.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("says nothing of HTTPS at a local address", async () => {
    // Over HTTP a browser ignores the header. At https://localhost it
    // would keep it, for every other project on the machine.
    for (const origin of ["http://localhost:5173", "https://localhost:5173"]) {
      const response = await setup().browser(origin).fetch("/api/health");

      expectCommonHeaders(response);
      expect(response.headers.has("Strict-Transport-Security")).toBe(false);
    }
  });

  it.each([
    ["a path that nothing answers at", "/api/nope", 404],
    ["a path of no route at all", "/sync", 404],
    ["a request of nobody who is signed in", "/api/workspaces", 401],
    // The Worker's own answer, where a file of the web app is passed on
    // with the headers that Cloudflare gave it: assets.test.ts.
    ["a file of the web app that is not there", "/assets/index-old.js", 404],
  ])("has its headers when it is an error: %s", async (_, path, status) => {
    const response = await setup().browser().fetch(path);

    expect(response.status).toBe(status);
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toBe(dataPolicy);
  });

  it("has its headers when a route throws", async () => {
    const errors = expectErrors();
    // The health route with a binding that throws, as in error.test.ts:
    // the answer is made by the error handler of the app.
    const broken = {
      VERSION: {
        get id(): string {
          throw new Error("The version is gone");
        },
      },
    };

    const response = await worker.request("/api/health", {}, broken);

    expect(response.status).toBe(500);
    expect(errors).toHaveBeenCalledOnce();
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toBe(dataPolicy);
  });

  it("has its headers when it is a redirect", async () => {
    const response = await setup().browser().fetch("/api/auth/google/start");

    // To Google, to sign in.
    expect(response.status).toBe(302);
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toBe(dataPolicy);
  });
});

describe("a page of a simulated network", () => {
  it("may show its own style sheet and send its form to pigy, and nothing else", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);
    const url = await consentUrl(browser, sandbox, sandboxMastodonDomain);

    const response = await browser.fetch(pathOf(url));

    expect(response.status).toBe(200);
    const html = await response.text();
    // The page arrives whole: the policy is made of its text.
    expect(html).toContain("</html>");
    const sheet = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    if (!sheet) throw new Error("The consent page has no style sheet");
    // The hash of the style sheet as it is in the page that was answered:
    // a browser computes the same and shows the page with its styles.
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; style-src ${await hashOf(sheet)}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    expectCommonHeaders(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("has the same policy as a page of the simulated Google", async () => {
    const test = setup({
      simulatedGoogle: true,
      env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined },
    });
    const browser = test.browser("http://localhost:5173");
    const start = await browser.fetch("/api/auth/google/start");
    const consent = start.headers.get("Location");
    if (!consent) throw new Error("Sign-in did not begin");

    const response = await browser.fetch(pathOf(consent));

    expect(response.headers.get("Content-Type")).toContain("text/html");
    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toMatch(
      /^default-src 'none'; style-src 'sha256-[^']+'; form-action 'self'; /,
    );
  });
});

describe("the policy of a page", () => {
  const page = (head: string, body: string) =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it("allows the style sheets of the head, each as it is written", async () => {
    const policy = await pagePolicy(
      page(
        "<style>a { color: red; }</style><style media=print>b{}</style>",
        "",
      ),
    );

    expect(policy).toBe(
      `default-src 'none'; style-src ${await hashOf("a { color: red; }")} ${await hashOf("b{}")}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
  });

  it("allows no style sheet that is further down, where a page shows what others wrote", async () => {
    const injected = "body { display: none; }";

    const policy = await pagePolicy(
      page("<style>a{}</style>", `<p>Hello</p><style>${injected}</style>`),
    );

    expect(policy).toContain(await hashOf("a{}"));
    expect(policy).not.toContain(await hashOf(injected));
  });

  it("allows no style sheet at all to a page whose head has no end", async () => {
    // Without "</head>" nothing says where the page's own markup ends and
    // what it shows of others begins: the whole of it would be taken for
    // the head, and every style sheet in it allowed.
    const injected = "body { display: none; }";

    const policy = await pagePolicy(
      `<!doctype html><title>pigy</title><style>a{}</style><p>Hello</p><style>${injected}</style>`,
    );

    expect(policy).toBe(
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("allows no style at all to a page that has none, and never a script", async () => {
    const policy = await pagePolicy(
      page("<script>alert(1)</script>", "<p>Hello</p>"),
    );

    // Without `style-src` and `script-src`, `default-src 'none'` decides.
    expect(policy).toBe(
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });
});

describe("an answer that is HTML and has no body", () => {
  it.each([
    ["has nothing to say", 204],
    ["says that the browser has it already", 304],
    ["has a body that is not there", 200],
  ])("has its headers when it %s", async (_, status) => {
    const app = new Hono();
    app.use(securityHeaders());
    // What a route may answer with: a status that has no body, with the
    // type of a page all the same.
    app.get(
      "/",
      () =>
        new Response(null, {
          status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    );

    const response = await app.request("https://pigy.test/");

    // As it was answered, and not an error of the middleware, which would
    // read a body that is not there and make one for a status that has
    // none.
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    // The header is the policy, whatever the answer holds: it allows
    // nothing.
    expect(response.headers.get("Content-Security-Policy")).toBe(dataPolicy);
    expectCommonHeaders(response);
  });
});

describe("a route that says its own policy", () => {
  it("keeps it, and gets the other headers", async () => {
    const own = "default-src 'none'; script-src 'self'";
    const app = new Hono();
    app.use(securityHeaders());
    app.get("/docs", (c) => {
      c.header("Content-Security-Policy", own);
      return c.html("<!doctype html><head><style>a{}</style></head>");
    });

    const response = await app.request("https://pigy.test/docs");

    expect(response.headers.get("Content-Security-Policy")).toBe(own);
    expectCommonHeaders(response);
    expect(await response.text()).toContain("<style>a{}</style>");
  });
});
