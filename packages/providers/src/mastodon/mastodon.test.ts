import type { Fetch, PostContent } from "@pigy/core";
import { gifFile, pngFile } from "@pigy/core/test-images";
import {
  createMastodonSimulator,
  type Instance,
} from "@pigy/simulators/mastodon";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { memoryAppStore } from "../../test/mastodon-apps.ts";
import { ProviderError } from "../errors.ts";
import type { PublishProgress } from "../provider.ts";
import { type PublishRunner, publish } from "../publish.ts";
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

/** Whether `request` asks the instance to post a status. */
const posts = (request: Request) =>
  request.method === "POST" && request.url.endsWith("/api/v1/statuses");

/**
 * Publishes `content` step by step, the way a workflow does, and returns
 * the final progress. `from` is the progress to start from.
 */
function publishAll(
  { provider }: Setup,
  credentials: MastodonCredentials,
  content: PostContent,
  {
    key = "target-1",
    from = null as PublishProgress | null,
    files = new Map<string, Uint8Array>(),
    run = ((_name, step) => step()) as PublishRunner["run"],
  } = {},
) {
  return publish(
    provider,
    {
      credentials: async () => credentials,
      refresh: async () => {
        throw new Error("Mastodon has nothing to refresh");
      },
      content,
      key,
      media: {
        read: async (id) => {
          const file = files.get(id);
          if (!file) throw new Error(`The test has no image ${id}`);
          return file;
        },
        link: async () => {
          throw new Error("Mastodon takes bytes");
        },
      },
    },
    { run, sleep: async () => {} },
    from,
  );
}

/**
 * Posts a status as the account itself would, from an app of Mastodon's.
 * `more` is what the request says besides the text.
 */
