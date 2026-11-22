import type { Fetch } from "@pigy/core";
import {
  type BlueskySimulator,
  createBlueskySimulator,
} from "@pigy/simulators/bluesky";
import {
  answerConsent,
  createWorld,
  entitiesOf,
  feed,
} from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { newClientKey } from "../../test/bluesky-keys.ts";
import { ProviderError } from "../errors.ts";
import type { Json, PublishProgress } from "../provider.ts";
import { claims } from "./identity.ts";
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
      keys: async () => with_,
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

/**
 * An intercept that lets the world answer, and changes the JSON of the
 * answers to the requests whose address ends with `path`.
 */
function rewriting(
  path: string,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): Intercept {
  return async (request, simulator) => {
    const response = await simulator(request);
    if (!new URL(request.url).pathname.endsWith(path)) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json(change(body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

/** Addresses of hosts that nobody on the internet may make pigy ask. */
const privateAddresses = [
  "https://10.0.0.5",
  "https://10.0.0.5:8443",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://pds.localhost",
  "https://pds.local",
  "https://pds.internal",
  "https://pds.lan",
  "https://pds.home",
  "https://pds.corp",
  "https://pds.bsky.test:8443",
  "http://pds.bsky.test",
];

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
      // Names of private networks, which atproto does not set aside but
      // which could lead into the network of whoever runs pigy.
      "ada.lan",
      "ada.home",
      "ada.corp",
      "ada.internal",
      `${"a".repeat(64)}.bsky.social`,
    ]) {
      expect(parseHandle(typed), typed).toBeNull();
    }
  });
});

