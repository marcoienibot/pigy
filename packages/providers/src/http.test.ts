import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import { httpsUrl, retryAfter, send } from "./http.ts";

const limits = { timeoutMs: 1000, maxBytes: 100 };
const url = "https://mastodon.example/api";

/** The ProviderError that `action` fails with. */
async function failure(action: () => Promise<unknown>) {
  const error = await action().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error instanceof ProviderError) return error;
  throw new Error(`Expected a ProviderError, got ${String(error)}`);
}

describe("send", () => {
  it("returns the answer whatever its status, with its JSON", async () => {
    const answer = await send(
      async () => Response.json({ error: "No" }, { status: 422 }),
      "mastodon.example",
      url,
      {},
      limits,
    );
    expect(answer).toMatchObject({ status: 422, json: { error: "No" } });
  });

  it("has no JSON for an answer that is none", async () => {
    const answer = await send(
      async () => new Response("<h1>Down</h1>", { status: 503 }),
      "mastodon.example",
      url,
      {},
      limits,
    );
    expect(answer).toMatchObject({ status: 503, json: undefined });
  });

  it("does not follow redirects, and refuses one", async () => {
    let redirect: RequestRedirect | undefined;
    const error = await failure(() =>
      send(
        async (_input, init) => {
          redirect = init?.redirect;
          return new Response(null, {
            status: 302,
            headers: { Location: "https://elsewhere.example/" },
          });
        },
        "mastodon.example",
        url,
        { headers: { Authorization: "Bearer token" } },
        limits,
      ),
    );
    // A redirect that was followed would carry the token along.
    expect(redirect).toBe("manual");
    expect(error).toMatchObject({ kind: "fail", status: 302 });
  });

  it("stops reading a body that is longer than allowed", async () => {
    let pulled = 0;
    // A body without a length, which never ends.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(60));
      },
    });
    const error = await failure(() =>
      send(
        async () => new Response(endless),
        "mastodon.example",
        url,
        {},
        limits,
      ),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toContain("more than pigy is willing to read");
    // 100 bytes are allowed, in chunks of 60: the second chunk is over. A
    // stream may be asked for a chunk ahead of the reading.
    expect(pulled).toBeLessThanOrEqual(3);
  });

  it("does not read a body that says it is too long", async () => {
    const error = await failure(() =>
      send(
        async () =>
          new Response("x".repeat(10), {
            headers: { "Content-Length": "101" },
          }),
        "mastodon.example",
        url,
        {},
        limits,
      ),
    );
    expect(error.kind).toBe("fail");
  });

  it("reads a body of exactly the allowed length", async () => {
    const body = JSON.stringify("x".repeat(98));
    const answer = await send(
      async () => new Response(body),
      "mastodon.example",
      url,
      {},
      limits,
    );
    expect(answer.json).toBe("x".repeat(98));
  });

  it("asks to try again when the host cannot be reached", async () => {
    const cause = new TypeError("fetch failed");
    const error = await failure(() =>
      send(
        async () => {
          throw cause;
        },
        "mastodon.example",
        url,
        {},
        limits,
      ),
    );
    expect(error).toMatchObject({ kind: "retry", cause });
    expect(error.message).toBe("mastodon.example could not be reached.");
  });

  it("gives up on a host that takes too long", async () => {
    const error = await failure(() =>
      send(
        // Answers only when the request is called off, as fetch does.
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
        "mastodon.example",
        url,
        {},
        // The one test that waits for real, and not for long.
        { ...limits, timeoutMs: 20 },
      ),
    );
    expect(error.kind).toBe("retry");
  });
});

describe("retryAfter", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  const header = (value: string) =>
    retryAfter(new Headers({ "Retry-After": value }), now);

  it("reads a number of seconds", () => {
    expect(header("120")).toEqual(new Date("2026-11-15T10:02:00Z"));
  });

  it("reads a date", () => {
    expect(header("Sun, 15 Nov 2026 10:30:00 GMT")).toEqual(
      new Date("2026-11-15T10:30:00Z"),
    );
  });

  it("is undefined without the header, or with one it cannot read", () => {
    expect(retryAfter(new Headers(), now)).toBeUndefined();
    expect(header("soon")).toBeUndefined();
  });
});

describe("httpsUrl", () => {
  it("lets an HTTPS address through, and nothing else", () => {
    expect(httpsUrl("https://mastodon.example/@ada")).toBe(
      "https://mastodon.example/@ada",
    );
    // What must never end up in a link or an image of a page.
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("http://mastodon.example/@ada")).toBeNull();
    expect(httpsUrl("data:text/html,<script>")).toBeNull();
    expect(httpsUrl("/relative")).toBeNull();
    expect(httpsUrl(null)).toBeNull();
    expect(httpsUrl(42)).toBeNull();
  });
});