async function postByHand(
  { simulator }: Setup,
  { accessToken }: MastodonCredentials,
  status: string,
  replyTo?: string,
  more: { visibility?: string } = {},
) {
  const response = await simulator.fetch(`https://${domain}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status, in_reply_to_id: replyTo, ...more }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

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
      // What the simulated instance says of media, as Mastodon ships.
      media: {
        maxImages: 4,
        maxImageBytes: 16_777_216,
        maxImagePixels: 33_177_600,
        imageTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        animated: true,
        maxAltLength: 1500,
        maxAspectRatio: null,
      },
    });
  });

  it("say nothing of media for an instance that says nothing of it, or that takes no JPEG", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    type Configuration = {
      statuses: { max_media_attachments?: number };
      media_attachments?: {
        supported_mime_types: string[];
        description_limit?: number;
      };
    };
    const without = async (change: (configuration: Configuration) => void) => {
      sim.hooks.intercept = async (request) => {
        if (!request.url.endsWith("/api/v2/instance")) return undefined;
        const instance = (await (
          await sim.simulator.fetch(request)
        ).json()) as {
          configuration: Configuration;
        };
        change(instance.configuration);
        return Response.json(instance);
      };
      return sim.provider.limits(credentials);
    };
    expect(
      await without((configuration) => {
        delete configuration.media_attachments;
      }),
    ).not.toHaveProperty("media");
    expect(
      await without((configuration) => {
        if (!configuration.media_attachments) throw new Error("No media");
        configuration.media_attachments.supported_mime_types = ["image/png"];
      }),
    ).not.toHaveProperty("media");
    // An older instance has no limit for a description: Mastodon's own.
    expect(
      await without((configuration) => {
        delete configuration.media_attachments?.description_limit;
        configuration.statuses.max_media_attachments = 2;
      }),
    ).toMatchObject({ media: { maxAltLength: 1500, maxImages: 2 } });
  });
});

describe("publishing images", () => {
  const image = (id: string, type: "image/png" | "image/gif", alt = "") => ({
    id,
    type,
    size: 100,
    width: 9,
    height: 7,
    alt,
  });

  it("uploads each image in a step of its own and notes its ID before the status is posted", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const files = new Map([
      ["one", await pngFile(9, 7)],
      ["two", await pngFile(9, 7)],
    ]);
    const steps: PublishProgress[] = [];
    await publishAll(
      sim,
      credentials,
      {
        parts: [
          {
            text: "With images",
            media: [
              image("one", "image/png", "First"),
              image("two", "image/png"),
            ],
          },
        ],
      },
      {
        files,
        run: async (_name, step) => {
          const progress = await step();
          steps.push(progress);
          return progress;
        },
      },
    );
    const noted = steps.map(
      ({ state }) =>
        (state as { media?: { ids: string[] } } | null)?.media?.ids.length ?? 0,
    );
    // The notes, an image, another image, the status: one request that
    // changes something in each.
    expect(noted).toEqual([0, 1, 2, 0]);
    expect(steps.map(({ parts }) => parts.length)).toEqual([0, 0, 0, 1]);
    const uploads = sim.paths().filter((path) => path === "POST /api/v2/media");
    expect(uploads).toHaveLength(2);
    expect(feed(sim.world)[0]?.post.images).toMatchObject([
      { alt: "First" },
      { alt: "" },
    ]);
  });

  it("waits for an instance that still works on a file, and posts when it is done", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const waits: number[] = [];
    await publishAll(
      sim,
      credentials,
      { parts: [{ text: "A GIF", media: [image("gif", "image/gif")] }] },
      {
        files: new Map([["gif", gifFile(9, 7, { frames: 2 })]]),
        run: async (_name, step) => {
          const progress = await step();
          waits.push(progress.waitSeconds);
          return progress;
        },
      },
    );
    // The simulated instance answers 202 for a GIF, and is done with it
    // by the second time it is asked: one step waits.
    expect(waits.filter((seconds) => seconds > 0)).toHaveLength(1);
    expect(feed(sim.world).map(({ post }) => post.images?.length)).toEqual([1]);
    // It never asked the instance to post what was not ready.
    expect(
      sim.paths().filter((path) => path === "POST /api/v1/statuses"),
    ).toHaveLength(1);
  });

  it("waits longer every time for an instance that goes on working on a file, and has the step tried again later after a while", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    let done = false;
    // The instance goes on saying that it works on the file.
    sim.hooks.intercept = async (request) => {
      if (
        done ||
        request.method !== "GET" ||
        !request.url.includes("/api/v1/media/")
      ) {
        return undefined;
      }
      const answer = await sim.simulator.fetch(request);
      return new Response(await answer.text(), {
        status: 206,
        headers: { "Content-Type": "application/json" },
      });
    };
    const content = {
      parts: [{ text: "A GIF", media: [image("gif", "image/gif")] }],
    };
    const files = new Map([["gif", gifFile(9, 7, { frames: 2 })]]);
    const waits: number[] = [];
    let last: PublishProgress | null = null;
    const error = await failure(() =>
      publishAll(sim, credentials, content, {
        files,
        run: async (_name, step) => {
          // Before, a step waited two seconds and asked again, for ever:
          // three steps of a workflow, a listing of statuses and a look at
          // the file every two seconds, until the instance's limit.
          if (waits.length > 40) throw new Error("The steps never end");
          last = await step();
          waits.push(last.waitSeconds);
          return last;
        },
      }),
    );
    expect(waits.filter((seconds) => seconds > 0)).toEqual([
      2, 5, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60,
    ]);
    // For the workflow to try again later, as it does for a network that
    // asks for that.
    expect(error).toMatchObject({
      kind: "retry",
      message: `${domain} is still working on an image of this post.`,
    });
    expect(
      sim.paths().filter((path) => path === "POST /api/v1/statuses"),
    ).toEqual([]);

    // Tried again, the step finds the file done, and posts.
    done = true;
    await publishAll(sim, credentials, content, { files, from: last });
    expect(feed(sim.world).map(({ post }) => post.images?.length)).toEqual([1]);
  });

  it("gives an upload more time than an answer, because the instance works on the file before it answers", async () => {
    const sim = setup({}, { timeoutMs: 100 });
    const { credentials } = await connect(sim);
    sim.hooks.intercept = async (request) => {
      if (request.method === "POST" && request.url.endsWith("/api/v2/media")) {
        // A quarter of a second, or until the adapter gives up, as a
        // `fetch` does when its signal says so.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(request.signal.reason);
          });
        });
      }
      return undefined;
    };
    await publishAll(
      sim,
      credentials,
      { parts: [{ text: "A photo", media: [image("one", "image/png")] }] },
      { files: new Map([["one", await pngFile(9, 7)]]) },
    );
    expect(feed(sim.world).map(({ post }) => post.images?.length)).toEqual([1]);
  });

  it("uploads again what the instance has dropped, when a delivery is taken up a day later", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const content = {
      parts: [{ text: "Late", media: [image("one", "image/png", "Kept")] }],
    };
    const files = new Map([["one", await pngFile(9, 7)]]);
    // The delivery stops after the upload: the status is refused once.
    sim.hooks.intercept = (request) =>
      posts(request)
        ? Response.json({ error: "Try later" }, { status: 422 })
        : undefined;
    let recorded: PublishProgress | null = null;
    await failure(() =>
      publishAll(sim, credentials, content, {
        files,
        run: async (_name, step) => {
          recorded = await step();
          return recorded;
        },
      }),
    );
    expect(recorded).toMatchObject({
      state: { media: { ids: [expect.any(String)] } },
    });

    // A day on, the instance has deleted the file that was in no status.
    sim.world.advance(24 * 60 * 60 * 1000);
    delete sim.hooks.intercept;
    const progress = await publishAll(sim, credentials, content, {
      files,
      from: recorded,
    });
    expect(progress.done).toBe(true);
    expect(feed(sim.world).map(({ post }) => post.images)).toMatchObject([
      [{ alt: "Kept" }],
    ]);
    expect(
      sim.paths().filter((path) => path === "POST /api/v2/media"),
    ).toHaveLength(2);
  });

  it("fails without a way to read the images", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const first = await sim.provider.publishStep({
      credentials,
      content: { parts: [{ text: "x", media: [image("one", "image/png")] }] },
      key: "k",
      progress: null,
    });
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: { parts: [{ text: "x", media: [image("one", "image/png")] }] },
        key: "k",
        progress: first,
      }),
    );
    expect(error.kind).toBe("fail");
  });
});

describe("publishing", () => {
  it("sends the text as it is, with the visibility that the account has set", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    await publishAll(sim, credentials, {
      parts: [{ text: "  Hello\n\nworld  " }],
    });
    const request = sim.requests.at(-1);
    expect(request?.headers.get("Authorization")).toBe(
      `Bearer ${credentials.accessToken}`,
    );
    expect(await request?.json()).toEqual({
      status: "  Hello\n\nworld  ",
      visibility: "public",
    });

    // The setting is the account's, not one of pigy's: another account
    // posts with another.
    const quiet = sim.simulator.addAccount(domain, "quiet", "Quiet", {
      privacy: "private",
    });
    const other = await connect({ ...sim, ada: quiet });
    await publishAll(sim, other.credentials, hello);
    expect(await sim.requests.at(-1)?.json()).toEqual({
      status: "Hello",
      visibility: "private",
    });
  });

  it("posts with the visibility it was made with", async () => {
    const sim = setup({}, { visibility: "direct" });
    const { credentials } = await connect(sim);
    await publishAll(sim, credentials, hello);
    expect(await sim.requests.at(-1)?.json()).toEqual({
      status: "Hello",
      visibility: "direct",
    });
  });

  it("keeps to one visibility for all parts, whatever the account sets meanwhile", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const content = { parts: [{ text: "One" }, { text: "Two" }] };
    let progress: PublishProgress | null = null;
    // The first step, and the one that posts the first part.
    for (let step = 0; step < 2; step++) {
      progress = await sim.provider.publishStep({
        credentials,
        content,
        key: "target-1",
        progress,
      });
    }
    // The person changes the setting in the middle of the thread. A step
    // that asked again would post the second part for followers only, and
    // would not find it again as a public one.
    sim.hooks.intercept = async (request) => {
      if (!request.url.endsWith("/verify_credentials")) return undefined;
      const account = (await (await sim.simulator.fetch(request)).json()) as {
        source: object;
      };
      return Response.json({
        ...account,
        source: { ...account.source, privacy: "private" },
      });
    };
    await publishAll(sim, credentials, content, { from: progress });
    expect(
      await Promise.all(
        sim.requests.filter(posts).map(async (request) => {
          const { visibility } = (await request.json()) as {
            visibility: string;
          };
          return visibility;
        }),
      ),
    ).toEqual(["public", "public"]);
  });

  it("keys every part of every delivery differently, and the same when a step is run again", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const content = { parts: [{ text: "One" }, { text: "Two" }] };
    const keys = () =>
      sim.requests
        .filter(posts)
        .map((request) => request.headers.get("Idempotency-Key"));

    // The instance is down for the first request to post, so the step that
    // made it is run again.
    sim.hooks.intercept = (request) =>
      posts(request) ? new Response("Bad gateway", { status: 502 }) : undefined;
    const down = await failure(() => publishAll(sim, credentials, content));
    expect(down.kind).toBe("retry");
    delete sim.hooks.intercept;
    await publishAll(sim, credentials, content);
    await publishAll(sim, credentials, content, { key: "target-2" });

    const [failed, one, two, otherOne, otherTwo] = keys();
    expect(one).toBe(failed);
    expect(new Set([one, two, otherOne, otherTwo]).size).toBe(4);
    // Whatever the caller's key, the header is one that can be sent.
    await publishAll(sim, credentials, hello, {
      key: "Schlüssel\n1 \u{1F511}",
    });
    expect(keys().at(-1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  it.each([
    [{ parts: "none" }],
    // Notes that are not its own, as another adapter might have left them.
    [{ parts: [], done: false, waitSeconds: 0, state: "prepared" }],
  ])("refuses progress that it cannot read: %j", async (progress) => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      sim.provider.publishStep({
        credentials,
        content: hello,
        key: "target-1",
        progress: progress as never,
      }),
    );
    expect(error.kind).toBe("fail");
    expect(feed(sim.world)).toEqual([]);
  });

  it("fails for good when the post it replies to is gone", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      publishAll(
        sim,
        credentials,
        { parts: [{ text: "One" }, { text: "Two" }] },
        {
          from: {
            parts: [{ id: "123", url: null }],
            done: false,
            waitSeconds: 0,
            state: null,
          },
        },
      ),
    );
    expect(error).toMatchObject({ kind: "fail", status: 404 });
    expect(error.message).toBe(
      "mastodon.example refused the request: The post you are trying to reply to does not appear to exist.",
    );
  });
});

describe("a step that may have posted already", () => {
  const twoHours = 2 * 60 * 60 * 1000;
  const texts = (sim: Setup) => feed(sim.world).map(({ post }) => post.text);

  /**
   * A post on its way, with the progress that is recorded for it. A step
   * that fails leaves the record as it was, so the next call runs the same
   * step again, the way a workflow does.
   */
  function delivery(
    sim: Setup,
    credentials: MastodonCredentials,
    content: PostContent,
  ) {
    let progress: PublishProgress | null = null;
    const step = async () => {
      progress = await sim.provider.publishStep({
        credentials,
        content,
        key: "target-1",
        progress,
      });
      return progress;
    };
    return {
      /** Runs one step. */
      step,
      /** Runs steps until one of them has published a part. */
      async part() {
        const before = progress?.parts.length ?? 0;
        for (let run = 0; run < 10; run++) {
          const next = await step();
          if (next.parts.length > before) return next;
        }
        throw new Error("Ten steps have published nothing");
      },
    };
  }

  /** Breaks the connection of the next request to post, before it arrives. */
  function loseNextRequest(sim: Setup) {
    sim.hooks.intercept = (request) => {
      if (!posts(request)) return undefined;
      delete sim.hooks.intercept;
      throw new TypeError("fetch failed");
    };
  }

  it("sends nothing in its first step, and notes where the account stands", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const requests = sim.requests.length;
    expect(await delivery(sim, credentials, hello).step()).toEqual({
      parts: [],
      done: false,
      waitSeconds: 0,
      // An account without a status has none to look after. The parts are
      // to be seen by whom the account has set. The instance has one name.
      state: {
        accountId: sim.ada.id,
        after: null,
        visibility: "public",
        ownDomains: [domain],
      },
    });
    // Three questions, and nothing that changes anything.
    expect(sim.paths().slice(requests)).toEqual([
      "GET /api/v1/accounts/verify_credentials",
      `GET /api/v1/accounts/${sim.ada.id}/statuses`,
      "GET /api/v2/instance",
    ]);

    await postByHand(sim, credentials, "The older one");
    const newest = await postByHand(sim, credentials, "The newest one");
    expect((await delivery(sim, credentials, hello).step()).state).toEqual({
      accountId: sim.ada.id,
      after: newest,
      visibility: "public",
      ownDomains: [domain],
    });
    expect(sim.requests.filter(posts)).toEqual([]);
  });

  it("takes the status that an earlier run posted, and posts no second", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(post.step)).kind).toBe("retry");
    // Long after Mastodon has forgotten the key of the first request.
    sim.world.advance(twoHours);

    const progress = await post.step();
    const [status] = feed(sim.world);
    expect(progress).toMatchObject({
      parts: [{ id: status?.post.id, url: status?.post.url }],
      done: true,
    });
    expect(texts(sim)).toEqual(["Hello"]);
    // It asked for the status, not for another one.
    expect(sim.requests.filter(posts)).toHaveLength(1);
  });

  it("finds a part whose mentions Mastodon has written its own way", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    sim.simulator.addInstance("other.example");
    sim.simulator.addAccount("other.example", "Bob");
    // Mastodon finds both accounts and writes them as they are written:
    // its own without the domain, the other with the capital letter. The
    // source of the status is then no longer the text that was sent.
    const post = delivery(sim, credentials, {
      parts: [{ text: `@ADA@${domain} and @bob@other.example, look` }],
    });
    await post.step();
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(post.step)).kind).toBe("retry");
    // Beyond the hour in which the key alone would have found the status.
    sim.world.advance(twoHours);

    const { parts } = await post.part();
    expect(texts(sim)).toEqual(["@ada and @Bob@other.example, look"]);
    expect(parts[0]?.id).toBe(feed(sim.world)[0]?.post.id);
    expect(sim.requests.filter(posts)).toHaveLength(1);
  });

  it("takes no status that mentions somebody else", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    sim.simulator.addAccount(domain, "bob");
    const post = delivery(sim, credentials, {
      parts: [{ text: "Thank you, @ada" }],
    });
    await post.step();
    // The case of a mention does not count when a status is looked for.
    // The name does.
    await postByHand(sim, credentials, "Thank you, @bob");

    expect((await post.part()).done).toBe(true);
    expect(texts(sim)).toEqual(["Thank you, @bob", "Thank you, @ada"]);
  });

  it("takes no status that mentions an account of the same name elsewhere", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    sim.simulator.addInstance("other.example");
    sim.simulator.addAccount("other.example", "ada");
    const post = delivery(sim, credentials, {
      parts: [{ text: `Thank you, @ada@${domain}` }],
    });
    await post.step();
    // The person writes to the Ada of another instance, in the same words.
    // That is another reader. Taken for the part, it would leave the part
    // unpublished and reported as done.
    await postByHand(sim, credentials, "Thank you, @ada@other.example");

    expect((await post.part()).done).toBe(true);
    expect(texts(sim)).toEqual([
      "Thank you, @ada@other.example",
      "Thank you, @ada",
    ]);
  });

  it("posts what never arrived", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    // To the adapter this looks the same as an answer that was lost.
    loseNextRequest(sim);
    expect((await failure(post.step)).kind).toBe("retry");
    sim.world.advance(twoHours);

    expect((await post.step()).done).toBe(true);
    expect(texts(sim)).toEqual(["Hello"]);
  });

  it("takes no status for the first part that differs in what it sends", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    // The same text, from before this post was begun.
    await postByHand(sim, credentials, "Hello");
    const post = delivery(sim, credentials, hello);
    await post.step();
    // Since then: another text, and the same text as a reply.
    const other = await postByHand(sim, credentials, "Something else");
    await postByHand(sim, credentials, "Hello", other);

    const { parts } = await post.part();
    expect(texts(sim)).toEqual(["Hello", "Something else", "Hello", "Hello"]);
    // The part is the status that this step posted, the last of them.
    expect(parts[0]?.id).toBe(feed(sim.world).at(-1)?.post.id);
  });

  it("takes a status that reads the same in the same place and is newer than the post", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    // The person has posted it by hand in the meantime. A second one next
    // to it would be a duplicate to everybody who reads it.
    const byHand = await postByHand(sim, credentials, " Hello\n");

    const { parts } = await post.part();
    expect(parts[0]?.id).toBe(byHand);
    expect(texts(sim)).toEqual(["Hello"]);
  });

  it("takes no status that other people see than the part is meant for", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    // The same text, for the account alone. Taking it for the part would
    // leave the post that everybody was to see unpublished.
    await postByHand(sim, credentials, "Hello", undefined, {
      visibility: "direct",
    });

    const { parts } = await post.part();
    expect(
      feed(sim.world).map(
        ({ post }) => (post as { visibility?: string }).visibility,
      ),
    ).toEqual(["direct", "public"]);
    expect(parts[0]?.id).toBe(feed(sim.world).at(-1)?.post.id);
  });

  it("finds the part of a limited account, which Mastodon has made unlisted", async () => {
    const sim = setup();
    // What such an account posts as public becomes unlisted. A step that
    // looked for a public status would never find its own.
    const limited = sim.simulator.addAccount(domain, "limited", "Limited", {
      limited: true,
    });
    const { credentials } = await connect({ ...sim, ada: limited });
    const post = delivery(sim, credentials, hello);
    expect((await post.step()).state).toMatchObject({ visibility: "unlisted" });
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(post.step)).kind).toBe("retry");
    sim.world.advance(twoHours);

    expect((await post.part()).done).toBe(true);
    expect(texts(sim)).toEqual(["Hello"]);
  });

  it.each([
    ["a content warning", { spoiler_text: "Careful" }],
    [
      "a picture",
      {
        media_attachments: [
          {
            id: "1",
            type: "image",
            url: "https://mastodon.example/media/1.png",
            description: null,
          },
        ],
      },
    ],
    [
      "a poll",
      {
        poll: {
          id: "1",
          expired: false,
          multiple: false,
          votes_count: 0,
          options: [
            { title: "Yes", votes_count: 0 },
            { title: "No", votes_count: 0 },
          ],
        },
      },
    ],
    ["a quote", { quote: { state: "accepted", quoted_status_id: "1" } }],
  ])(
    "takes no status with %s for a part that is text alone",
    async (_what, more) => {
      const sim = setup();
      const { credentials } = await connect(sim);
      const post = delivery(sim, credentials, hello);
      await post.step();
      const byHand = await postByHand(sim, credentials, "Hello");
      // The simulated Mastodon has none of these yet, so the status gets it
      // on the way from the instance: in the list, as Mastodon has it there.
      sim.hooks.intercept = async (request) => {
        if (!new URL(request.url).pathname.endsWith("/statuses"))
          return undefined;
        const response = await sim.simulator.fetch(request);
        if (request.method !== "GET" || !response.ok) return response;
        const statuses = (await response.json()) as { id: string }[];
        return Response.json(
          statuses.map((status) =>
            status.id === byHand ? { ...status, ...more } : status,
          ),
        );
      };

      // The same words, but not the same post: the part is posted.
      const { parts } = await post.part();
      expect(texts(sim)).toEqual(["Hello", "Hello"]);
      expect(parts[0]?.id).not.toBe(byHand);
    },
  );

  it("takes no reply that somebody wrote by hand for the next part of a thread", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, {
      parts: [{ text: "One" }, { text: "Two" }],
    });
    const one = (await post.part()).parts[0]?.id ?? "";
    await postByHand(sim, credentials, "A correction", one);

    const { parts, done } = await post.part();
    expect(done).toBe(true);
    expect(texts(sim)).toEqual(["One", "A correction", "Two"]);
    const two = feed(sim.world).at(-1)?.post;
    expect(parts[1]?.id).toBe(two?.id);
    expect(two?.replyToId).toBe(one);
  });

  it("looks through one list of statuses in a step, and goes on in the next", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    // One more than Mastodon lists at once.
    const since: string[] = [];
    for (let number = 1; number <= 41; number++) {
      since.push(
        await postByHand(sim, credentials, `Another status, number ${number}`),
      );
    }

    // The first forty are not the part. Nothing is posted yet: the part
    // may be behind them.
    expect(await post.step()).toEqual({
      parts: [],
      done: false,
      waitSeconds: 0,
      state: {
        accountId: sim.ada.id,
        after: since[39],
        visibility: "public",
        ownDomains: [domain],
      },
    });
    expect((await post.step()).state).toMatchObject({ after: since[40] });
    expect(sim.requests.filter(posts)).toEqual([]);
    // With nothing left to look at, the part is posted.
    expect((await post.step()).done).toBe(true);
    expect(texts(sim).at(-1)).toBe("Hello");
  });

  it("finds what it posted behind many statuses that are newer than the post", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    // The first request never arrives.
    loseNextRequest(sim);
    await failure(post.step);
    for (let number = 1; number <= 45; number++) {
      await postByHand(sim, credentials, `Another status, number ${number}`);
    }
    // The second arrives, behind all of those, and its answer is lost.
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(post.part)).kind).toBe("retry");
    sim.world.advance(twoHours);

    const requests = sim.requests.length;
    const { parts } = await post.step();
    expect(parts[0]?.id).toBe(feed(sim.world).at(-1)?.post.id);
    expect(texts(sim).filter((text) => text === "Hello")).toHaveLength(1);
    // It went on from where the steps before it had looked to, and did
    // not read the 45 again.
    expect(sim.paths().slice(requests)).toEqual([
      `GET /api/v1/accounts/${sim.ada.id}/statuses`,
      `GET /api/v1/statuses/${parts[0]?.id}/source`,
    ]);
  });

  it("goes on when a status is deleted while it looks", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const post = delivery(sim, credentials, hello);
    await post.step();
    await postByHand(sim, credentials, "Hello");
    // Listed a moment ago, and gone when its text is asked for.
    sim.hooks.intercept = (request) =>
      request.url.endsWith("/source")
        ? Response.json({ error: "Record not found" }, { status: 404 })
        : undefined;
    expect((await post.part()).done).toBe(true);
    expect(texts(sim)).toEqual(["Hello", "Hello"]);
  });

  it("tells what is newer by the length of an ID before its digits", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const byHand = await postByHand(sim, credentials, "Hello");
    // Mastodon's IDs are numbers of any length. This one is longer than
    // the "9" that the notes name, so it is the greater, though it sorts
    // before it as a string.
    expect(byHand.length).toBeGreaterThan(1);
    const progress = await sim.provider.publishStep({
      credentials,
      content: hello,
      key: "target-1",
      progress: {
        parts: [],
        done: false,
        waitSeconds: 0,
        state: {
          accountId: sim.ada.id,
          after: "9",
          visibility: "public",
          ownDomains: [domain],
        },
      },
    });
    expect(progress.parts[0]?.id).toBe(byHand);
    expect(texts(sim)).toEqual(["Hello"]);
  });

  it("takes nothing from before the post at a server that lists it all the same", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    // The same text, from before this post was begun. It is the newest
    // status then, so it is the one that the first step notes.
    await postByHand(sim, credentials, "Hello");
    const post = delivery(sim, credentials, hello);
    await post.step();
    await postByHand(sim, credentials, "Other");
    // A server that speaks Mastodon's API and does not know `min_id`: it
    // lists the newest statuses, whatever it is asked to begin after. So
    // its list holds the old "Hello" next to what is new.
    sim.hooks.intercept = (request) => {
      const url = new URL(request.url);
      if (!url.searchParams.has("min_id")) return undefined;
      url.searchParams.delete("min_id");
      return sim.simulator.fetch(new Request(url, request));
    };

    // The old status is not the part, and the same list is not taken for
    // news again and again: the part is posted.
    const { parts, done } = await post.part();
    expect(done).toBe(true);
    expect(texts(sim)).toEqual(["Hello", "Other", "Hello"]);
    expect(parts[0]?.id).toBe(feed(sim.world).at(-1)?.post.id);
  });
});

describe("reading a post", () => {
  it("gives the text back as it was written", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const text =
      '1 < 2 & "quotes"\nSecond line: https://example.com/a/path/that/is/longer/than/thirty/characters?x=1\n\nNew paragraph';
    const { parts } = await publishAll(sim, credentials, {
      parts: [{ text }],
    });
    expect(
      await sim.provider.readPost?.(credentials, parts[0]?.id ?? ""),
    ).toEqual({
      id: parts[0]?.id,
      url: parts[0]?.url,
      text,
      replyToId: null,
      images: [],
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
  /**
   * Publishes against an instance that answers the request to post with
   * `response`.
   */
  async function publishAgainst(response: () => Response) {
    const sim = setup();
    const { credentials } = await connect(sim);
    sim.hooks.intercept = (request) =>
      posts(request) ? response() : undefined;
    const error = await failure(() => publishAll(sim, credentials, hello));
    return { error, credentials };
  }

  it("quotes the instance when it refuses the content", async () => {
    const sim = setup();
    const { credentials } = await connect(sim);
    const error = await failure(() =>
      publishAll(sim, credentials, { parts: [{ text: " " }] }),
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

  it("keeps the secrets of the connection out of what it quotes from a callback", async () => {
    const sim = setup();
    const start = await sim.provider.beginConnect({
      redirectUri,
      identifier: domain,
    });
    const { codeVerifier = "", clientSecret = "" } = start.pending as Record<
      string,
      string
    >;
    // A code that is good, in a callback that reports an error all the
    // same: no server sends that, but the callback is whatever address the
    // browser was sent to.
    const callback = await answerConsent(sim.simulator.fetch, start.url, {
      account: sim.ada.id,
    });
    const code = callback.searchParams.get("code") ?? "";
    const error = await failure(() =>
      sim.provider.completeConnect({
        pending: start.pending,
        params: new URLSearchParams({
          state: start.state,
          code,
          error: "server_error",
          error_description: `Failed for ${clientSecret} with ${code} and ${codeVerifier} in ${start.state}`,
        }),
      }),
    );
    // The test would prove nothing with a secret that is empty.
    for (const secret of [clientSecret, code, codeVerifier, start.state]) {
      expect(secret).not.toBe("");
    }
    expect(error.message).toBe(
      "mastodon.example did not connect the account: Failed for [removed] with [removed] and [removed] in [removed]",
    );
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
