import type { Fetch } from "@pigy/core";
import { createWebSimulator, webImages } from "@pigy/simulators/web";
import { describe, expect, it } from "vitest";
import { type AssetLimits, AssetRefused, fetchAsset } from "./asset.ts";

const limits: AssetLimits = { timeoutMs: 5000, hops: 3, maxBytes: 1024 };

/**
 * A web of the test's own: what answers at each address, and every
 * address that was asked for, in order.
 */
function web(
  pages: Record<
    string,
    (request: Request, signal: AbortSignal | undefined) => Response
  >,
) {
  const asked: Request[] = [];
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    asked.push(request);
    const answer = pages[request.url];
    // What a `fetch` does for a host that is not there.
    if (!answer) throw new TypeError(`No such host: ${request.url}`);
    return answer(request, init?.signal ?? undefined);
  };
  return { fetch, asked, urls: () => asked.map(({ url }) => url) };
}

/** Fetches `url` and returns the bytes that were handed on, or the refusal. */
async function fetched(
  fetch: Fetch,
  url: string,
  options: { limits?: AssetLimits; ownHosts?: string[] } = {},
): Promise<Uint8Array | string> {
  const pieces: Uint8Array[] = [];
  try {
    const length = await fetchAsset(
      fetch,
      url,
      options.limits ?? limits,
      async (piece) => {
        pieces.push(piece);
      },
      { ownHosts: options.ownHosts ?? [] },
    );
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const piece of pieces) {
      bytes.set(piece, at);
      at += piece.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof AssetRefused) return error.message;
    throw error;
  }
}

const file = (body: BodyInit | null, init: ResponseInit = {}) =>
  new Response(body, init);

