import type { Fetch } from "@pigy/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./errors.ts";
import { httpsUrl, retryAfter, send, sendFollowing } from "./http.ts";

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

  it("takes the beginning of a body that is longer than allowed, where it is asked to", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        // "é" is two bytes: 30 of them in a chunk of 60.
        controller.enqueue(new TextEncoder().encode("é".repeat(30)));
      },
    });
    const answer = await send(
      // The length that it names is no reason to refuse it either.
      async () =>
        new Response(endless, { headers: { "Content-Length": "1000000" } }),
      "mastodon.example",
      url,
      {},
      { timeoutMs: 1000, maxBytes: 99, partial: true },
    );
    // 99 bytes are 49 letters and half of one, which is left out and not
    // handed over as a broken character.
    expect(answer.text).toBe("é".repeat(49));
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

  it("passes on what is not a failure of the network", async () => {
    // What a `fetch` that is not the runtime's own can fail with: the one
    // of a sandbox refuses a world that is another workspace's.
    const refusal = new Error("This world is another workspace's");
    const thrown = await send(
      async () => {
        throw refusal;
      },
      "mastodon.example",
      url,
      {},
      limits,
    ).catch((error: unknown) => error);
    // Not a `retry` that says the host could not be reached: that would
    // send a caller off to try again, and nobody would hear of the refusal.
    expect(thrown).toBe(refusal);
  });

  it("asks to try again when the answer breaks off", async () => {
    const cause = new Error("Network connection lost.");
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(cause);
      },
    });
    const error = await failure(() =>
      send(
        async () => new Response(broken),
        "mastodon.example",
        url,
        {},
        limits,
      ),
    );
    // Whatever the reading of a body fails with: only the network makes it
    // fail.
    expect(error).toMatchObject({ kind: "retry", cause });
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

describe("the time that a request is given", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A timer that runs on keeps whatever made the request in memory until
  // it is up: the object of a workspace, for half a minute after every
  // access that it renews.
  it("leaves no timer behind when the request is over, however it ended", async () => {
    vi.useFakeTimers();
    const answered: Fetch = async () => Response.json({});
    const unreachable: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const broken: Fetch = async () => {
      throw new Error("A bug");
    };

    await send(answered, "mastodon.example", url, {}, limits);
    expect(vi.getTimerCount()).toBe(0);

    await failure(() => send(unreachable, "mastodon.example", url, {}, limits));
    expect(vi.getTimerCount()).toBe(0);

    await expect(
      send(broken, "mastodon.example", url, {}, limits),
    ).rejects.toThrow("A bug");
    expect(vi.getTimerCount()).toBe(0);

    await sendFollowing(answered, url, {}, limits, 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a timer while the request is under way: what the test above counts", async () => {
    vi.useFakeTimers();
    let during = -1;
    await send(
      async () => {
        during = vi.getTimerCount();
        return Response.json({});
      },
      "mastodon.example",
      url,
      {},
      limits,
    );
    expect(during).toBe(1);
  });
});