describe("claims", () => {
  // The "DID" specification of atproto: the first handle in the list that
  // is written the way a handle is counts, and the others are ignored.
  const claimed = (alsoKnownAs: string[]) =>
    claims(
      { id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", alsoKnownAs },
      "ada.bsky.test",
    );

  it("takes the first handle in the list, whatever comes before it that is none", () => {
    expect(claimed(["at://ada.bsky.test"])).toBe(true);
    expect(
      claimed([
        "https://ada.example.com",
        "at://not a handle",
        "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        "at://ada.bsky.test/app.bsky.feed.post/3m2abcdefgh22",
        "at://ADA.bsky.test",
        "at://grace.bsky.test",
      ]),
    ).toBe(true);
  });

  it("ignores a handle that comes after the first", () => {
    expect(claimed([])).toBe(false);
    expect(claimed(["at://grace.bsky.test", "at://ada.bsky.test"])).toBe(false);
    // A handle that atproto does not let anybody have is written like
    // one all the same: it is the account's, and the others are not.
    expect(claimed(["at://ada.example", "at://ada.bsky.test"])).toBe(false);
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

  it("follows the host of a handle where it sends pigy for the DID, to a public host", async () => {
    const test = await setup({ account: { resolution: "https" } });
    const file = "https://ada.bsky.test/.well-known/atproto-did";
    /** Has the host of the handle send pigy on along `hops`, the last of which answers with the DID. */
    const redirecting = (...hops: string[]) =>
      test.intercept(async (request, simulator) => {
        const at = [file, ...hops].indexOf(request.url);
        if (at < 0) return simulator(request);
        const next = hops[at];
        return next === undefined
          ? new Response(test.ada.id, {
              headers: { "Content-Type": "text/plain" },
            })
          : new Response(null, { status: 302, headers: { Location: next } });
      });

    // atproto lets the host of a handle send the request on, "up to a
    // reasonable number of redirect hops": five, for pigy.
    const five = Array.from(
      { length: 5 },
      (_, hop) => `https://handles.example.com/ada/${hop}`,
    );
    redirecting(...five);
    expect((await connected(test)).account.id).toBe(test.ada.id);
    expect(test.requests.slice(1, 7)).toEqual(
      [file, ...five].map((url) => `GET ${url}`),
    );

    // Not to a host that nobody on the internet may make pigy ask, and not
    // for ever.
    const refused = [
      ...privateAddresses.map((address) => [`${address}/did`]),
      Array.from(
        { length: 6 },
        (_, hop) => `https://handles.example.com/${hop}`,
      ),
    ];
    for (const hops of refused) {
      redirecting(...hops);
      test.requests.length = 0;
      const error = await failure(() =>
        test.provider.beginConnect({
          redirectUri,
          identifier: "ada.bsky.test",
        }),
      );
      // Said of the handle that the person typed, and not of a server.
      expect(error.message, hops.join()).toBe(
        "pigy found no Bluesky account with the handle ada.bsky.test.",
      );
      expect(test.requests, hops.join()).not.toContain(`GET ${hops.at(-1)}`);
    }
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

  it("connects the account with its handle for a name when its profile cannot be read", async () => {
    for (const kind of [
      "server-error",
      "rate-limit",
      "lost-response",
    ] as const) {
      const test = await setup();
      const { start, params } = await consented(test);
      // After the code was exchanged: failing then would leave a session
      // at Bluesky that pigy holds no tokens of, and cannot end.
      test.simulator.arm({ kind, operation: "profile" });
      const { account, access } = await test.provider.completeConnect({
        pending: start.pending,
        params,
      });
      expect(account, kind).toMatchObject({
        id: test.ada.id,
        name: "ada.bsky.test",
        avatarUrl: null,
      });
      expect(test.world.faults.armed("bluesky"), kind).toEqual([]);
      await publishAll(test, access.credentials, ["Connected"]);
      expect(feed(test.world).map(({ post }) => post.text)).toEqual([
        "Connected",
      ]);
    }
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

  it("takes the first handle that the document of an account names for its own, and no other", async () => {
    const test = await setup();
    // The document names another handle first, and the one that was typed
    // after it.
    test.intercept(
      rewriting(`/${test.ada.id}`, (document) => ({
        ...document,
        alsoKnownAs: ["at://grace.bsky.test", "at://ada.bsky.test"],
      })),
    );
    const error = await failure(() =>
      test.provider.beginConnect({ redirectUri, identifier: "ada.bsky.test" }),
    );
    expect(error.message).toMatch(/does not claim/);
  });

  it("asks no host that the document of an account names unless it is a public one", async () => {
    // Whoever controls an account writes its DID document, and with it
    // where pigy sends requests.
    for (const address of privateAddresses) {
      const test = await setup();
      test.intercept(
        rewriting(`/${test.ada.id}`, (document) => ({
          ...document,
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: address,
            },
          ],
        })),
      );
      const error = await failure(() =>
        test.provider.beginConnect({
          redirectUri,
          identifier: "ada.bsky.test",
        }),
      );
      expect(error.kind, address).toBe("fail");
      expect(test.requests.at(-1), address).toBe(
        `GET https://plc.directory/${test.ada.id}`,
      );
    }
  });

  it("asks no authorization server and no endpoint unless it is at a public host", async () => {
    const named = [
      // What the PDS names as its authorization server.
      (address: string) =>
        rewriting("/oauth-protected-resource", (metadata) => ({
          ...metadata,
          authorization_servers: [address],
        })),
      // What the authorization server names as its endpoints.
      ...[
        "pushed_authorization_request_endpoint",
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
      ].map(
        (endpoint) => (address: string) =>
          rewriting("/oauth-authorization-server", (metadata) => ({
            ...metadata,
            [endpoint]: `${address}/oauth/endpoint`,
          })),
      ),
    ];
    for (const intercept of named) {
      for (const address of privateAddresses) {
        const test = await setup();
        test.intercept(intercept(address));
        const error = await failure(() =>
          test.provider.beginConnect({
            redirectUri,
            identifier: "ada.bsky.test",
          }),
        );
        expect(error.kind, address).toBe("fail");
        // Nothing was asked of the host, nor pushed anywhere.
        const { origin } = new URL(address);
        expect(
          test.requests.filter(
            (request) =>
              new URL(request.split(" ")[1] ?? "").origin === origin ||
              request.startsWith("POST"),
          ),
          address,
        ).toEqual([]);
      }
    }
  });

  it("asks nothing of an authorization server that does not say it does what atproto requires", async () => {
    // The specification "OAuth" of atproto: a server says that it names
    // itself in the callback, takes only pushed requests, and reads a
    // client from the address of its metadata.
    const required = [
      "authorization_response_iss_parameter_supported",
      "require_pushed_authorization_requests",
      "client_id_metadata_document_supported",
    ];
    for (const name of required) {
      for (const value of [undefined, false, "true"]) {
        const test = await setup();
        test.intercept(
          rewriting("/oauth-authorization-server", (metadata) => ({
            ...metadata,
            [name]: value,
          })),
        );
        const error = await failure(() =>
          test.provider.beginConnect({
            redirectUri,
            identifier: "ada.bsky.test",
          }),
        );
        expect(error.kind, `${name}: ${value}`).toBe("fail");
        expect(error.message).toMatch(/not an authorization server/);
        // Refused before the person is sent anywhere.
        expect(
          test.requests.filter((request) => request.startsWith("POST")),
        ).toEqual([]);
      }
    }
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

  /** What Bluesky has issued in `world`, and which of it still works. */
  const sessionTokens = ({ world }: Pick<Setup, "world">) =>
    world.tokens("bluesky").map((token) => ({
      token: token.token,
      status: world.tokenStatus(token),
    }));

  it.each([
    ["for another account", { sub: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" }],
    ["without the access it asked for", { scope: "atproto" }],
    ["that are not bound to its key", { token_type: "Bearer" }],
    // An answer that is not what atproto has it be, and has begun a
    // session all the same.
    ["in an answer that it cannot read", { sub: 1 }],
  ])("ends the session that came with tokens %s", async (_name, changed) => {
    const test = await setup();
    const { start, params } = await consented(test);
    test.intercept(async (request, simulator) => {
      const response = await simulator(request);
      if (!request.url.endsWith("/oauth/token") || response.status !== 200) {
        return response;
      }
      // The server has begun the session. Only what it says of it is
      // changed on the way.
      return Response.json(
        { ...(await response.json()), ...changed },
        { headers: response.headers },
      );
    });

    const error = await failure(() =>
      test.provider.completeConnect({ pending: start.pending, params }),
    );

    // The caller gets no credentials, so nobody could end the session
    // later. It is ended: none of its tokens works.
    const tokens = sessionTokens(test);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter(({ status }) => status === "valid")).toEqual([]);
    // What went wrong is still what the caller is told, without a token.
    expect(error.kind).toBe("fail");
    expect(error.message).not.toContain("give the access back");
    for (const { token } of tokens) {
      expect(error.message).not.toContain(token);
    }
  });

  it("fails with what was wrong with the tokens when the server does not take them back either", async () => {
    const test = await setup();
    const { start, params } = await consented(test);
    test.intercept(async (request, simulator) => {
      if (request.url.endsWith("/oauth/revoke")) {
        throw new TypeError("The server is out of reach");
      }
      const response = await simulator(request);
      if (!request.url.endsWith("/oauth/token") || response.status !== 200) {
        return response;
      }
      return Response.json(
        { ...(await response.json()), token_type: "Bearer" },
        { headers: response.headers },
      );
    });

    const error = await failure(() =>
      test.provider.completeConnect({ pending: start.pending, params }),
    );

    // The adapter tried: the session stands, so only the request shows
    // it.
    expect(
      test.requests.some((request) => request.includes("/oauth/revoke")),
    ).toBe(true);
    // Not `retry`, which the server that is out of reach would be by
    // itself: the code is spent, and the tokens were refused.
    expect(error.kind).toBe("fail");
    expect(error.message).toContain("not bound to its key");
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

  it("asks for a new connection only when the server refuses the refresh token itself", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const refusing = (
      status: number,
      error: string,
      headers: Record<string, string> = {},
    ) =>
      test.intercept(async (request, simulator) =>
        request.url.endsWith("/oauth/token")
          ? Response.json(
              { error, error_description: "Refused" },
              { status, headers },
            )
          : simulator(request),
      );
    const refreshed = async () =>
      (await failure(async () => test.provider.refresh?.(access.credentials)))
        .kind;
    // None of these spends the refresh token, and none says that it is
    // no good. The server could not read pigy's client metadata, which can
    // be over a moment later.
    refusing(400, "invalid_client_metadata");
    expect(await refreshed()).toBe("retry");
    // The server wants a new nonce again, after the one try with the one
    // that it handed out.
    refusing(400, "use_dpop_nonce", { "DPoP-Nonce": "another" });
    expect(await refreshed()).toBe("retry");
    // Mistakes of pigy's, which a new connection would not cure.
    refusing(400, "invalid_dpop_proof");
    expect(await refreshed()).toBe("fail");
    refusing(401, "invalid_client");
    expect(await refreshed()).toBe("fail");
    // RFC 6749 section 5.2: the refresh token is invalid, has expired, was
    // revoked or was issued to another client.
    refusing(400, "invalid_grant");
    expect(await refreshed()).toBe("reconnect");
    // The refresh token is good all the same: nothing above reached the
    // server.
    test.intercept(undefined);
    expect(
      (await test.provider.refresh?.(access.credentials))?.credentials,
    ).toBeDefined();
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
    // What the first step of a part recorded is the key that the second
    // wrote it under, and the second leaves no key for the next part.
    const recorded = steps.map(
      ({ state }) => (state as { rkey: string | null }).rkey,
    );
    expect(recorded).toEqual([keys[0], null, keys[1], null]);
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

  it("takes a record under its key for its part only if it is what the step writes", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const content = { parts: [{ text: "One" }, { text: "Two" }] };
    const step = (progress: PublishProgress | null) =>
      test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress,
      });
    /** Has the PDS answer every look under a key with this record. */
    const found = (uri: string, value: Record<string, unknown>) =>
      test.intercept(async (request, simulator) =>
        request.url.includes("getRecord")
          ? Response.json({ uri, cid: "bafyreiexample", value })
          : simulator(request),
      );
    const post = {
      $type: "app.bsky.feed.post",
      createdAt: "2026-11-15T09:00:00.000Z",
    };

    // The first part replies to nothing.
    const chosen = await step(null);
    const firstKey = (chosen.state as { rkey: string }).rkey;
    found(`at://${test.ada.id}/app.bsky.feed.post/${firstKey}`, {
      ...post,
      text: "One",
      reply: {
        root: {
          uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3m2abcdefgh22",
          cid: "bafyreiroot",
        },
        parent: {
          uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3m2abcdefgh22",
          cid: "bafyreiroot",
        },
      },
    });
    expect((await failure(() => step(chosen))).kind).toBe("fail");

    // The first part, published, and the key of the second, chosen.
    test.intercept(undefined);
    const halfway = await step(await step(null));
    const second = await step(halfway);
    const { rkey, refs } = second.state as {
      rkey: string;
      refs: { uri: string; cid: string }[];
    };
    const [first = { uri: "", cid: "" }] = refs;
    const uri = `at://${test.ada.id}/app.bsky.feed.post/${rkey}`;
    const written = {
      ...post,
      text: "Two",
      reply: { root: first, parent: first },
    };
    const others: [string, string, Record<string, unknown>][] = [
      ["under another address", `${uri}x`, written],
      [
        "with a picture",
        uri,
        { ...written, embed: { $type: "app.bsky.embed.images", images: [] } },
      ],
      [
        // The part has no link, so the step marks none.
        "with a link marked up",
        uri,
        {
          ...written,
          facets: [
            {
              index: { byteStart: 0, byteEnd: 3 },
              features: [
                {
                  $type: "app.bsky.richtext.facet#link",
                  uri: "https://example.test/",
                },
              ],
            },
          ],
        },
      ],
      [
        // The part has no link, so no card is that of its first link.
        "with the card of a link",
        uri,
        {
          ...written,
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: "https://example.test/",
              title: "A page",
              description: "",
            },
          },
        },
      ],
      ["in a language", uri, { ...written, langs: ["en"] }],
      [
        "with labels",
        uri,
        {
          ...written,
          labels: { $type: "com.atproto.label.defs#selfLabels", values: [] },
        },
      ],
      ["of another kind", uri, { ...written, $type: "app.bsky.feed.like" }],
      ["replying to nothing", uri, { ...post, text: "Two" }],
      [
        "replying to another version of the part before",
        uri,
        {
          ...written,
          reply: { root: first, parent: { ...first, cid: "bafyreiother" } },
        },
      ],
      [
        "in another thread",
        uri,
        {
          ...written,
          reply: { root: { ...first, uri: `${first.uri}x` }, parent: first },
        },
      ],
      [
        "with the root of another version",
        uri,
        {
          ...written,
          reply: { root: { ...first, cid: "bafyreiother" }, parent: first },
        },
      ],
    ];
    for (const [what, at, value] of others) {
      found(at, value);
      expect((await failure(() => step(second))).kind, what).toBe("fail");
    }
    // Nothing was written over what was found.
    expect(feed(test.world).map(({ post }) => post.text)).toEqual(["One"]);

    // What the step writes, written at another time: the step finds its
    // part, and writes nothing.
    found(uri, written);
    const taken = await step(second);
    expect(taken.parts.map(({ id }) => id)).toEqual([first.uri, uri]);
    expect(feed(test.world).map(({ post }) => post.text)).toEqual(["One"]);
  });

  it("marks up the links, the tags and the mentions of accounts that there are, by the bytes of the text", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const grace = test.simulator.addAccount({
      handle: "grace.bsky.test",
      pds,
      name: "Grace Hopper",
    });
    // An emoji and an accent before everything: a facet that was placed
    // by where it stands in the string would be refused by the PDS, or
    // would mark other letters than these.
    const text =
      "🎉 Café with @Grace.bsky.test and @nobody.bsky.test: https://example.test/a?b=c, example.com #Fête #1";
    await publishAll(test, access.credentials, [text]);
    const kept = feed(test.world)[0]?.post;
    expect(kept?.text).toBe(text);
    expect(kept && entitiesOf(kept)).toEqual([
      // Found whatever its case, and marked with the DID of the account.
      // Nobody has the other handle, so that mention is text.
      ["mention", "@Grace.bsky.test", grace.id],
      // Without the comma of the sentence.
      ["link", "https://example.test/a?b=c", "https://example.test/a?b=c"],
      // An address without its scheme leads to the one with HTTPS.
      ["link", "example.com", "https://example.com"],
      // A tag is kept without its sign. "#1" is none.
      ["hashtag", "#Fête", "Fête"],
    ]);
  });

  it("records whom a part mentions before it writes, and marks the same when the step is run again", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const grace = test.simulator.addAccount({
      handle: "grace.bsky.test",
      pds,
      name: "Grace Hopper",
    });
    const content = { parts: [{ text: "Hi @grace.bsky.test" }] };
    const step = (progress: PublishProgress | null) =>
      test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress,
      });
    const chosen = await step(null);
    // Nothing is written by the step that looks the account up.
    expect(feed(test.world)).toEqual([]);
    // What the part is written with is noted: the mention, with the
    // account that the handle led to.
    expect((chosen.state as { facets: unknown }).facets).toEqual([
      {
        index: { byteStart: 3, byteEnd: 19 },
        features: [{ $type: "app.bsky.richtext.facet#mention", did: grace.id }],
      },
    ]);
    // The step writes, and its answer is lost. From then on nobody can be
    // looked up: a step that asked again would mark no mention, find a
    // record with one under its key, and refuse it as another post.
    await step(chosen);
    test.intercept(async (request, simulator) => {
      if (request.url.includes("dns-query")) throw new TypeError("No DNS");
      return simulator(request);
    });
    const again = await step(chosen);
    expect(again.done).toBe(true);
    expect(feed(test.world)).toHaveLength(1);
  });

  it.each([
    [
      "a handle that the DNS cannot be asked for",
      (request: Request) => request.url.includes("dns-query"),
    ],
    [
      "a handle whose document cannot be read",
      (request: Request) => request.url.includes("plc.directory"),
    ],
  ])(
    "publishes a mention as text for %s, and fails nothing",
    async (_name, lost) => {
      const test = await setup();
      const { access } = await connected(test);
      test.simulator.addAccount({
        handle: "grace.bsky.test",
        pds,
        name: "Grace Hopper",
      });
      test.intercept(async (request, simulator) => {
        if (lost(request)) throw new TypeError("Out of reach");
        return simulator(request);
      });
      await publishAll(test, access.credentials, ["Hi @grace.bsky.test #tag"]);
      const kept = feed(test.world)[0]?.post;
      // The post is there, with what could be marked without asking.
      expect(kept && entitiesOf(kept)).toEqual([["hashtag", "#tag", "tag"]]);
    },
  );

  it("does not take a handle for an account that does not claim it", async () => {
    const test = await setup();
    const { access } = await connected(test);
    // The host of a handle can name any account: here the DNS says that
    // "impostor.bsky.test" is Ada, whose document claims another handle.
    test.intercept(async (request, simulator) =>
      request.url.includes("dns-query") &&
      request.url.includes("_atproto.impostor.bsky.test")
        ? Response.json({
            Status: 0,
            Answer: [{ type: 16, data: `"did=${test.ada.id}"` }],
          })
        : simulator(request),
    );
    await publishAll(test, access.credentials, ["Hi @impostor.bsky.test"]);
    const kept = feed(test.world)[0]?.post;
    expect(kept && entitiesOf(kept)).toEqual([]);
    expect(await test.provider.mentionable?.(["impostor.bsky.test"])).toEqual(
      [],
    );
  });

  it("says which handles are accounts, for whoever writes a post", async () => {
    const test = await setup();
    expect(
      await test.provider.mentionable?.([
        "ada.bsky.test",
        "nobody.bsky.test",
        "not a handle",
      ]),
    ).toEqual(["ada.bsky.test"]);
  });

  it("publishes a part with the card of its first link, and without one that is another link's", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const card = {
      url: "https://example.test/",
      title: "The example page",
      description: "A page.",
    };
    const publishWith = async (text: string) => {
      let progress: PublishProgress | null = null;
      while (!progress?.done) {
        progress = await test.provider.publishStep({
          credentials: access.credentials,
          content: { parts: [{ text, card }] },
          key: text,
          progress,
        });
      }
    };
    await publishWith("See https://example.test/ and https://example.com/");
    // A card of a link that is not the first of the part is not sent: an
    // app would show it as the preview of something that the post does
    // not lead with.
    await publishWith("See https://example.com/ and https://example.test/");
    await publishWith("No link at all");
    // By their texts: the clock of the world stands still, so the feed
    // lists these three in the order of their keys, which are random.
    expect(
      Object.fromEntries(
        feed(test.world).map(({ post }) => [post.text, post.card]),
      ),
    ).toEqual({
      "See https://example.test/ and https://example.com/": card,
      "See https://example.com/ and https://example.test/": null,
      "No link at all": null,
    });
  });

  it("writes the card that the step which chose the key was handed, whatever a later run is handed", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const text = "See https://example.test/";
    const step = (progress: PublishProgress | null, title?: string) =>
      test.provider.publishStep({
        credentials: access.credentials,
        content: {
          parts: [
            {
              text,
              ...(title && {
                card: { url: "https://example.test/", title, description: "" },
              }),
            },
          ],
        },
        key: "target",
        progress,
      });
    const chosen = await step(null, "As the page was");
    // The step that writes is run three times, as after answers that
    // were lost: with no card, because the page cannot be read any
    // more, and with what the page says later. It writes what was
    // noted, once, and finds that record the other times.
    await step(chosen);
    await step(chosen, "As the page is now");
    const again = await step(chosen);
    expect(again.done).toBe(true);
    expect(feed(test.world)).toHaveLength(1);
    expect(feed(test.world)[0]?.post.card?.title).toBe("As the page was");
  });

  it("takes a part that was written before pigy marked anything up for its own, and goes on with the thread", async () => {
    const test = await setup();
    const { access } = await connected(test);
    // A text in which pigy now finds a link and a tag.
    const text = "See https://example.test/ #news";
    const content = { parts: [{ text }, { text: "And #more" }] };
    const step = (progress: PublishProgress | null) =>
      test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress,
      });
    // The progress of a delivery as the pigy before this one left it:
    // the key of the first part chosen, and nothing noted of facets,
    // which that pigy did not have.
    const chosen = await step(null);
    const { did, rkey, refs } = chosen.state as {
      did: string;
      rkey: string;
      refs: Json[];
    };
    const old: PublishProgress = { ...chosen, state: { did, rkey, refs } };
    // That pigy wrote the part as the text that it is, and never heard
    // the answer: the PDS has it under the key.
    const uri = `at://${test.ada.id}/app.bsky.feed.post/${String(rkey)}`;
    let written = 0;
    test.intercept(async (request, simulator) => {
      if (request.url.includes("createRecord")) written++;
      return request.url.includes("getRecord")
        ? Response.json({
            uri,
            cid: "bafyreiexample",
            value: {
              $type: "app.bsky.feed.post",
              text,
              createdAt: "2026-11-15T09:00:00.000Z",
            },
          })
        : simulator(request);
    });
    // The step is run again by this pigy. It finds the part, and does
    // not take it for another post because it would mark it up today,
    // which ended the delivery for good with the rest of the thread
    // unsent.
    const taken = await step(old);
    expect(taken.parts.map(({ id }) => id)).toEqual([uri]);
    expect(written).toBe(0);
    // The thread goes on: the next step chooses the key of the second
    // part, and notes what this pigy marks in it.
    test.intercept(undefined);
    const next = await step(taken);
    expect((next.state as { facets: unknown[] }).facets).toHaveLength(1);
  });

  it("writes a part of old progress, whose key was chosen before pigy marked anything up, as text", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const content = { parts: [{ text: "See https://example.test/ #news" }] };
    const chosen = await test.provider.publishStep({
      credentials: access.credentials,
      content,
      key: "target",
      progress: null,
    });
    const { did, rkey, refs } = chosen.state as {
      did: string;
      rkey: string;
      refs: Json[];
    };
    // Nothing is under the key: the pigy before this one did not get to
    // write. The step writes what a run of that pigy would have, so
    // that every run of the step writes and looks for the same.
    const done = await test.provider.publishStep({
      credentials: access.credentials,
      content,
      key: "target",
      progress: { ...chosen, state: { did, rkey, refs } },
    });
    expect(done.done).toBe(true);
    const kept = feed(test.world)[0]?.post;
    expect(kept && entitiesOf(kept)).toEqual([]);
  });

  it("writes and looks for what was noted when the key was chosen, whatever pigy takes for a link by the time the step runs", async () => {
    const test = await setup();
    const { access } = await connected(test);
    const content = {
      parts: [{ text: "See example.com and https://example.test/ #news" }],
    };
    const step = (progress: PublishProgress | null) =>
      test.provider.publishStep({
        credentials: access.credentials,
        content,
        key: "target",
        progress,
      });
    const chosen = await step(null);
    const state = chosen.state as { facets: Json[] };
    expect(state.facets).toHaveLength(3);
    // The notes of a pigy that took "example.com" for no link, as one
    // with a shorter list of top-level domains: the step that chose the
    // key ran before a deploy, and the step that writes runs after it,
    // with a pigy that finds three things in the text.
    const noted = state.facets.slice(1);
    const before: PublishProgress = {
      ...chosen,
      state: { ...state, facets: noted },
    };
    // The answer to the writing is lost, and the step is run again.
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(() => step(before))).kind).toBe("retry");
    const again = await step(before);
    expect(again.done).toBe(true);
    // One post, with what was noted and nothing that this pigy would
    // add: a step that marked up by its own reading would have written
    // three facets, or found the record of two to be another post.
    const posts = feed(test.world);
    expect(posts).toHaveLength(1);
    expect(posts[0] && entitiesOf(posts[0].post)).toEqual([
      ["link", "https://example.test/", "https://example.test/"],
      ["hashtag", "#news", "news"],
    ]);
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

  it("asks to try again, and for no refresh, when the PDS wants another nonce after the one try", async () => {
    const test = await setup();
    const { access } = await connected(test);
    let nonces = 0;
    // A PDS that hands out a new nonce with every answer, and wants it in
    // the next proof: the adapter tries once with the one it got.
    test.intercept(async (request, simulator) =>
      request.url.endsWith("createRecord")
        ? Response.json(
            {
              error: "use_dpop_nonce",
              message: "Resource server requires nonce in DPoP proof",
            },
            {
              status: 401,
              headers: {
                "WWW-Authenticate": 'DPoP error="use_dpop_nonce"',
                "DPoP-Nonce": `nonce-${++nonces}`,
              },
            },
          )
        : simulator(request),
    );
    // A refresh would spend a refresh token for an access token that is
    // good, and the next refusal would be taken for one of the session.
    const error = await failure(() =>
      publishAll(test, access.credentials, ["Hi"]),
    );
    expect(error.kind).toBe("retry");
    expect(nonces).toBe(2);
  });
});