describe("fetchAsset", () => {
  it("hands on the bytes of a file, whatever type its answer names", async () => {
    const simulated = createWebSimulator();
    const image = await fetched(simulated.fetch, webImages.image, {
      limits: { ...limits, maxBytes: 1024 * 1024 },
    });
    expect(image).toBeInstanceOf(Uint8Array);
    // A PNG: the type is the bytes' to say, and not the answer's.
    expect([...(image as Uint8Array).subarray(1, 4)]).toEqual([
      0x50, 0x4e, 0x47,
    ]);
    const mislabelled = await fetched(simulated.fetch, webImages.mislabelled, {
      limits: { ...limits, maxBytes: 1024 * 1024 },
    });
    expect(mislabelled).toEqual(image);
  });

  it("asks without credentials, and follows an address that sends it on a few times, each to a public HTTPS address", async () => {
    const { fetch, asked, urls } = web({
      "https://short.example/x": () =>
        file(null, {
          status: 301,
          headers: { Location: "https://files.example/a.png" },
        }),
      "https://files.example/a.png": () => file("bytes"),
    });
    expect(await fetched(fetch, "https://short.example/x#part")).toEqual(
      new TextEncoder().encode("bytes"),
    );
    // Without what stands after "#", which is the browser's.
    expect(urls()).toEqual([
      "https://short.example/x",
      "https://files.example/a.png",
    ]);
    for (const request of asked) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("Cookie")).toBeNull();
      expect(request.headers.get("Authorization")).toBeNull();
    }
  });

  it.each([
    ["an address without HTTPS", "http://files.example/a.png"],
    ["an IP address", "https://192.168.1.10/a.png"],
    ["a host of a private network", "https://nas.local/a.png"],
    ["a name of one label", "https://intranet/a.png"],
    ["a port", "https://files.example:8443/a.png"],
    ["credentials", "https://user:secret@files.example/a.png"],
    ["what is no address", "a.png"],
  ])("asks nothing at %s", async (_name, url) => {
    const { fetch, asked } = web({});
    expect(await fetched(fetch, url)).toMatch(/address/);
    expect(asked).toHaveLength(0);
  });

  it("asks no host of pigy's own, at first or where an answer sends it on", async () => {
    const { fetch, urls } = web({
      "https://short.example/x": () =>
        file(null, {
          status: 302,
          headers: { Location: "https://pigy.example/api/x" },
        }),
    });
    const ownHosts = ["pigy.example"];
    expect(
      await fetched(fetch, "https://pigy.example/a.png", { ownHosts }),
    ).toMatch(/public host/);
    expect(
      await fetched(fetch, "https://short.example/x", { ownHosts }),
    ).toMatch(/does not follow/);
    expect(urls()).toEqual(["https://short.example/x"]);
  });

  it.each([
    ["a private address", "https://localhost/a.png"],
    ["an address without HTTPS", "http://files.example/a.png"],
    ["an IP address", "https://10.0.0.1/a.png"],
  ])("does not follow an answer that sends it on to %s", async (_name, to) => {
    const { fetch, urls } = web({
      "https://short.example/x": () =>
        file(null, { status: 302, headers: { Location: to } }),
    });
    expect(await fetched(fetch, "https://short.example/x")).toMatch(
      /does not follow/,
    );
    expect(urls()).toEqual(["https://short.example/x"]);
  });

  it("follows an address that sends it on so many times and no more", async () => {
    const { fetch, asked } = web(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, hop) => [
          `https://hop.example/${hop}`,
          () =>
            file(null, {
              status: 307,
              headers: { Location: `https://hop.example/${hop + 1}` },
            }),
        ]),
      ),
    );
    expect(await fetched(fetch, "https://hop.example/0")).toMatch(
      /3 times at most/,
    );
    expect(asked).toHaveLength(1 + limits.hops);
  });

  it.each([404, 403, 500, 204])(
    "takes no file of an answer with the status %i",
    async (status) => {
      const { fetch } = web({
        "https://files.example/a.png": () =>
          file(status === 204 ? null : "Not here", { status }),
      });
      expect(await fetched(fetch, "https://files.example/a.png")).toBe(
        `The address answered with the status ${status}, and not with a file.`,
      );
    },
  );

  it("takes no file that is empty", async () => {
    const { fetch } = web({ "https://files.example/a.png": () => file("") });
    expect(await fetched(fetch, "https://files.example/a.png")).toBe(
      "The address answered with no file.",
    );
  });

  it("reads nothing of a file whose answer says that it is too large", async () => {
    let asked = 0;
    let cancelled = false;
    const { fetch } = web({
      "https://files.example/a.png": () =>
        file(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              asked++;
              controller.enqueue(new Uint8Array(100));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Length": String(limits.maxBytes + 1) } },
        ),
    });
    expect(await fetched(fetch, "https://files.example/a.png")).toBe(
      "The file is larger than 0.0009765625 MiB.",
    );
    expect(cancelled).toBe(true);
    // A stream fills its buffer before anybody reads: that much is asked
    // of it, and nothing more.
    expect(asked).toBeLessThanOrEqual(2);
  });

  it("gives up on a file that goes on beyond the bytes it may have, whatever its answer says", async () => {
    let sent = 0;
    const handed: number[] = [];
    const { fetch } = web({
      "https://files.example/a.png": () =>
        file(
          new ReadableStream<Uint8Array>({
            // A body without an end: it gives for as long as it is asked.
            pull(controller) {
              sent += 300;
              controller.enqueue(new Uint8Array(300));
            },
          }),
          // A length that is a lie.
          { headers: { "Content-Length": "10" } },
        ),
    });
    const refused = await fetchAsset(
      fetch,
      "https://files.example/a.png",
      limits,
      async (piece) => {
        handed.push(piece.byteLength);
      },
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AssetRefused);
    // What was handed on is within the bytes, and so is about what was
    // asked of the body.
    expect(handed.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(
      limits.maxBytes,
    );
    expect(sent).toBeLessThan(limits.maxBytes + 4 * 300);
  });

  it("gives up on a file whose bytes never end in time", async () => {
    const { fetch } = web({
      "https://slow.example/a.png": (_request, signal) =>
        file(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              // Nothing more comes. A real body is ended by the signal of
              // its request, as this one is.
              signal?.addEventListener("abort", () =>
                controller.error(signal.reason),
              );
            },
          }),
        ),
    });
    const began = Date.now();
    expect(
      await fetched(fetch, "https://slow.example/a.png", {
        limits: { ...limits, timeoutMs: 50 },
      }),
    ).toBe("The image did not arrive within 0.05 seconds.");
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("gives up on a host that does not answer in time, and on one that cannot be reached", async () => {
    const silent: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    expect(
      await fetched(silent, "https://silent.example/a.png", {
        limits: { ...limits, timeoutMs: 50 },
      }),
    ).toBe("The image did not arrive within 0.05 seconds.");
    expect(await fetched(web({}).fetch, "https://gone.example/a.png")).toBe(
      "The address could not be reached.",
    );
  });

  it("says nothing of the address in what it refuses with", async () => {
    const { fetch } = web({
      "https://secret-host.example/private/token-123.png": () =>
        file("nope", { status: 404 }),
    });
    const message = await fetched(
      fetch,
      "https://secret-host.example/private/token-123.png",
    );
    expect(message).not.toMatch(/secret-host|token-123/);
  });

  it("passes on what is no failure of the other end, as it is", async () => {
    const broken: Fetch = async () => {
      throw new Error("A check of a simulated world");
    };
    await expect(
      fetched(broken, "https://files.example/a.png"),
    ).rejects.toThrow("A check of a simulated world");
    const { fetch } = web({ "https://files.example/a.png": () => file("x") });
    await expect(
      fetchAsset(fetch, "https://files.example/a.png", limits, async () => {
        throw new Error("The bucket failed");
      }),
    ).rejects.toThrow("The bucket failed");
  });
});