describe("sendFollowing", () => {
  const file = "https://ada.example.com/.well-known/atproto-did";
  const did = () =>
    new Response("did:plc:ada", { headers: { "Content-Type": "text/plain" } });
  const redirect =
    (location: string | undefined, status = 302) =>
    () =>
      new Response(null, {
        status,
        headers: location === undefined ? {} : { Location: location },
      });

  /**
   * A `fetch` that answers each address with what `answers` has for it,
   * after `delayMs`, and the addresses that it was asked for, in order.
   */
  function server(answers: Record<string, () => Response>, delayMs = 0) {
    const asked: string[] = [];
    const fetch: Fetch = (input, init) => {
      const url = String(input);
      asked.push(url);
      const answer = answers[url];
      if (!answer) return Promise.reject(new TypeError(`No host: ${url}`));
      // Answers when its time comes, or fails when the request is called
      // off first, as fetch does.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer()), delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    };
    return { fetch, asked };
  }

  /** A way of `length` redirects from `file`, and the answer at its end. */
  function way(length: number) {
    const hops = Array.from(
      { length },
      (_, hop) => `https://hop${hop}.example.com/did`,
    );
    const answers: Record<string, () => Response> = {};
    [file, ...hops].forEach((url, index) => {
      const next = hops[index];
      answers[url] = next === undefined ? did : redirect(next);
    });
    return { hops, answers };
  }

  const follow = (fetch: Fetch, hops = 5, timeoutMs = limits.timeoutMs) =>
    sendFollowing(fetch, file, {}, { ...limits, timeoutMs }, hops);

  it("follows a redirect to an address relative to the one that it was sent to", async () => {
    const { fetch, asked } = server({
      [file]: redirect("/ada/did", 301),
      "https://ada.example.com/ada/did": did,
    });
    const answer = await follow(fetch);
    expect(answer).toMatchObject({ status: 200, text: "did:plc:ada" });
    expect(asked).toEqual([file, "https://ada.example.com/ada/did"]);
  });

  it("refuses a redirect that does not say where to", async () => {
    const { fetch } = server({ [file]: redirect(undefined) });
    const error = await failure(() => follow(fetch));
    expect(error).toMatchObject({ kind: "fail", status: 302 });
    expect(error.message).toBe(
      "ada.example.com sends pigy on to an address that it does not follow.",
    );
  });

  it("takes an answer with the status 0 for a redirect that it cannot follow", async () => {
    // What the fetch of a browser answers a redirect with when it was told
    // not to follow it: an opaque redirect, with the status 0 and no
    // headers, so not where it leads. A Response cannot be made with that
    // status, so the test makes what fetch would hand over.
    const opaque = () =>
      ({ status: 0, headers: new Headers(), body: null }) as Response;
    const { fetch } = server({ [file]: opaque });
    expect(await failure(() => follow(fetch))).toMatchObject({
      kind: "fail",
      status: 0,
    });
  });

  it("follows a redirect only to an address that pigy may ask", async () => {
    for (const location of [
      "http://ada.example.com/did",
      "https://ada.example.com:8443/did",
      "https://user:secret@ada.example.com/did",
      "https://localhost/did",
      "https://ada.internal/did",
      "https://10.0.0.5/did",
      "https://[::1]/did",
    ]) {
      // Each would answer, if it were asked.
      const { fetch, asked } = server({
        [file]: redirect(location),
        [location]: did,
        [new URL(location).href]: did,
      });
      const error = await failure(() => follow(fetch));
      expect(error, location).toMatchObject({ kind: "fail", status: 302 });
      expect(asked, location).toEqual([file]);
    }
  });

  it("follows as many redirects as it is told, and not one more", async () => {
    const five = way(5);
    const followed = server(five.answers);
    expect(await follow(followed.fetch, 5)).toMatchObject({
      status: 200,
      text: "did:plc:ada",
    });
    expect(followed.asked).toEqual([file, ...five.hops]);

    const six = way(6);
    const refused = server(six.answers);
    const error = await failure(() => follow(refused.fetch, 5));
    expect(error).toMatchObject({ kind: "fail", status: 302 });
    expect(error.message).toBe(
      "hop4.example.com sends pigy on to an address that it does not follow.",
    );
    // The sixth address is where the fifth sends pigy on to. It is never
    // asked.
    expect(refused.asked).toEqual([file, ...six.hops.slice(0, 5)]);
  });

  it("gives the whole way the time that the limits name, and not each address on it", async () => {
    // Every address answers in 20 milliseconds, well within the 50 that
    // are allowed, and the six of them take 120.
    const { fetch, asked } = server(way(5).answers, 20);
    const error = await failure(() => follow(fetch, 5, 50));
    expect(error.kind).toBe("retry");
    expect(asked.length).toBeLessThan(6);
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
