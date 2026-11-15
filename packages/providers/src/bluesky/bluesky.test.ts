import type { Fetch } from "@pigy/core";
import {
  type BlueskySimulator,
  createBlueskySimulator,
} from "@pigy/simulators/bluesky";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { newClientKey } from "../../test/bluesky-keys.ts";
import { ProviderError } from "../errors.ts";
import type { Json, PublishProgress } from "../provider.ts";
import {
  type BlueskyClientKey,
  type BlueskyCredentials,
  blueskyScope,
  clientMetadata,
  createBlueskyProvider,
  parseHandle,
} from "./index.ts";

const origin = "https://pigy.example";
const redirectUri = `${origin}/connect/bluesky/callback`;
const clientId = `${origin}/connect/bluesky/client-metadata.json`;
const pds = "pds.bsky.test";

type Intercept = (request: Request, simulator: Fetch) => Promise<Response>;

/**
 * A world with an account on a PDS behind the entryway, and an adapter.
 * `intercept` stands between the adapter and the world, to answer in its
 * place what Bluesky would not.
 */
async function setup(
  options: {
    account?: Partial<Parameters<BlueskySimulator["addAccount"]>[0]>;
    keys?: BlueskyClientKey[];
  } = {},
) {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const keys = options.keys ?? [await newClientKey("key-1")];
  const published = { keys };
  const simulator = createBlueskySimulator(world, {
    // What pigy serves at its address, with the keys that it publishes.
    clients: (id) =>
      id === clientId
        ? clientMetadata({
            clientId,
            redirectUri,
            name: "pigy",
            keys: published.keys,
          })
        : undefined,
  });
  simulator.addPds(pds);
  const ada = simulator.addAccount({
    handle: "ada.bsky.test",
    pds,
    name: "Ada Lovelace",
    ...options.account,
  });
  let intercept: Intercept | undefined;
  const requests: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    return intercept
      ? intercept(request, simulator.fetch)
      : simulator.fetch(request);
  };
  const adapter = (with_: BlueskyClientKey[] = keys) =>
    createBlueskyProvider({
      fetch,
      now: world.now,
      clientIdFor: () => clientId,
      keys: with_,
    });
  return {
    world,
    simulator,
    ada,
    keys,
    published,
    provider: adapter(),
    adapter,
    requests,
    intercept: (next: Intercept | undefined) => {
      intercept = next;
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The error that `action` fails with, which must be a ProviderError. */
async function failure(action: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("Expected a ProviderError, and nothing failed");
}

/** Consents as `account` and returns what is sent to the callback. */
async function consented(test: Setup, identifier = "ada.bsky.test") {
  const start = await test.provider.beginConnect({ redirectUri, identifier });
  const callback = await answerConsent(test.simulator.fetch, start.url, {
    account: test.ada.id,
  });
  return { start, params: callback.searchParams };
}

/** Connects the account and returns its access. */
async function connected(test: Setup) {
  const { start, params } = await consented(test);
  return test.provider.completeConnect({ pending: start.pending, params });
}

/** Runs the steps of a post to the end, each once. */
async function publishAll(
  test: Setup,
  credentials: Json,
  texts: string[],
): Promise<PublishProgress[]> {
  const steps: PublishProgress[] = [];
  let progress: PublishProgress | null = null;
  while (!progress?.done) {
    progress = await test.provider.publishStep({
      credentials,
      content: { parts: texts.map((text) => ({ text })) },
      key: "target",
      progress,
    });
    steps.push(progress);
  }
  return steps;
}

describe("parseHandle", () => {
  it("takes a handle as people write it", () => {
    expect(parseHandle(" @Ada.Bsky.Social ")).toBe("ada.bsky.social");
    expect(parseHandle("ada.bsky.test")).toBe("ada.bsky.test");
  });

  it("refuses what is no handle, and names that atproto sets aside", () => {
    for (const typed of [
      "ada",
      "ada@bsky.social",
      "https://bsky.app/profile/ada.bsky.social",
      "-ada.bsky.social",
      "ada.bsky.123",
      "ada.example",
      "ada.invalid",
      "ada.localhost",
      `${"a".repeat(64)}.bsky.social`,
    ]) {
      expect(parseHandle(typed), typed).toBeNull();
    }
  });
});

describe("clientMetadata", () => {
  it("publishes the public halves of the keys, and what the adapter asks for", async () => {
    const keys = [await newClientKey("key-2"), await newClientKey("key-1")];
    const metadata = clientMetadata({
      clientId,
      redirectUri,
      name: "pigy",
      keys,
    });
    expect(metadata).toMatchObject({
      client_id: clientId,
      client_uri: origin,
      redirect_uris: [redirectUri],
      scope: blueskyScope,
      token_endpoint_auth_method: "private_key_jwt",
      dpop_bound_access_tokens: true,
    });
    expect(metadata.jwks.keys.map(({ kid }) => kid)).toEqual([
      "key-2",
      "key-1",
    ]);
    // A private half that is published is a key given away.
    expect(JSON.stringify(metadata)).not.toContain(keys[0]?.privateKey.d);
  });
});

describe("connecting", () => {
  it("finds an account whose handle says its DID in a file of its host", async () => {
    const test = await setup({ account: { resolution: "https" } });
    const { account } = await connected(test);
    expect(account.id).toBe(test.ada.id);
    // The DNS was asked first, and had nothing.
    expect(test.requests[0]).toMatch(/^GET https:\/\/cloudflare-dns\.com\//);
    expect(test.requests[1]).toBe(
      "GET https://ada.bsky.test/.well-known/atproto-did",
    );
  });

  it("finds an account of a did:web", async () => {
    const test = await setup({ account: { did: "web" } });
    const { account } = await connected(test);
    expect(account.id).toBe("did:web:ada.bsky.test");
  });

  it("connects an account whose PDS authorizes for itself", async () => {
    const test = await setup();
    test.simulator.addPds("self.test", { authorizes: true });
    const grace = test.simulator.addAccount({
      handle: "grace.self.test",
      pds: "self.test",
    });
    const start = await test.provider.beginConnect({
      redirectUri,
      identifier: "grace.self.test",
    });
    expect(new URL(start.url).host).toBe("self.test");
    const callback = await answerConsent(test.simulator.fetch, start.url, {
      account: grace.id,
    });
    const { account, access } = await test.provider.completeConnect({
      pending: start.pending,
      params: callback.searchParams,
    });
    expect(account).toMatchObject({ id: grace.id, handle: "@grace.self.test" });
    // The account's posts go to its own PDS.
    await publishAll(test, access.credentials, ["Hello"]);
    expect(feed(test.world).map(({ post }) => post.text)).toEqual(["Hello"]);
  });

  it("says who the account is, with the name of its profile, or its handle without one", async () => {
    const test = await setup();
    const { account } = await connected(test);
    expect(account).toEqual({
      id: test.ada.id,
      handle: "@ada.bsky.test",
      name: "Ada Lovelace",
      avatarUrl: null,
      profileUrl: `https://bsky.app/profile/${test.ada.id}`,
    });
    const newcomer = await setup({ account: { profile: false } });
    expect((await connected(newcomer)).account.name).toBe("ada.bsky.test");
  });

  it("refuses a handle that leads to no account, and keeps why for the caller", async () => {
    const test = await setup();
    const error = await failure(() =>
      test.provider.beginConnect({
        redirectUri,
        identifier: "nobody.bsky.test",
      }),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toMatch(/nobody\.bsky\.test/);
    // Neither the DNS nor the host had the handle. That the host could not
    // be reached is the cause, which a sandbox tells a person about.
    expect(error.cause).toBeInstanceOf(ProviderError);
    expect((error.cause as ProviderError).cause).toBeInstanceOf(TypeError);
    // Nothing that is no handle is looked up at all.
    const typo = await failure(() =>
      test.provider.beginConnect({ redirectUri, identifier: "ada" }),
    );
    expect(typo.kind).toBe("fail");
    expect(test.requests).toHaveLength(2);
  });

  it("refuses a handle that its account does not claim", async () => {
    const test = await setup();
    const grace = test.simulator.addAccount({
      handle: "grace.bsky.test",
      pds,
    });
    // The DNS of ada's handle names grace's account, whose document claims
    // another handle: somebody who controls a domain can name any DID.
    test.intercept(async (request, simulator) =>
      request.url.includes("dns-query")
        ? Response.json({
            Status: 0,
            Answer: [{ type: 16, data: `"did=${grace.id}"` }],
          })
        : simulator(request),
    );
    const error = await failure(() =>
      test.provider.beginConnect({ redirectUri, identifier: "ada.bsky.test" }),
    );
    expect(error).toMatchObject({ kind: "fail" });
    expect(error.message).toMatch(/does not claim/);
  });

  it("does not take the answer of another server for the one it asked", async () => {
    const test = await setup();
    const { start, params } = await consented(test);
    params.set("iss", "https://elsewhere.test");
    const error = await failure(() =>
      test.provider.completeConnect({ pending: start.pending, params }),
    );
    expect(error.kind).toBe("fail");
    // The code was not taken anywhere.
    expect(
      test.requests.some((request) => request.includes("/oauth/token")),
    ).toBe(false);
  });

  it("refuses tokens for another account, or without the access it asked for", async () => {
    const answers = [
      { sub: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" },
      { scope: "atproto" },
      { token_type: "Bearer" },
    ];
    for (const changed of answers) {
      const test = await setup();
      const { start, params } = await consented(test);
      test.intercept(async (request, simulator) => {
        const response = await simulator(request);
        if (!request.url.endsWith("/oauth/token") || response.status !== 200) {
          return response;
        }
        return Response.json(
          { ...(await response.json()), ...changed },
          { headers: response.headers },
        );
      });
      const error = await failure(() =>
        test.provider.completeConnect({ pending: start.pending, params }),
      );
      expect(error.kind, JSON.stringify(changed)).toBe("fail");
    }
  });

  it("says nothing in a message of what the connection is made with", async () => {
    const test = await setup();
    const { start, params } = await consented(test);
    const code = params.get("code") ?? "";
    // What a callback can carry that somebody else wrote.
    params.set("error", "server_error");
    params.set("error_description", `Failed for ${code} and ${start.state}`);
    const error = await failure(() =>
      test.provider.completeConnect({ pending: start.pending, params }),
    );
    expect(error.message).not.toContain(code);
    expect(error.message).not.toContain(start.state);
  });

  it("begins nothing without a key to sign with", async () => {
    const test = await setup();
    const error = await failure(() =>
      test
        .adapter([])
        .beginConnect({ redirectUri, identifier: "ada.bsky.test" }),
    );
    expect(error.kind).toBe("fail");
    expect(test.requests).toEqual([]);
  });
});

describe("the access over time", () => {
  it("renews an access a week after it was given, and with every refresh", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(access.refreshAt?.getTime()).toBe(test.world.now().getTime() + week);
    expect(access.expiresAt).toBeNull();
    test.world.advance(week);
    const renewed = await test.provider.refresh?.(access.credentials);
    expect(renewed?.refreshAt?.getTime()).toBe(
      test.world.now().getTime() + week,
    );
  });

  it("asks for a new connection when the key that the session was begun with is gone", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const newer = await newClientKey("key-2");
    // The operator has replaced the key, and dropped the old one too soon.
    test.published.keys = [newer];
    const error = await failure(async () =>
      test.adapter([newer]).refresh?.(access.credentials),
    );
    expect(error.kind).toBe("reconnect");
  });

  it("goes on with a session after a new key is added, with the key it began with", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const newer = await newClientKey("key-2");
    const both = [newer, ...test.keys];
    test.published.keys = both;
    const renewed = await test.adapter(both).refresh?.(access.credentials);
    expect(renewed?.credentials).toMatchObject({ keyId: "key-1" });
  });

  it("asks for a new connection when a refresh token comes a second time", async () => {
    const test = await setup();
    const { access } = await connected(test);
    await test.provider.refresh?.(access.credentials);
    // The answer of the first was lost, say: the server has ended the
    // session, for nobody can tell a lost answer from a stolen token.
    const error = await failure(async () =>
      test.provider.refresh?.(access.credentials),
    );
    expect(error.kind).toBe("reconnect");
  });

  it("asks to try again when the server is out of reach while it renews", async () => {
    const test = await setup();
    const { access } = await connected(test);
    test.simulator.arm({ kind: "server-error", operation: "token" });
    const error = await failure(async () =>
      test.provider.refresh?.(access.credentials),
    );
    expect(error.kind).toBe("retry");
  });

  it("gives the access back, or says that the server has no way", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const credentials = access.credentials as BlueskyCredentials;
    const withoutWay = { ...credentials, revocationEndpoint: null };
    expect(
      (await failure(() => test.provider.disconnect(withoutWay))).kind,
    ).toBe("fail");
    await test.provider.disconnect(credentials);
    // The whole session has ended: the refresh token too.
    expect(
      (await failure(async () => test.provider.refresh?.(credentials))).kind,
    ).toBe("reconnect");
  });
});

describe("publishing", () => {
  it("chooses the key of each part before it writes, and writes it once", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const steps = await publishAll(test, access.credentials, ["One", "Two"]);
    // Two steps a part: the first sends nothing.
    expect(steps.map(({ parts }) => parts.length)).toEqual([0, 1, 1, 2]);
    const keys = (steps.at(-1)?.parts ?? []).map(({ id }) =>
      id.split("/").at(-1),
    );
    // The keys grow with the thread, also on a clock that stands still: a
    // repository lists its records by their keys.
    expect(keys).toHaveLength(2);
    expect(keys[0] && keys[1] && keys[0] < keys[1]).toBe(true);
    expect(feed(test.world).map(({ post }) => post.text)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("does not take a record that says something else for its part", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const content = { parts: [{ text: "Mine" }] };
    const chosen = await test.provider.publishStep({
      credentials: access.credentials,
      content,
      key: "target",
      progress: null,
    });
    // Somebody has written under the key in the meantime.
    test.intercept(async (request, simulator) => {
      const response = await simulator(request);
      if (!request.url.includes("getRecord")) return response;
      return Response.json({
        uri: "at://x",
        cid: "bafyreib",
        value: { $type: "app.bsky.feed.post", text: "Theirs", createdAt: "" },
      });
    });
    const error = await failure(() =>
      test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress: chosen,
      }),
    );
    expect(error.kind).toBe("fail");
    expect(feed(test.world)).toEqual([]);
  });

  it("does not go on with a thread on another account", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const content = { parts: [{ text: "One" }, { text: "Two" }] };
    let progress: PublishProgress | null = null;
    for (let step = 0; step < 2; step++) {
      progress = await test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress,
      });
    }
    const other = {
      ...(access.credentials as BlueskyCredentials),
      did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const error = await failure(() =>
      test.provider.publishStep({
        credentials: other,
        content,
        key: "target",
        progress,
      }),
    );
    expect(error.kind).toBe("fail");
  });

  it("asks to try again at the time that the limit names", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const reset = Math.floor(test.world.now().getTime() / 1000) + 600;
    test.intercept(async (request, simulator) =>
      request.url.endsWith("createRecord") && request.headers.has("DPoP")
        ? Response.json(
            { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
            { status: 429, headers: { "RateLimit-Reset": String(reset) } },
          )
        : simulator(request),
    );
    const steps = publishAll(test, access.credentials, ["Busy"]);
    const error = await failure(() => steps);
    expect(error.kind).toBe("retry");
    expect(error.retryAt?.getTime()).toBe(reset * 1000);
  });

  it("asks for a refresh when the PDS refuses the token, and for nothing when it refuses the proof", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const refusing = (error: string) =>
      test.intercept(async (request, simulator) =>
        request.url.endsWith("createRecord")
          ? Response.json(
              { error, message: "Refused" },
              {
                status: 401,
                headers: { "WWW-Authenticate": `DPoP error="${error}"` },
              },
            )
          : simulator(request),
      );
    refusing("invalid_token");
    expect(
      (await failure(() => publishAll(test, access.credentials, ["Hi"]))).kind,
    ).toBe("refresh");
    // A proof that the server did not take is a mistake of pigy's, which a
    // refresh does not cure.
    refusing("invalid_dpop_proof");
    expect(
      (await failure(() => publishAll(test, access.credentials, ["Hi"]))).kind,
    ).toBe("fail");
  });
});

describe("reading and deleting", () => {
  it("reads only posts of the account, and deletes nothing of another", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const other =
      "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3m2abcdefgh22";
    expect(
      await test.provider.readPost?.(access.credentials, other),
    ).toBeNull();
    expect(
      (await failure(() => test.provider.deletePost(access.credentials, other)))
        .kind,
    ).toBe("fail");
  });
});