describe("what a server repeats of a request", () => {
  /**
   * Makes the authorization server refuse the requests to `path` with a
   * description that repeats what the request sent as `name`: a field of
   * its form, or its proof of DPoP. Returns what it repeated.
   */
  function reflecting(test: Setup, path: string, name: string) {
    const repeated: string[] = [];
    test.intercept(async (request, simulator) => {
      if (!request.url.endsWith(path)) return simulator(request);
      const sent: Record<string, string> = {
        ...Object.fromEntries(new URLSearchParams(await request.text())),
        DPoP: request.headers.get("DPoP") ?? "",
      };
      const value = sent[name] ?? "";
      repeated.push(value);
      return Response.json(
        { error: "invalid_request", error_description: value },
        { status: 400 },
      );
    });
    return repeated;
  }

  /** Fails unless `error` quotes what was repeated, without any of it. */
  function expectRemoved(error: ProviderError, repeated: string[]) {
    const [value = ""] = repeated;
    expect(value).not.toBe("");
    // The description reached the message, in place of what it said.
    expect(error.message).toContain("[removed]");
    // A message is cut to a sentence or two, so a long secret that was not
    // removed would show as its beginning.
    expect(error.message).not.toContain(value.slice(0, 32));
  }

  it("says none of the secrets of a pushed request", async () => {
    for (const name of ["state", "client_assertion", "DPoP"]) {
      const test = await setup();
      const repeated = reflecting(test, "/oauth/par", name);
      const error = await failure(() =>
        test.provider.beginConnect({
          redirectUri,
          identifier: "ada.bsky.test",
        }),
      );
      expectRemoved(error, repeated);
    }
  });

  it("says none of the secrets of an exchange of the code", async () => {
    for (const name of ["code", "code_verifier", "client_assertion", "DPoP"]) {
      const test = await setup();
      const { start, params } = await consented(test);
      const repeated = reflecting(test, "/oauth/token", name);
      const error = await failure(() =>
        test.provider.completeConnect({ pending: start.pending, params }),
      );
      expectRemoved(error, repeated);
    }
  });

  it("says none of the secrets of a refresh, or of giving the access back", async () => {
    const calls = [
      {
        path: "/oauth/token",
        names: ["refresh_token", "client_assertion", "DPoP"],
        call: (test: Setup, credentials: Json) =>
          test.provider.refresh?.(credentials),
      },
      {
        path: "/oauth/revoke",
        names: ["token", "client_assertion", "DPoP"],
        call: (test: Setup, credentials: Json) =>
          test.provider.disconnect(credentials),
      },
    ];
    for (const { path, names, call } of calls) {
      for (const name of names) {
        const test = await setup();
        const { access } = await connected(test);
        const repeated = reflecting(test, path, name);
        const error = await failure(async () => call(test, access.credentials));
        expectRemoved(error, repeated);
      }
    }
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
