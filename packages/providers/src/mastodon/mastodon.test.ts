import type { Fetch } from "@pigy/core";
import {
  createMastodonSimulator,
  type Instance,
} from "@pigy/simulators/mastodon";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { memoryAppStore } from "../../test/mastodon-apps.ts";
import { ProviderError } from "../errors.ts";
import {
  createMastodonProvider,
  type MastodonCredentials,
  type MastodonProviderOptions,
} from "./index.ts";

/**
 * What is the Mastodon adapter's own. What every provider does is in
 * test/conformance.
 */

const domain = "mastodon.example";
const redirectUri = "https://pigy.example/connect/mastodon/callback";

type Intercept = (
  request: Request,
) => Promise<Response | undefined> | Response | undefined;

/**
 * The adapter against a simulated instance. Every request is noted, and
 * `intercept` may answer one in the simulator's place, with what Mastodon
 * would not send.
 */
function setup(
  instance: Partial<Omit<Instance, "domain">> = {},
  options: Partial<MastodonProviderOptions> = {},
) {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createMastodonSimulator(world);
  simulator.addInstance(domain, instance);
  const ada = simulator.addAccount(domain, "ada", "Ada Lovelace");
  const requests: Request[] = [];
  const hooks: { intercept?: Intercept } = {};
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return (await hooks.intercept?.(request)) ?? simulator.fetch(request);
  };
  const apps = memoryAppStore();
  const provider = createMastodonProvider({
    fetch,
    now: world.now,
    apps,
    clientName: "pigy",
    ...options,
  });
  /** The requests so far, as "METHOD path". */
  const paths = () =>
    requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`);
  return { world, simulator, ada, requests, paths, hooks, apps, provider };
}

type Setup = ReturnType<typeof setup>;

async function connect({ provider, simulator, ada }: Setup) {
  const start = await provider.beginConnect({
    redirectUri,
    identifier: domain,
  });
  const callback = await answerConsent(simulator.fetch, start.url, {
    account: ada.id,
  });
  const connection = await provider.completeConnect({
    pending: start.pending,
    params: callback.searchParams,
  });
  return {
    ...connection,
    credentials: connection.access.credentials as MastodonCredentials,
  };
}

async function failure(action: () => Promise<unknown>) {
  const error = await action().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error instanceof ProviderError) return error;
  throw new Error(`Expected a ProviderError, got ${String(error)}`);
}

const hello = { parts: [{ text: "Hello" }] };

describe("beginning a connection", () => {
  it("sends the person to the instance, with PKCE and the narrowest scopes", async () => {
    const { provider, apps } = setup();
    const { url, state, pending } = await provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe(
      "https://mastodon.example/oauth/authorize",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      response_type: "code",
      client_id: apps.entries.get(domain)?.clientId,
      redirect_uri: redirectUri,
      scope: "profile read:statuses write:statuses write:media",
      state,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    // The verifier stays with pigy. Only its hash travels.
    const { codeVerifier } = pending as { codeVerifier: string };
    expect(url).not.toContain(codeVerifier);
  });

  it("does without PKCE and the profile scope on an instance before 4.3", async () => {
    const sim = setup({ version: "4.2.10" });
    const { url, pending } = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe(
      "read:accounts read:statuses write:statuses write:media",
    );
    expect(params.has("code_challenge")).toBe(false);
    expect(pending).toMatchObject({ codeVerifier: null });
    // And the connection works all the same.
    expect((await connect(sim)).account.handle).toBe("@ada@mastodon.example");
  });

  it("registers with an instance once", async () => {
    const { provider, paths, apps } = setup();
    await provider.beginConnect({ redirectUri, identifier: domain });
    await provider.beginConnect({ redirectUri, identifier: domain });
    expect(paths().filter((path) => path === "POST /api/v1/apps")).toHaveLength(
      1,
    );
    expect(apps.entries.get(domain)).toMatchObject({
      redirectUri,
      scopes: ["profile", "read:statuses", "write:statuses", "write:media"],
    });
  });

  it("registers under the name it was given, with the address of the app", async () => {
    const { provider, requests } = setup();
    await provider.beginConnect({ redirectUri, identifier: domain });
    const registration = requests.find(({ url }) =>
      url.endsWith("/api/v1/apps"),
    );
    expect(await registration?.json()).toEqual({
      client_name: "pigy",
      redirect_uris: redirectUri,
      scopes: "profile read:statuses write:statuses write:media",
      website: "https://pigy.example",
    });
  });

  it("registers again when the instance no longer knows the registration", async () => {
    const { provider, apps, paths } = setup();
    // What is left of a registration that the instance has removed.
    apps.entries.set(domain, {
      clientId: "pigy-sim-removed",
      clientSecret: "pigy-sim-removed",
      redirectUri,
      scopes: ["profile", "read:statuses", "write:statuses", "write:media"],
    });
    const { url } = await provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    expect(paths()).toContain("POST /api/v1/apps");
    const clientId = apps.entries.get(domain)?.clientId;
    expect(clientId).not.toBe("pigy-sim-removed");
    expect(new URL(url).searchParams.get("client_id")).toBe(clientId);
  });

  it("registers again for another redirect address, or for more scopes", async () => {
    const { provider, apps } = setup();
    await provider.beginConnect({ redirectUri, identifier: domain });
    const first = apps.entries.get(domain);

    // The app has moved to another address.
    const moved = "https://pigy.other.example/connect/mastodon/callback";
    await provider.beginConnect({ redirectUri: moved, identifier: domain });
    const second = apps.entries.get(domain);
    expect(second?.clientId).not.toBe(first?.clientId);
    expect(second?.redirectUri).toBe(moved);

    // A registration from before pigy asked for one of its scopes.
    if (!second) throw new Error("No registration was stored");
    apps.entries.set(domain, { ...second, scopes: ["profile"] });
    await provider.beginConnect({ redirectUri: moved, identifier: domain });
    expect(apps.entries.get(domain)?.clientId).not.toBe(second?.clientId);
  });

  it("replaces a stored registration that it cannot read", async () => {
    const { provider, apps } = setup();
    apps.entries.set(domain, { clientId: "only" } as never);
    await provider.beginConnect({ redirectUri, identifier: domain });
    expect(apps.entries.get(domain)).toMatchObject({ redirectUri });
  });

  it("keeps a registration when the instance cannot be asked about it", async () => {
    const sim = setup();
    await sim.provider.beginConnect({ redirectUri, identifier: domain });
    const stored = sim.apps.entries.get(domain);
    // The instance is down for the question. That says nothing about the
    // registration, so it is not thrown away.
    sim.hooks.intercept = (request) =>
      request.url.endsWith("/oauth/token")
        ? new Response("Bad gateway", { status: 502 })
        : undefined;
    const error = await failure(() =>
      sim.provider.beginConnect({ redirectUri, identifier: domain }),
    );
    expect(error.kind).toBe("retry");
    expect(sim.apps.entries.get(domain)).toEqual(stored);
  });

  it("finishes a connection with the registration it began with", async () => {
    const sim = setup();
    const start = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    // While the person consents, somebody else connects from another
    // address, which replaces the stored registration.
    await sim.provider.beginConnect({
      redirectUri: "https://pigy.other.example/connect/mastodon/callback",
      identifier: domain,
    });
    const callback = await answerConsent(sim.simulator.fetch, start.url, {
      account: sim.ada.id,
    });
    const { account } = await sim.provider.completeConnect({
      pending: start.pending,
      params: callback.searchParams,
    });
    expect(account.handle).toBe("@ada@mastodon.example");
  });

  it("takes the address as people type it", async () => {
    const { provider } = setup();
    const { url } = await provider.beginConnect({
      redirectUri,
      identifier: " HTTPS://Mastodon.Example/ ",
    });
    expect(new URL(url).host).toBe("mastodon.example");
  });

  it.each([
    [undefined],
    [""],
    ["http://mastodon.example"],
    ["mastodon.example/api"],
    ["ada:secret@mastodon.example"],
    ["mastodon.example@evil.example"],
    ["mastodon.example:8443"],
    ["127.0.0.1"],
    ["localhost"],
  ])("asks nobody about the address %j", async (identifier) => {
    const { provider, requests } = setup();
    const error = await failure(() =>
      provider.beginConnect({ redirectUri, identifier }),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toContain("address of your Mastodon server");
    expect(requests).toEqual([]);
  });

  it("says so when the server is not a Mastodon that it can post to", async () => {
    const answers: [Response, string][] = [
      [new Response("Not found", { status: 404 }), "Mastodon 4.0 or later"],
      [new Response("<html>Welcome</html>"), "the way a Mastodon server does"],
      [
        Response.json({ domain, configuration: {} }),
        "the way a Mastodon server does",
      ],
    ];
    for (const [answer, message] of answers) {
      const sim = setup();
      sim.hooks.intercept = () => answer;
      const error = await failure(() =>
        sim.provider.beginConnect({ redirectUri, identifier: domain }),
      );
      expect(error.kind).toBe("fail");
      expect(error.message).toContain(message);
      // It did not go on to register with a server it does not know.
      expect(sim.paths()).toEqual(["GET /api/v2/instance"]);
    }
  });
});

describe("requests to an instance", () => {
  it("go to the instance over HTTPS and follow no redirect", async () => {
    const sim = setup();
    await connect(sim);
    for (const request of sim.requests) {
      expect(new URL(request.url).origin).toBe("https://mastodon.example");
      expect(request.redirect).toBe("manual");
    }
  });

  it("stop at an instance that sends them elsewhere", async () => {
    const sim = setup();
    sim.hooks.intercept = () =>
      new Response(null, {
        status: 301,
        headers: { Location: "https://elsewhere.example/api/v2/instance" },
      });
    const error = await failure(() =>
      sim.provider.beginConnect({ redirectUri, identifier: domain }),
    );
    expect(error.kind).toBe("fail");
    expect(sim.requests).toHaveLength(1);
  });

  it("read no more than a megabyte of an answer", async () => {
    const sim = setup();
    sim.hooks.intercept = () =>
      Response.json({ domain, padding: "x".repeat(1024 * 1024) });
    const error = await failure(() =>
      sim.provider.beginConnect({ redirectUri, identifier: domain }),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toContain("more than pigy is willing to read");
  });

  it("give up on an instance that does not answer in time", async () => {
    const sim = setup({}, { timeoutMs: 20 });
    sim.hooks.intercept = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        );
      });
    const error = await failure(() =>
      sim.provider.beginConnect({ redirectUri, identifier: domain }),
    );
    expect(error.kind).toBe("retry");
  });
});

describe("completing a connection", () => {
  it("tells whose account it is", async () => {
    const sim = setup();
    const { account, access } = await connect(sim);
    expect(account).toEqual({
      // Unique across instances, which Mastodon's own IDs are not.
      id: `${sim.ada.id}@mastodon.example`,
      handle: "@ada@mastodon.example",
      name: "Ada Lovelace",
      avatarUrl: "https://mastodon.example/avatars/original/missing.png",
      profileUrl: "https://mastodon.example/@ada",
    });
    // A token of Mastodon's does not expire and cannot be refreshed.
    expect(access).toMatchObject({ refreshAt: null, expiresAt: null });
    expect(sim.provider.refresh).toBeUndefined();
  });

  it("writes the handle with the domain that the instance uses for its accounts", async () => {
    const sim = setup();
    // An instance that is reached at one domain and addressed with another.
    sim.hooks.intercept = async (request) => {
      if (!request.url.endsWith("/api/v2/instance")) return undefined;
      const instance = (await (
        await sim.simulator.fetch(request)
      ).json()) as object;
      return Response.json({ ...instance, domain: "example.social" });
    };
    const { account, credentials } = await connect(sim);
    expect(account.handle).toBe("@ada@example.social");
    // Requests keep going to where the instance is.
    expect(credentials.domain).toBe("mastodon.example");
  });

  it("passes on no address of a picture or a profile that is not HTTPS", async () => {
    const sim = setup();
    sim.hooks.intercept = async (request) => {
      if (!request.url.endsWith("/verify_credentials")) return undefined;
      const account = (await (
        await sim.simulator.fetch(request)
      ).json()) as object;
      return Response.json({
        ...account,
        display_name: "",
        avatar: "javascript:alert(1)",
        url: "http://mastodon.example/@ada",
      });
    };
    const { account } = await connect(sim);
    expect(account).toMatchObject({
      avatarUrl: null,
      profileUrl: null,
      // Without a display name, the username is the name.
      name: "ada",
    });
  });

  it("sends the verifier with the code", async () => {
    const sim = setup();
    await connect(sim);
    const exchange = sim.requests.findLast(({ url }) =>
      url.endsWith("/oauth/token"),
    );
    const form = new URLSearchParams(await exchange?.text());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("redirect_uri")).toBe(redirectUri);
  });

  it.each([[{ token_type: "mac" }], [{ scope: "profile read:statuses" }]])(
    "refuses a token that is not what it asked for: %j",
    async (override) => {
      const sim = setup();
      sim.hooks.intercept = async (request) => {
        const form = new URLSearchParams(await request.clone().text());
        if (form.get("grant_type") !== "authorization_code") return undefined;
        const token = (await (
          await sim.simulator.fetch(request)
        ).json()) as object;
        return Response.json({ ...token, ...override });
      };
      const error = await failure(() => connect(sim));
      expect(error.kind).toBe("fail");
      expect(error.message).toContain("did not give pigy the access it needs");
    },
  );

  it("accepts a wider scope in place of the one it asked for", async () => {
    const sim = setup();
    sim.hooks.intercept = async (request) => {
      const form = new URLSearchParams(await request.clone().text());
      if (form.get("grant_type") !== "authorization_code") return undefined;
      const token = (await (
        await sim.simulator.fetch(request)
      ).json()) as object;
      return Response.json({ ...token, scope: "profile read write" });
    };
    expect((await connect(sim)).account.handle).toBe("@ada@mastodon.example");
  });

  it("quotes the reason when the instance reports another error than a refusal", async () => {
    const sim = setup();
    const start = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const error = await failure(() =>
      sim.provider.completeConnect({
        pending: start.pending,
        params: new URLSearchParams({
          state: start.state,
          error: "server_error",
          error_description: "Something broke",
        }),
      }),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toBe(
      "mastodon.example did not connect the account: Something broke",
    );
  });

  it.each([
    [
      "answers that it is down",
      () => new Response("Bad gateway", { status: 502 }),
    ],
    [
      "cannot be reached",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "fails for good when the instance %s while the code is exchanged",
    async (_what, answer) => {
      const sim = setup();
      const start = await sim.provider.beginConnect({
        redirectUri,
        identifier: domain,
      });
      const callback = await answerConsent(sim.simulator.fetch, start.url, {
        account: sim.ada.id,
      });
      sim.hooks.intercept = async (request) => {
        const form = new URLSearchParams(await request.clone().text());
        return form.get("grant_type") === "authorization_code"
          ? answer()
          : undefined;
      };
      const error = await failure(() =>
        sim.provider.completeConnect({
          pending: start.pending,
          params: callback.searchParams,
        }),
      );
      // Whether the instance has used the code up is not known, so it cannot
      // be tried again: not "retry", which it would be anywhere else.
      expect(error.kind).toBe("fail");
      expect(error.message).toMatch(
        /^mastodon\.example .+ Connect the account again\.$/,
      );
    },
  );

  it("refuses a code that the instance does not take", async () => {
    const sim = setup();
    const start = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const error = await failure(() =>
      sim.provider.completeConnect({
        pending: start.pending,
        params: new URLSearchParams({
          state: start.state,
          code: "pigy-sim-made-up",
        }),
      }),
    );
    // A request without the account's token says nothing about its access.
    expect(error.kind).toBe("fail");
    expect(error.message).toContain(
      "The provided authorization grant is invalid",
    );
  });
});

describe("credentials from storage", () => {
  it.each([
    [{ domain: "evil.example/steal" }],
    [{ domain: "MASTODON.EXAMPLE" }],
    [{ domain: "127.0.0.1" }],
    [{ accessToken: "" }],
    [{ extra: "field" }],
  ])("are not used when they are not as they were made: %j", async (change) => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const before = sim.requests.length;
    const error = await failure(() =>
      sim.provider.limits({ ...credentials, ...change }),
    );
    expect(error.kind).toBe("reconnect");
    // Above all, the token is not sent to a host that storage names.
    expect(sim.requests).toHaveLength(before);
  });
});

describe("limits", () => {
  it("are those of the instance", async () => {
    const sim = setup({ maxCharacters: 5000, charactersReservedPerUrl: 30 });
    const { credentials } = await connect(sim);
    expect(await sim.provider.limits(credentials)).toEqual({
      network: "mastodon",
      maxCharacters: 5000,
      charactersPerUrl: 30,
    });
  });
});

describe("publishing", () => {
  it("sends the text as it is, and leaves the visibility to the account", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    await sim.provider.publishStep({
      credentials,
      content: { parts: [{ text: "  Hello\n\nworld  " }] },
      key: "target-1",
      progress: null,
    });
    const request = sim.requests.at(-1);
    expect(request?.headers.get("Authorization")).toBe(
      `Bearer ${credentials.accessToken}`,
    );
    expect(await request?.json()).toEqual({ status: "  Hello\n\nworld  " });
  });

  it("posts with the visibility it was made with", async () => {
    const sim = setup({}, { visibility: "direct" });
    const { credentials } = await connect(sim);
    await sim.provider.publishStep({
      credentials,
      content: hello,
      key: "target-1",
      progress: null,
    });
    expect(await sim.requests.at(-1)?.json()).toEqual({
      status: "Hello",
      visibility: "direct",
    });
  });

  it("keys every part of every delivery differently, and the same on a new attempt", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const content = { parts: [{ text: "One" }, { text: "Two" }] };
    const keyOf = async (key: string, parts: number) => {
      await sim.provider.publishStep({
        credentials,
        content,
        key,
        progress:
          parts === 0
            ? null
            : {
                parts: [{ id: firstId, url: null }],
                done: false,
                waitSeconds: 0,
                state: null,
              },
      });
      return sim.requests.at(-1)?.headers.get("Idempotency-Key");
    };
    let firstId = "";
    const first = await keyOf("target-1", 0);
    firstId = feed(sim.world)[0]?.post.id ?? "";
    expect(await keyOf("target-1", 0)).toBe(first);
    expect(await keyOf("target-1", 1)).not.toBe(first);
    expect(await keyOf("target-2", 0)).not.toBe(first);
    // Whatever the caller's key, the header is one that can be sent.
    expect(await keyOf("Schlüssel\n1 \u{1F511}", 0)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("makes no request when every part is published", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const before = sim.requests.length;
    const progress = await sim.provider.publishStep({
      credentials,
      content: hello,
      key: "target-1",
      progress: {
        parts: [{ id: "1", url: null }],
        done: false,
        waitSeconds: 0,
        state: null,
      },
    });
    expect(progress.done).toBe(true);
    expect(sim.requests).toHaveLength(before);
  });

  it("refuses progress that it cannot read", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: hello,
        key: "target-1",
        progress: { parts: "none" } as never,
      }),
    );
    expect(error.kind).toBe("fail");
    expect(feed(sim.world)).toEqual([]);
  });

  it("fails for good when the post it replies to is gone", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: { parts: [{ text: "One" }, { text: "Two" }] },
        key: "target-1",
        progress: {
          parts: [{ id: "123", url: null }],
          done: false,
          waitSeconds: 0,
          state: null,
        },
      }),
    );
    expect(error).toMatchObject({ kind: "fail", status: 404 });
    expect(error.message).toBe(
      "mastodon.example refused the request: The post you are trying to reply to does not appear to exist.",
    );
  });
});

describe("reading a post", () => {
  it("gives the text back as it was written", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const text =
      '1 < 2 & "quotes"\nSecond line: https://example.com/a/path/that/is/longer/than/thirty/characters?x=1\n\nNew paragraph';
    const { parts } = await sim.provider.publishStep({
      credentials,
      content: { parts: [{ text }] },
      key: "target-1",
      progress: null,
    });
    expect(
      await sim.provider.readPost?.(credentials, parts[0]?.id ?? ""),
    ).toEqual({
      id: parts[0]?.id,
      url: parts[0]?.url,
      text,
      replyToId: null,
    });
  });

  it("finds no post under an ID that is none", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    expect(await sim.provider.readPost?.(credentials, "123")).toBeNull();
    // An ID cannot lead the request to another path.
    expect(
      await sim.provider.readPost?.(
        credentials,
        "../accounts/verify_credentials",
      ),
    ).toBeNull();
    expect(sim.paths().at(-1)).toBe(
      "GET /api/v1/statuses/..%2Faccounts%2Fverify_credentials",
    );
  });
});

describe("what an answer means", () => {
  /** Publishes against an instance that answers with `response`. */
  async function publishAgainst(response: () => Response) {
    const sim = setup();
    const { credentials } = await connect(sim);
    sim.hooks.intercept = response;
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: hello,
        key: "target-1",
        progress: null,
      }),
    );
    return { error, credentials };
  }

  it("quotes the instance when it refuses the content", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: { parts: [{ text: " " }] },
        key: "target-1",
        progress: null,
      }),
    );
    expect(error).toMatchObject({ kind: "fail", status: 422 });
    expect(error.message).toBe(
      "mastodon.example refused the request: Validation failed: Text can't be blank",
    );
  });

  it("reads when the limit starts over from Mastodon's header", async () => {
    const { error } = await publishAgainst(() =>
      Response.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "X-RateLimit-Reset": "2026-11-15T10:05:00.123456Z" },
        },
      ),
    );
    expect(error).toMatchObject({
      kind: "retry",
      status: 429,
      retryAt: new Date("2026-11-15T10:05:00.123Z"),
    });
  });

  it("reads Retry-After where there is no header of Mastodon's", async () => {
    const limited = await publishAgainst(
      () =>
        new Response("Slow down", {
          status: 429,
          headers: { "Retry-After": "90" },
        }),
    );
    expect(limited.error.retryAt).toEqual(new Date("2026-11-15T10:01:30Z"));
    const down = await publishAgainst(
      () =>
        new Response("<h1>Maintenance</h1>", {
          status: 503,
          headers: { "Retry-After": "600" },
        }),
    );
    expect(down.error).toMatchObject({
      kind: "retry",
      status: 503,
      retryAt: new Date("2026-11-15T10:10:00Z"),
    });
  });

  it("names no time when the instance names none", async () => {
    const { error } = await publishAgainst(
      () => new Response("Bad gateway", { status: 502 }),
    );
    expect(error).toMatchObject({ kind: "retry", retryAt: undefined });
    expect(error.message).toBe(
      "mastodon.example is having trouble (HTTP 502).",
    );
  });

  it("asks for a new connection when the token lacks a scope", async () => {
    const { error } = await publishAgainst(() =>
      Response.json(
        { error: "This action is outside the authorized scopes" },
        { status: 403 },
      ),
    );
    expect(error.kind).toBe("reconnect");
  });

  it("fails for good when the account itself is the trouble", async () => {
    // Connecting again would not help: the person has to see to the
    // account on Mastodon.
    const { error } = await publishAgainst(() =>
      Response.json(
        { error: "Your login is currently disabled" },
        { status: 403 },
      ),
    );
    expect(error.kind).toBe("fail");
    expect(error.message).toBe(
      "mastodon.example refused the request: Your login is currently disabled",
    );
  });

  it("fails for good when a success is not what Mastodon sends", async () => {
    const { error } = await publishAgainst(() => Response.json({ ok: true }));
    expect(error.kind).toBe("fail");
  });

  it("keeps the secrets of the request out of the message", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    // A server, or something in front of it, that repeats the request.
    sim.hooks.intercept = (request) =>
      Response.json(
        { error: `Rejected: ${request.headers.get("Authorization")}` },
        { status: 400 },
      );
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: hello,
        key: "target-1",
        progress: null,
      }),
    );
    expect(error.message).toBe(
      "mastodon.example refused the request: Rejected: Bearer [removed]",
    );

    sim.hooks.intercept = async (request) =>
      Response.json(
        { error: "invalid", error_description: await request.text() },
        { status: 400 },
      );
    const revoking = await failure(() => sim.provider.disconnect(credentials));
    expect(revoking.message).not.toContain(credentials.accessToken);
    expect(revoking.message).not.toContain(credentials.clientSecret);
  });

  it("keeps the code and the verifier out of the message", async () => {
    const sim = setup();
    const start = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const callback = await answerConsent(sim.simulator.fetch, start.url, {
      account: sim.ada.id,
    });
    sim.hooks.intercept = async (request) =>
      Response.json(
        { error: "invalid_request", error_description: await request.text() },
        { status: 400 },
      );
    const error = await failure(() =>
      sim.provider.completeConnect({
        pending: start.pending,
        params: callback.searchParams,
      }),
    );
    const { codeVerifier, clientSecret } = start.pending as Record<
      string,
      string
    >;
    for (const secret of [
      callback.searchParams.get("code") ?? "",
      codeVerifier ?? "",
      clientSecret ?? "",
    ]) {
      expect(secret).not.toBe("");
      expect(error.message).not.toContain(secret);
    }
  });
});

describe("disconnecting", () => {
  it("revokes the token with the registration it was issued to", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    // The stored registration has changed since.
    sim.apps.entries.clear();
    await sim.provider.disconnect(credentials);
    const form = new URLSearchParams(await sim.requests.at(-1)?.text());
    expect(Object.fromEntries(form)).toEqual({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      token: credentials.accessToken,
    });
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: hello,
        key: "target-1",
        progress: null,
      }),
    );
    expect(error.kind).toBe("reconnect");
  });
});
