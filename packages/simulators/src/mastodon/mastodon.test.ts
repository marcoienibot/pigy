import { createHash } from "node:crypto";
import { gifFile, jpegFile, pngFile } from "@pigy/core/test-images";
import { describe, expect, it } from "vitest";
import {
  answerConsent,
  createWorld,
  entitiesOf,
  feed,
  isSimulatedSecret,
  memoryStorage,
  simulationNotice,
} from "../world/index.ts";
import { createMastodonSimulator, type Instance } from "./index.ts";

const domain = "mastodon.example";
const origin = `https://${domain}`;
const redirectUri = "https://app.example/connect/mastodon/callback";
const scopes = "profile read:statuses write:statuses write:media";

// A verifier and the challenge made from it, with the S256 method.
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

/** A world with one instance and one account, at a time that stands still. */
function setup(instance: Partial<Omit<Instance, "domain">> = {}) {
  const storage = memoryStorage();
  const world = createWorld({
    storage,
    now: () => new Date("2026-11-15T10:00:00Z"),
  });
  const simulator = createMastodonSimulator(world);
  simulator.addInstance(domain, instance);
  const ada = simulator.addAccount(domain, "ada", "Ada Lovelace");
  return { storage, world, simulator, ada };
}

type Sim = ReturnType<typeof setup>;

function post(
  { simulator }: Sim,
  path: string,
  body: Record<string, unknown> | URLSearchParams,
  headers: Record<string, string> = {},
) {
  return simulator.fetch(origin + path, {
    method: "POST",
    headers: {
      ...(body instanceof URLSearchParams
        ? {}
        : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body instanceof URLSearchParams ? body : JSON.stringify(body),
  });
}

async function register(sim: Sim, overrides: Record<string, unknown> = {}) {
  const response = await post(sim, "/api/v1/apps", {
    client_name: "pigy",
    redirect_uris: redirectUri,
    scopes,
    website: "https://app.example",
    ...overrides,
  });
  return {
    response,
    app: (await response.clone().json()) as {
      client_id: string;
      client_secret: string;
    },
  };
}

function authorizationUrl(
  clientId: string,
  overrides: Record<string, string | null> = {},
) {
  const url = new URL(`${origin}/oauth/authorize`);
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

function tokenRequest(
  sim: Sim,
  app: { client_id: string; client_secret: string },
  code: string | null,
  overrides: Record<string, string | null> = {},
) {
  const form = new URLSearchParams();
  const params: Record<string, string | null> = {
    grant_type: "authorization_code",
    code,
    client_id: app.client_id,
    client_secret: app.client_secret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) form.set(name, value);
  }
  return post(sim, "/oauth/token", form);
}

/**
 * Registers a client and connects an account, Ada's unless another is
 * named. Returns its token.
 */
async function connect(sim: Sim, scope = scopes, account = sim.ada.id) {
  const { app } = await register(sim);
  const callback = await answerConsent(
    sim.simulator.fetch,
    authorizationUrl(app.client_id, { scope }),
    { account },
  );
  const response = await tokenRequest(
    sim,
    app,
    callback.searchParams.get("code"),
  );
  expect(response.status).toBe(200);
  const { access_token: token } = (await response.json()) as {
    access_token: string;
  };
  return { app, token };
}

function api(
  { simulator }: Sim,
  method: string,
  path: string,
  token?: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return simulator.fetch(origin + path, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

async function publish(
  sim: Sim,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await api(
    sim,
    "POST",
    "/api/v1/statuses",
    token,
    body,
    headers,
  );
  return { response, status: (await response.clone().json()) as StatusJson };
}

type StatusJson = {
  id: string;
  url: string;
  content: string;
  visibility: string;
  in_reply_to_id: string | null;
  mentions: unknown[];
  tags: unknown[];
  card: unknown;
  error?: string;
};

describe("the hosts it answers for", () => {
  it("fails like an unreachable host for every other host", async () => {
    const { simulator } = setup();
    await expect(
      simulator.fetch("https://mastodon.social/api/v2/instance"),
    ).rejects.toThrow(TypeError);
    // An instance is reached over HTTPS, at the default port.
    await expect(
      simulator.fetch(`http://${domain}/api/v2/instance`),
    ).rejects.toThrow(TypeError);
    await expect(
      simulator.fetch(`https://${domain}:8443/api/v2/instance`),
    ).rejects.toThrow(TypeError);
  });

  it("says which hosts are its own", () => {
    const { simulator } = setup();
    simulator.addInstance("social.test");
    expect(simulator.owns(domain)).toBe(true);
    expect(simulator.owns("social.test")).toBe(true);
    // The hosts that `fetch` fails for, above.
    expect(simulator.owns("mastodon.social")).toBe(false);
    expect(simulator.owns(`${domain}:8443`)).toBe(false);
    // No part of a domain, and nothing that is in the world under
    // another kind of key.
    expect(simulator.owns("example")).toBe(false);
    expect(simulator.owns("")).toBe(false);
  });

  it("has only instances with names that cannot exist", () => {
    const { simulator } = setup();
    // A simulated instance must never be taken for a real server.
    expect(() => simulator.addInstance("mastodon.social")).toThrow(
      ".example, .test or .invalid",
    );
    expect(() => simulator.addInstance("example")).toThrow();
    expect(() => simulator.addInstance("Mastodon.Example")).toThrow();
    simulator.addInstance("social.test");
  });

  it("answers 404 for what Mastodon does not have", async () => {
    const sim = setup();
    expect((await api(sim, "GET", "/api/v1/nothing")).status).toBe(404);
  });
});

describe("the instance", () => {
  it("tells its limits", async () => {
    const sim = setup({ maxCharacters: 1000, charactersReservedPerUrl: 30 });
    const response = await api(sim, "GET", "/api/v2/instance");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      domain,
      configuration: {
        statuses: { max_characters: 1000, characters_reserved_per_url: 30 },
      },
    });
  });

  it("describes its OAuth from 4.3 on", async () => {
    const response = await api(
      setup(),
      "GET",
      "/.well-known/oauth-authorization-server",
    );
    expect(await response.json()).toMatchObject({
      code_challenge_methods_supported: ["S256"],
      scopes_supported: expect.arrayContaining(["profile", "write:statuses"]),
    });

    const older = await api(
      setup({ version: "4.2.10" }),
      "GET",
      "/.well-known/oauth-authorization-server",
    );
    expect(older.status).toBe(404);
  });
});

describe("registering a client", () => {
  it("gives out an ID and a secret that say they are simulated", async () => {
    const { response, app } = await register(setup());
    expect(response.status).toBe(200);
    expect(isSimulatedSecret(app.client_id)).toBe(true);
    expect(isSimulatedSecret(app.client_secret)).toBe(true);
    expect(await response.json()).toMatchObject({
      name: "pigy",
      scopes: scopes.split(" "),
      redirect_uris: [redirectUri],
    });
  });

  it("takes the parameters as a form too", async () => {
    const response = await post(
      setup(),
      "/api/v1/apps",
      new URLSearchParams({ client_name: "pigy", redirect_uris: redirectUri }),
    );
    // Without scopes, a client gets the default one.
    expect(await response.json()).toMatchObject({ scopes: ["read"] });
  });

  it.each([
    [{ client_name: null }, "Name can't be blank"],
    [{ client_name: "x".repeat(61) }, "Name is too long"],
    [{ redirect_uris: null }, "Redirect URI can't be blank"],
    [{ redirect_uris: "/callback" }, "Redirect URI must be an absolute URI."],
    [
      { redirect_uris: "https://app.example/cb#x" },
      "Redirect URI cannot contain a fragment.",
    ],
    [
      { redirect_uris: "javascript:alert(1)" },
      "Redirect URI is forbidden by the server.",
    ],
    [{ scopes: "read everything" }, "Scopes doesn't match"],
    [{ website: "not a url" }, "Website is not a valid URL"],
  ])("refuses %j", async (overrides, message) => {
    const { response } = await register(setup(), overrides);
    expect(response.status).toBe(422);
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/^Validation failed: /);
    expect(error).toContain(message);
  });

  it("knows the profile scope from 4.3 on only", async () => {
    const { response } = await register(setup({ version: "4.2.10" }));
    expect(response.status).toBe(422);
  });

  it("takes a list of redirect addresses from 4.3 on only", async () => {
    const list = { redirect_uris: [redirectUri, "https://app.example/other"] };
    expect((await register(setup(), list)).response.status).toBe(200);
    const older = await register(setup({ version: "4.2.10" }), {
      ...list,
      scopes: "read",
    });
    expect(older.response.status).toBe(422);
  });
});

describe("the consent page", () => {
  it("is marked as a simulation and offers the accounts of the instance", async () => {
    const sim = setup();
    sim.simulator.addInstance("other.example");
    sim.simulator.addAccount("other.example", "eve");
    const { app } = await register(sim);
    const response = await sim.simulator.fetch(authorizationUrl(app.client_id));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(simulationNotice);
    expect(page).toContain("@ada@mastodon.example");
    // An account of another instance cannot be signed in to here.
    expect(page).not.toContain("eve");
    // The person is told who asks and for what.
    expect(page).toContain("pigy wants to use your account");
    expect(page).toContain("write:statuses");
  });

  it.each([
    [{ client_id: "pigy-sim-unknown" }, 401, "unknown client"],
    [
      { client_id: "TWhM-tNSuncnqN7DBJmoyeLnk6K3iJJ71KKXxgL1hPM" },
      401,
      "unknown client",
    ],
    [{ redirect_uri: "https://evil.example/cb" }, 400, "redirect uri"],
    [{ redirect_uri: null }, 400, "redirect uri"],
    [{ response_type: "token" }, 400, "response type"],
    [{ scope: "write" }, 400, "scope"],
    // Without a scope, "read" is asked for, which this client has not
    // registered.
    [{ scope: null }, 400, "scope"],
    [{ code_challenge_method: "plain" }, 400, "S256"],
    [{ code_challenge_method: null }, 400, "S256"],
  ])(
    "shows an error instead of redirecting for %j",
    async (overrides, status, message) => {
      const sim = setup();
      const { app } = await register(sim);
      const response = await sim.simulator.fetch(
        authorizationUrl(app.client_id, overrides),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain(message);
    },
  );

  it("sends a refusal back with the state", async () => {
    const sim = setup();
    const { app } = await register(sim);
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id),
      "deny",
    );
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("signs in to an account of this instance only", async () => {
    const sim = setup();
    sim.simulator.addInstance("other.example");
    const eve = sim.simulator.addAccount("other.example", "eve");
    const { app } = await register(sim);
    await expect(
      answerConsent(sim.simulator.fetch, authorizationUrl(app.client_id), {
        account: eve.id,
      }),
    ).rejects.toThrow("answered 400");
  });
});

describe("exchanging a code", () => {
  /** A registered client and a code for it that Ada consented to. */
  async function consented(
    sim: Sim,
    overrides: Record<string, string | null> = {},
  ) {
    const { app } = await register(sim);
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id, overrides),
      { account: sim.ada.id },
    );
    return { app, code: callback.searchParams.get("code") };
  }

  it("gives a token that says it is simulated and names the scopes", async () => {
    const sim = setup();
    const { app, code } = await consented(sim);
    const response = await tokenRequest(sim, app, code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", scope: scopes });
    expect(isSimulatedSecret(body.access_token as string)).toBe(true);
    // Mastodon's tokens do not expire, and say nothing of an expiry.
    expect(body).not.toHaveProperty("expires_in");
  });

  it("accepts the client's secret in an Authorization header", async () => {
    const sim = setup();
    const { app, code } = await consented(sim);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const response = await post(sim, "/oauth/token", form, {
      Authorization: `Basic ${btoa(`${app.client_id}:${app.client_secret}`)}`,
    });
    expect(response.status).toBe(200);
  });

  it.each([
    [{ client_secret: "pigy-sim-wrong" }, 401, "invalid_client"],
    [{ client_id: "pigy-sim-unknown" }, 401, "invalid_client"],
    [{ code: "pigy-sim-unknown" }, 400, "invalid_grant"],
    [{ redirect_uri: "https://app.example/other" }, 400, "invalid_grant"],
    [{ redirect_uri: null }, 400, "invalid_request"],
    [{ code_verifier: "b".repeat(43) }, 400, "invalid_grant"],
    [{ code_verifier: null }, 400, "invalid_request"],
    [{ grant_type: "password" }, 400, "unsupported_grant_type"],
    [{ grant_type: null }, 400, "invalid_request"],
  ])("refuses %j", async (overrides, status, error) => {
    const sim = setup();
    const { app, code } = await consented(sim);
    const response = await tokenRequest(sim, app, code, overrides);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    // A request that was refused has not used the code up.
    expect((await tokenRequest(sim, app, code)).status).toBe(200);
  });

  it("refuses a verifier for a code that was asked for without a challenge", async () => {
    const sim = setup();
    const { app, code } = await consented(sim, {
      code_challenge: null,
      code_challenge_method: null,
    });
    expect((await tokenRequest(sim, app, code)).status).toBe(400);
    expect(
      (await tokenRequest(sim, app, code, { code_verifier: null })).status,
    ).toBe(200);
  });

  it("accepts a code once", async () => {
    const sim = setup();
    const { app, code } = await consented(sim);
    expect((await tokenRequest(sim, app, code)).status).toBe(200);
    const second = await tokenRequest(sim, app, code);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("accepts a code once, also from two requests at the same time", async () => {
    const sim = setup();
    const { app, code } = await consented(sim);
    // Both are on their way before either is answered. Checking the
    // verifier takes a moment, in which the other request gets its turn.
    const responses = await Promise.all([
      tokenRequest(sim, app, code),
      tokenRequest(sim, app, code),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
    const refused = responses.find(({ status }) => status === 400);
    expect(await refused?.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("accepts a code for ten minutes", async () => {
    const sim = setup();
    const { app, code } = await consented(sim);
    sim.world.advance(10 * 60 * 1000);
    expect((await tokenRequest(sim, app, code)).status).toBe(400);
  });

  it("refuses the code of another client", async () => {
    const sim = setup();
    const { code } = await consented(sim);
    const { app: other } = await register(sim);
    expect((await tokenRequest(sim, other, code)).status).toBe(400);
  });

  it("ignores PKCE before 4.3", async () => {
    const sim = setup({ version: "4.2.10" });
    const { app } = await register(sim, { scopes: "read:accounts" });
    const callback = await answerConsent(
      sim.simulator.fetch,
      // A method that 4.3 would refuse is not even looked at.
      authorizationUrl(app.client_id, {
        scope: "read:accounts",
        code_challenge_method: "plain",
      }),
      { account: sim.ada.id },
    );
    const response = await tokenRequest(
      sim,
      app,
      callback.searchParams.get("code"),
      { code_verifier: null },
    );
    expect(response.status).toBe(200);
  });

  it("gives the same token for the same client, account and scopes", async () => {
    const sim = setup();
    const { app, token } = await connect(sim);
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id),
      { account: sim.ada.id },
    );
    const again = await tokenRequest(
      sim,
      app,
      callback.searchParams.get("code"),
    );
    expect(await again.json()).toMatchObject({ access_token: token });
  });
});

describe("a token of the client's own", () => {
  it("is given for a scope that the client registered", async () => {
    const sim = setup();
    const { app } = await register(sim);
    const response = await tokenRequest(sim, app, null, {
      grant_type: "client_credentials",
      scope: "read:statuses",
    });
    expect(response.status).toBe(200);
    const { access_token: token } = (await response.json()) as {
      access_token: string;
    };
    // It stands for no account, so it cannot do what takes one.
    const refused = await api(sim, "POST", "/api/v1/statuses", token, {
      status: "Hello",
    });
    expect(refused.status).toBe(403);
  });

  it("is refused for a scope that the client did not register", async () => {
    const sim = setup();
    const { app } = await register(sim);
    // Without a scope, "read" is asked for.
    for (const scope of [null, "write"]) {
      const response = await tokenRequest(sim, app, null, {
        grant_type: "client_credentials",
        scope,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_scope" });
    }
  });

  it("is refused to a client that the instance does not know", async () => {
    const sim = setup();
    const response = await tokenRequest(
      sim,
      { client_id: "pigy-sim-gone", client_secret: "pigy-sim-gone" },
      null,
      { grant_type: "client_credentials", scope: "read:statuses" },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("revoking a token", () => {
  const revoke = (sim: Sim, params: Record<string, string>) =>
    post(sim, "/oauth/revoke", new URLSearchParams(params));

  it("ends the token, and is fine to repeat", async () => {
    const sim = setup();
    const { app, token } = await connect(sim);
    const params = {
      client_id: app.client_id,
      client_secret: app.client_secret,
      token,
    };
    expect((await revoke(sim, params)).status).toBe(200);
    const refused = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      token,
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "The access token was revoked",
    });
    expect((await revoke(sim, params)).status).toBe(200);
  });

  it("is refused to a client that the token was not issued to", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { app: other } = await register(sim);
    const response = await revoke(sim, {
      client_id: other.client_id,
      client_secret: other.client_secret,
      token,
    });
    expect(response.status).toBe(403);
    // The token is still good.
    expect(
      (await api(sim, "GET", "/api/v1/accounts/verify_credentials", token))
        .status,
    ).toBe(200);
  });

  it("is refused without a token", async () => {
    const sim = setup();
    const { app } = await connect(sim);
    const response = await revoke(sim, {
      client_id: app.client_id,
      client_secret: app.client_secret,
    });
    expect(response.status).toBe(403);
  });
});

describe("access to the API", () => {
  it("says whose token it is", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const response = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      token,
    );
    expect(await response.json()).toMatchObject({
      id: sim.ada.id,
      username: "ada",
      acct: "ada",
      display_name: "Ada Lovelace",
      url: "https://mastodon.example/@ada",
    });
  });

  it.each([
    [undefined, "The access token is invalid"],
    ["pigy-sim-unknown", "The access token is invalid"],
    // A real token, which the simulation must never accept.
    [
      "ZA-Yj3aBD8U8Cm7lKUp-lm9O9BmDgdhHzDeqsY8tlL0",
      "The access token is invalid",
    ],
  ])("refuses the token %s", async (token, error) => {
    const sim = setup();
    await connect(sim);
    for (const [method, path] of [
      ["GET", "/api/v1/accounts/verify_credentials"],
      ["POST", "/api/v1/statuses"],
      ["DELETE", "/api/v1/statuses/1"],
    ] as const) {
      const response = await api(sim, method, path, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("refuses a token of another instance", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.addInstance("other.example");
    const response = await sim.simulator.fetch(
      "https://other.example/api/v1/accounts/verify_credentials",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(401);
  });

  it("refuses what is outside the scopes of the token", async () => {
    const sim = setup();
    const { token } = await connect(sim, "profile read:statuses");
    const response = await api(sim, "POST", "/api/v1/statuses", token, {
      status: "Hello",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This action is outside the authorized scopes",
    });
    // What the scopes cover works.
    expect(
      (await api(sim, "GET", "/api/v1/accounts/verify_credentials", token))
        .status,
    ).toBe(200);
  });

  it("does not look at a token where none is needed", async () => {
    const sim = setup();
    const response = await api(
      sim,
      "GET",
      "/api/v2/instance",
      "pigy-sim-unknown",
    );
    expect(response.status).toBe(200);
  });
});

describe("posting a status", () => {
  it("posts the text and returns the status", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response, status } = await publish(sim, token, {
      status: "Hello, world",
    });
    expect(response.status).toBe(200);
    expect(status).toMatchObject({
      content: "<p>Hello, world</p>",
      // The default of an account.
      visibility: "public",
      in_reply_to_id: null,
      url: `https://mastodon.example/@ada/${status.id}`,
      application: { name: "pigy", website: "https://app.example" },
      account: { username: "ada" },
    });
    expect(feed(sim.world).map(({ post }) => post.text)).toEqual([
      "Hello, world",
    ]);
  });

  it("takes the parameters as a form too", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const response = await post(
      sim,
      "/api/v1/statuses",
      new URLSearchParams({ status: "Hello", visibility: "unlisted" }),
      { Authorization: `Bearer ${token}` },
    );
    expect(await response.json()).toMatchObject({ visibility: "unlisted" });
  });

  it("posts with the visibility that the account has set, unless the request names one", async () => {
    const sim = setup();
    const quiet = sim.simulator.addAccount(domain, "quiet", "Quiet", {
      privacy: "private",
    });
    const { token } = await connect(sim, scopes, quiet.id);
    const account = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      token,
    );
    // This is where a client reads the setting.
    expect(await account.json()).toMatchObject({
      source: { privacy: "private" },
    });
    expect((await publish(sim, token, { status: "One" })).status).toMatchObject(
      { visibility: "private" },
    );
    expect(
      (await publish(sim, token, { status: "Two", visibility: "public" }))
        .status,
    ).toMatchObject({ visibility: "public" });
  });

  it("makes unlisted of what a limited account posts as public", async () => {
    const sim = setup();
    const limited = sim.simulator.addAccount(domain, "limited", "Limited", {
      limited: true,
    });
    const { token } = await connect(sim, scopes, limited.id);
    const account = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      token,
    );
    expect(await account.json()).toMatchObject({ limited: true });
    // By its setting, which is "public", and by the request alike.
    for (const body of [
      { status: "One" },
      { status: "Two", visibility: "public" },
    ]) {
      expect((await publish(sim, token, body)).status).toMatchObject({
        visibility: "unlisted",
      });
    }
    // Any other visibility stays what it is.
    expect(
      (await publish(sim, token, { status: "Three", visibility: "private" }))
        .status,
    ).toMatchObject({ visibility: "private" });
    // An account that is not limited does not say so.
    const ada = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      (await connect(sim)).token,
    );
    expect(await ada.json()).not.toHaveProperty("limited");
  });

  it("stores the text without the whitespace around it", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    await publish(sim, token, { status: "  Hello \n" });
    expect(feed(sim.world)[0]?.post.text).toBe("Hello");
  });

  it("writes a mention the way the account that it finds is written", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.addInstance("other.example");
    sim.simulator.addAccount("other.example", "Bob");
    const saved = async (status: string) => {
      const { status: made } = await publish(sim, token, { status });
      const source = await api(
        sim,
        "GET",
        `/api/v1/statuses/${made.id}/source`,
        token,
      );
      return ((await source.json()) as { text: string }).text;
    };

    // One of the instance's own loses its domain. Case does not matter in
    // finding it, and it is written as the account has it.
    expect(await saved("@ADA@Mastodon.Example and @Ada!")).toBe(
      "@ada and @ada!",
    );
    // One from elsewhere keeps the domain, as the account has it.
    expect(await saved("Hi @bob@OTHER.example.")).toBe(
      "Hi @Bob@other.example.",
    );
    // Bob is not of this instance, and nobody is of either.
    const unknown = "@bob @nobody@mastodon.example @ada@elsewhere.example";
    expect(await saved(unknown)).toBe(unknown);
    // No mentions: an address, the end of a path and of a parameter.
    const none = "mail@ADA https://example.com/@ADA ?to=@ADA";
    expect(await saved(none)).toBe(none);
  });

  it("says of a status whom it mentions, which tags it has, and what its first link leads to", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.addInstance("other.example");
    const bob = sim.simulator.addAccount("other.example", "Bob");
    const { status } = await publish(sim, token, {
      status:
        "@bob@other.example and @nobody: https://example.test/ and https://blog.example.test/first-post #News #news",
    });
    expect(status.mentions).toEqual([
      {
        id: bob.id,
        username: "Bob",
        acct: "Bob@other.example",
        url: "https://other.example/@Bob",
      },
    ]);
    // A tag once, in lower case, however it was written.
    expect(status.tags).toEqual([
      { name: "news", url: "https://mastodon.example/tags/news" },
    ]);
    // The card is of the first link, with what the page says of itself.
    expect(status.card).toMatchObject({
      url: "https://example.test/",
      title: "The example page",
      type: "link",
    });
    // And the feed of the world has the same, for a person to look at.
    const kept = feed(sim.world)[0]?.post;
    expect(kept && entitiesOf(kept)).toEqual([
      ["mention", "@Bob@other.example", bob.id],
      ["link", "https://example.test/", "https://example.test/"],
      [
        "link",
        "https://blog.example.test/first-post",
        "https://blog.example.test/first-post",
      ],
      ["hashtag", "#News", "News"],
      ["hashtag", "#news", "news"],
    ]);
    expect(kept?.card?.title).toBe("The example page");
  });

  it("has no card for a link that leads to no page of its world", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { status } = await publish(sim, token, {
      status: "https://example.com/somewhere",
    });
    expect(status.card).toBeNull();
  });

  it.each([
    [{}, "Validation failed: Text can't be blank"],
    [{ status: " \n " }, "Validation failed: Text can't be blank"],
    [
      { status: "a".repeat(501) },
      "Validation failed: Text character limit of 500 exceeded",
    ],
    [
      { status: "Hello", visibility: "everyone" },
      "Validation failed: Visibility is not included in the list",
    ],
  ])("refuses %j", async (body, error) => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response, status } = await publish(sim, token, body);
    expect(response.status).toBe(422);
    expect(status.error).toBe(error);
    expect(feed(sim.world)).toEqual([]);
  });

  it("refuses what it does not simulate, rather than ignore it", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response } = await publish(sim, token, {
      status: "Hello",
      media_ids: ["1"],
    });
    expect(response.status).toBe(422);
  });

  it("counts against the limit of the instance, the way Mastodon counts", async () => {
    const sim = setup({ maxCharacters: 30 });
    const { token } = await connect(sim);
    // 30 characters as they are counted: 7 and a link, which counts as 23
    // however long it is.
    const link = `https://example.com/${"a".repeat(80)}`;
    expect(
      (await publish(sim, token, { status: `Read ${link}!!` })).response.status,
    ).toBe(200);
    expect(
      (await publish(sim, token, { status: `Read ${link}!!!` })).response
        .status,
    ).toBe(422);
    // 30 emoji are 60 UTF-16 code units and 30 characters.
    expect(
      (await publish(sim, token, { status: "😀".repeat(30) })).response.status,
    ).toBe(200);
    expect(
      (await publish(sim, token, { status: "😀".repeat(31) })).response.status,
    ).toBe(422);
    // A mention counts without its domain.
    expect(
      (
        await publish(sim, token, {
          status: `${"a".repeat(25)} @bob@other.example`,
        })
      ).response.status,
    ).toBe(200);
  });

  it("counts a mention in full when its domain is too long to be one", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    // With its domain left out this would be two characters. Mastodon takes
    // it for plain text, which is over the 500 of the instance.
    const { response, status } = await publish(sim, token, {
      status: `@a@${"b".repeat(501)}`,
    });
    expect(response.status).toBe(422);
    expect(status.error).toBe(
      "Validation failed: Text character limit of 500 exceeded",
    );
    expect(feed(sim.world)).toEqual([]);
    // With the longest domain that a mention can have, it counts as "@a":
    // 497 letters, a space and those two are exactly 500.
    expect(
      (
        await publish(sim, token, {
          status: `${"c".repeat(497)} @a@${"b".repeat(253)}`,
        })
      ).response.status,
    ).toBe(200);
  });

  it("answers a repeated idempotency key with the status it made", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const key = { "Idempotency-Key": "key-1" };
    const first = await publish(sim, token, { status: "Once" }, key);
    // Even with another text: the key decides.
    const second = await publish(sim, token, { status: "Twice" }, key);
    expect(second.response.status).toBe(200);
    expect(second.status.id).toBe(first.status.id);
    expect(feed(sim.world)).toHaveLength(1);

    // Another key, or none, makes another status.
    await publish(
      sim,
      token,
      { status: "Once" },
      { "Idempotency-Key": "key-2" },
    );
    await publish(sim, token, { status: "Once" });
    expect(feed(sim.world)).toHaveLength(3);
  });

  it("forgets an idempotency key after an hour", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const key = { "Idempotency-Key": "key-1" };
    const first = await publish(sim, token, { status: "Once" }, key);
    sim.world.advance(60 * 60 * 1000 - 1);
    expect((await publish(sim, token, { status: "Once" }, key)).status.id).toBe(
      first.status.id,
    );
    sim.world.advance(1);
    expect(
      (await publish(sim, token, { status: "Once" }, key)).status.id,
    ).not.toBe(first.status.id);
  });

  it("keeps the idempotency keys of accounts apart", async () => {
    const sim = setup();
    const { app, token } = await connect(sim);
    const bob = sim.simulator.addAccount(domain, "bob");
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id),
      { account: bob.id },
    );
    const { access_token: bobToken } = (await (
      await tokenRequest(sim, app, callback.searchParams.get("code"))
    ).json()) as { access_token: string };
    const key = { "Idempotency-Key": "key-1" };
    const first = await publish(sim, token, { status: "Mine" }, key);
    const second = await publish(sim, bobToken, { status: "Mine" }, key);
    expect(second.status.id).not.toBe(first.status.id);
  });

  it("posts a reply to a status that exists", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const first = await publish(sim, token, { status: "One" });
    const second = await publish(sim, token, {
      status: "Two",
      in_reply_to_id: first.status.id,
    });
    expect(second.status.in_reply_to_id).toBe(first.status.id);

    const missing = await publish(sim, token, {
      status: "Three",
      in_reply_to_id: "123",
    });
    expect(missing.response.status).toBe(404);
    expect(missing.status.error).toBe(
      "The post you are trying to reply to does not appear to exist.",
    );
  });

  it("gives every status a larger ID than the one before", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const first = await publish(sim, token, { status: "One" });
    const second = await publish(sim, token, { status: "Two" });
    // IDs are numbers in text: clients compare them as numbers.
    expect(BigInt(second.status.id) > BigInt(first.status.id)).toBe(true);
  });
});

describe("reading and deleting a status", () => {
  it("shows a public status to anybody, and others to their author", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const open = await publish(sim, token, { status: "For all" });
    const closed = await publish(sim, token, {
      status: "For me",
      visibility: "direct",
    });
    expect(
      (await api(sim, "GET", `/api/v1/statuses/${open.status.id}`)).status,
    ).toBe(200);
    const hidden = await api(
      sim,
      "GET",
      `/api/v1/statuses/${closed.status.id}`,
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "Record not found" });
    const mine = await api(
      sim,
      "GET",
      `/api/v1/statuses/${closed.status.id}`,
      token,
    );
    expect(await mine.json()).toMatchObject({ content: "<p>For me</p>" });
  });

  it("refuses a bad token also for what anybody may read", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { status } = await publish(sim, token, { status: "For all" });
    const response = await api(
      sim,
      "GET",
      `/api/v1/statuses/${status.id}`,
      "pigy-sim-unknown",
    );
    expect(response.status).toBe(401);
  });

  it("deletes a status and returns its text", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { status } = await publish(sim, token, { status: "Hello <there>" });
    const response = await api(
      sim,
      "DELETE",
      `/api/v1/statuses/${status.id}`,
      token,
    );
    expect(response.status).toBe(200);
    const deleted = (await response.json()) as Record<string, unknown>;
    // The text as it was sent takes the place of the HTML.
    expect(deleted.text).toBe("Hello <there>");
    expect(deleted).not.toHaveProperty("content");
    expect(feed(sim.world)).toEqual([]);
    expect(
      (await api(sim, "GET", `/api/v1/statuses/${status.id}`, token)).status,
    ).toBe(404);
    expect(
      (await api(sim, "DELETE", `/api/v1/statuses/${status.id}`, token)).status,
    ).toBe(404);
  });

  it("deletes only the statuses of the account itself", async () => {
    const sim = setup();
    const { app, token } = await connect(sim);
    const { status } = await publish(sim, token, { status: "Mine" });
    const bob = sim.simulator.addAccount(domain, "bob");
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id),
      { account: bob.id },
    );
    const { access_token: bobToken } = (await (
      await tokenRequest(sim, app, callback.searchParams.get("code"))
    ).json()) as { access_token: string };
    const response = await api(
      sim,
      "DELETE",
      `/api/v1/statuses/${status.id}`,
      bobToken,
    );
    expect(response.status).toBe(404);
    expect(feed(sim.world)).toHaveLength(1);
  });

  it("leaves the replies to a deleted status, without what they replied to", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const first = await publish(sim, token, { status: "One" });
    const second = await publish(sim, token, {
      status: "Two",
      in_reply_to_id: first.status.id,
    });
    await api(sim, "DELETE", `/api/v1/statuses/${first.status.id}`, token);
    const reply = await api(
      sim,
      "GET",
      `/api/v1/statuses/${second.status.id}`,
      token,
    );
    expect(await reply.json()).toMatchObject({ in_reply_to_id: null });
  });
});

describe("the statuses of an account", () => {
  /** Posts `count` statuses as Ada and returns their IDs, oldest first. */
  async function posted(sim: Sim, token: string, count: number) {
    const ids: string[] = [];
    for (let number = 1; number <= count; number++) {
      const { status } = await publish(sim, token, {
        status: `Status ${number}`,
      });
      ids.push(status.id);
    }
    return ids;
  }

  /** The IDs that a list of Ada's statuses holds, in its order. */
  async function listed(sim: Sim, query: string, token?: string) {
    const response = await api(
      sim,
      "GET",
      `/api/v1/accounts/${sim.ada.id}/statuses${query}`,
      token,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as StatusJson[]).map(({ id }) => id);
  }

  it("are listed newest first, 20 at a time and 40 at most", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const ids = await posted(sim, token, 45);
    const newestFirst = ids.toReversed();
    expect(await listed(sim, "")).toEqual(newestFirst.slice(0, 20));
    expect(await listed(sim, "?limit=3")).toEqual(newestFirst.slice(0, 3));
    expect(await listed(sim, "?limit=100")).toEqual(newestFirst.slice(0, 40));
  });

  it("are bounded by max_id and since_id, and walked forward with min_id", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const [one, two, three, four, five] = await posted(sim, token, 5);
    expect(await listed(sim, `?max_id=${three}`)).toEqual([two, one]);
    // Both leave out what is older. Of the rest, since_id gives the
    // newest and min_id the ones that follow it directly.
    expect(await listed(sim, `?since_id=${one}&limit=2`)).toEqual([five, four]);
    expect(await listed(sim, `?min_id=${one}&limit=2`)).toEqual([three, two]);
    expect(await listed(sim, `?min_id=${five}`)).toEqual([]);
    expect(await listed(sim, "?min_id=0&limit=1")).toEqual([one]);
  });

  it("show the author everything, and others what is public", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const open = await publish(sim, token, { status: "For all" });
    const closed = await publish(sim, token, {
      status: "For me",
      visibility: "direct",
    });
    expect(await listed(sim, "")).toEqual([open.status.id]);
    expect(await listed(sim, "", token)).toEqual([
      closed.status.id,
      open.status.id,
    ]);
  });

  it("name the client that each was posted with, and what it replies to", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const first = await publish(sim, token, { status: "One" });
    await publish(sim, token, {
      status: "Two",
      in_reply_to_id: first.status.id,
    });
    const response = await api(
      sim,
      "GET",
      `/api/v1/accounts/${sim.ada.id}/statuses`,
      token,
    );
    expect(await response.json()).toMatchObject([
      {
        in_reply_to_id: first.status.id,
        in_reply_to_account_id: sim.ada.id,
        application: { name: "pigy", website: "https://app.example" },
      },
      { in_reply_to_id: null, application: { name: "pigy" } },
    ]);
  });

  it("are those of an account of the instance", async () => {
    const sim = setup();
    const response = await api(sim, "GET", "/api/v1/accounts/123/statuses");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Record not found" });
  });

  it("take a token with the scope to read statuses, if they are given one", async () => {
    const sim = setup();
    const { token } = await connect(sim, "profile write:statuses");
    const path = `/api/v1/accounts/${sim.ada.id}/statuses`;
    expect((await api(sim, "GET", path, token)).status).toBe(403);
    expect((await api(sim, "GET", path, "pigy-sim-unknown")).status).toBe(401);
  });

  it.each([["?pinned=true"], ["?exclude_replies=true"], ["?min_id=abc"]])(
    "refuse %s, which is not simulated, rather than ignore it",
    async (query) => {
      const sim = setup();
      const response = await api(
        sim,
        "GET",
        `/api/v1/accounts/${sim.ada.id}/statuses${query}`,
      );
      expect(response.status).toBe(422);
    },
  );
});

describe("the source of a status", () => {
  it("is the text as Mastodon stores it", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const text = "1 < 2 & @bob@other.example\n\nhttps://example.com/a";
    const { status } = await publish(sim, token, { status: `  ${text} \n` });
    const response = await api(
      sim,
      "GET",
      `/api/v1/statuses/${status.id}/source`,
      token,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: status.id,
      text,
      spoiler_text: "",
    });
  });

  it("is given to a token that may read the status", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { status } = await publish(sim, token, {
      status: "For me",
      visibility: "direct",
    });
    const path = `/api/v1/statuses/${status.id}/source`;
    // Not without a token, as the status itself would be if it were public.
    expect((await api(sim, "GET", path)).status).toBe(401);
    // Not to a token that lacks the scope.
    const writing = await connect(sim, "profile write:statuses");
    expect((await api(sim, "GET", path, writing.token)).status).toBe(403);
    // And not to an account that cannot see the status.
    const bob = sim.simulator.addAccount(domain, "bob");
    const { app } = await register(sim);
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(app.client_id),
      { account: bob.id },
    );
    const { access_token: bobToken } = (await (
      await tokenRequest(sim, app, callback.searchParams.get("code"))
    ).json()) as { access_token: string };
    expect((await api(sim, "GET", path, bobToken)).status).toBe(404);
  });
});

describe("rate limits", () => {
  it("tells how much of the limit is left, and when it starts over", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const response = await api(
      sim,
      "GET",
      "/api/v1/accounts/verify_credentials",
      token,
    );
    expect(response.headers.get("X-RateLimit-Limit")).toBe("300");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("299");
    // The spans of five minutes start on the clock. Mastodon writes the
    // time with six digits after the second.
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-11-15T10:05:00.000000Z",
    );
  });

  it("refuses the request after the last one of a span, until the next span", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const ask = () =>
      api(sim, "GET", "/api/v1/accounts/verify_credentials", token);
    for (let request = 0; request < 300; request++) await ask();
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many requests" });
    expect(refused.headers.get("X-RateLimit-Remaining")).toBe("0");
    sim.world.advance(5 * 60 * 1000);
    expect((await ask()).status).toBe(200);
  });

  it("allows 30 deletions in 30 minutes", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const remove = () => api(sim, "DELETE", "/api/v1/statuses/1", token);
    // The status does not exist. The attempts count all the same.
    for (let request = 0; request < 30; request++) {
      expect((await remove()).status).toBe(404);
    }
    const refused = await remove();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("X-RateLimit-Limit")).toBe("30");
  });
});

describe("faults", () => {
  it("answers once that it was asked too often", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.arm({ kind: "rate-limit" });
    const { response } = await publish(sim, token, { status: "Hello" });
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-11-15T10:05:00.000000Z",
    );
    expect(feed(sim.world)).toEqual([]);
    expect(
      (await publish(sim, token, { status: "Hello" })).response.status,
    ).toBe(200);
  });

  it("fails once the way a server that is down does", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.arm({ kind: "server-error" });
    const response = await api(sim, "POST", "/api/v1/statuses", token, {
      status: "Hello",
    });
    expect(response.status).toBe(503);
    // A page, not JSON: what stands in front of Mastodon answers.
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(feed(sim.world)).toEqual([]);
  });

  it("loses the answer to a request that it carried out", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.arm({ kind: "lost-response" });
    await expect(publish(sim, token, { status: "Hello" })).rejects.toThrow(
      TypeError,
    );
    expect(feed(sim.world)).toHaveLength(1);
  });

  it("takes the token of the next request back, for good", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.arm({ kind: "token-revoked" });
    for (let request = 0; request < 2; request++) {
      const { response, status } = await publish(sim, token, { status: "Hi" });
      expect(response.status).toBe(401);
      expect(status.error).toBe("The access token was revoked");
    }
  });

  it("strikes the kind of request it was armed for", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    sim.simulator.arm({ kind: "server-error", operation: "publish" });
    expect(
      (await api(sim, "GET", "/api/v1/accounts/verify_credentials", token))
        .status,
    ).toBe(200);
    expect((await api(sim, "GET", "/api/v2/instance")).status).toBe(200);
    const struck = await api(sim, "POST", "/api/v1/statuses", token, {
      status: "Hello",
    });
    expect(struck.status).toBe(503);
  });

  it("does not strike the requests of OAuth", async () => {
    const sim = setup();
    sim.simulator.arm({ kind: "server-error" });
    await connect(sim);
    expect(sim.world.faults.armed("mastodon")).toHaveLength(1);
  });

  it("has only the faults that Mastodon can suffer from", () => {
    const { simulator } = setup();
    // Mastodon's tokens do not expire, so there is no such fault. The
    // types say so too: this is what the sandbox gets when it passes on
    // what a person chose.
    expect(() =>
      simulator.arm({ kind: "token-expired" as "token-revoked" }),
    ).toThrow('no fault "token-expired"');
  });
});

describe("the world", () => {
  it("holds everything, so that a simulator can be made anew", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const later = {
      ...sim,
      simulator: createMastodonSimulator(
        createWorld({
          storage: sim.storage,
          now: () => new Date("2026-11-15T10:00:00Z"),
        }),
      ),
    };
    const { response } = await publish(later, token, { status: "Hello" });
    expect(response.status).toBe(200);
  });

  it("keeps the worlds of two people apart", async () => {
    const mine = setup();
    const theirs = setup();
    const { token } = await connect(mine);
    const { response } = await publish(theirs, token, { status: "Hello" });
    expect(response.status).toBe(401);
  });

  it("gives an account a name of Mastodon's kind, once", () => {
    const { simulator } = setup();
    expect(() => simulator.addAccount(domain, "Ada")).toThrow("exists already");
    expect(() => simulator.addAccount(domain, "ada lovelace")).toThrow(
      "Not a username",
    );
    expect(() => simulator.addAccount("nowhere.example", "ada")).toThrow(
      "no instance",
    );
  });
});

describe("media", () => {
  type MediaJson = {
    id: string;
    type: string;
    url: string | null;
    description: string | null;
    meta: { original: { width: number; height: number } };
    error?: string;
  };

  /** Uploads `file` as Ada, with what the form says besides. */
  async function upload(
    sim: Sim,
    token: string,
    file: Uint8Array | null,
    fields: Record<string, string> = {},
  ) {
    const form = new FormData();
    if (file) {
      // Named a JPEG whatever it is: the instance goes by the bytes.
      form.set(
        "file",
        new Blob([file as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        "image.jpg",
      );
    }
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    const response = await sim.simulator.fetch(`${origin}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return { response, media: (await response.clone().json()) as MediaJson };
  }

  it("takes an image, says what it is by its bytes, and keeps its description", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response, media } = await upload(
      sim,
      token,
      await pngFile(40, 30),
      {
        description: "A harbour at dusk",
      },
    );
    expect(response.status).toBe(200);
    expect(media).toMatchObject({
      type: "image",
      description: "A harbour at dusk",
      meta: { original: { width: 40, height: 30 } },
    });
    expect(media.url).toMatch(/^https:\/\/mastodon\.example\//);
    // In no status yet: nothing is published.
    expect(feed(sim.world)).toEqual([]);
  });

  it.each([
    ["no file", null, "File can't be blank"],
    [
      "a file that is no image",
      new TextEncoder().encode("<script>alert(1)</script>"),
      "content type is invalid",
    ],
    [
      "an image with more pixels than it takes",
      jpegFile(8000, 6000),
      "images are not supported",
    ],
  ] as const)("refuses %s", async (_, file, why) => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response, media } = await upload(sim, token, file);
    expect(response.status).toBe(422);
    expect(media.error).toContain(why);
  });

  it("refuses a description that is longer than 1500 characters, counted as characters", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const file = await pngFile(4, 4);
    const taken = await upload(sim, token, file, {
      description: "😀".repeat(1500),
    });
    expect(taken.response.status).toBe(200);
    const refused = await upload(sim, token, file, {
      description: "a".repeat(1501),
    });
    expect(refused.response.status).toBe(422);
    expect(refused.media.error).toContain("Description is too long");
  });

  it("asks for the scope to upload", async () => {
    const sim = setup();
    const { token } = await connect(
      sim,
      "profile read:statuses write:statuses",
    );
    const { response } = await upload(sim, token, await pngFile(4, 4));
    expect(response.status).toBe(403);
  });

  it("posts a status with its images, in the order that the status names them, and a status that is only an image", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const first = await upload(sim, token, await pngFile(40, 30), {
      description: "First",
    });
    const second = await upload(sim, token, jpegFile(50, 20));
    const { response, status } = await publish(sim, token, {
      status: "",
      media_ids: [second.media.id, first.media.id],
    });
    expect(response.status).toBe(200);
    expect(
      (status as unknown as { media_attachments: MediaJson[] })
        .media_attachments,
    ).toMatchObject([
      { id: second.media.id, description: null },
      { id: first.media.id, description: "First" },
    ]);
    expect(feed(sim.world).map(({ post }) => post.images)).toEqual([
      [
        expect.objectContaining({
          alt: "",
          width: 50,
          height: 20,
          type: "image/jpeg",
        }),
        expect.objectContaining({
          alt: "First",
          width: 40,
          height: 30,
          type: "image/png",
        }),
      ],
    ]);
    // The bytes are the world's to show.
    const [shown] = feed(sim.world)[0]?.post.images ?? [];
    expect(sim.world.blobs.get(shown?.blob ?? "")).toEqual(jpegFile(50, 20));
  });

  it("refuses a status with more than four images, with an image of somebody else's, and with one that is in a status already", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const file = await pngFile(4, 4);
    const ids: string[] = [];
    for (let image = 0; image < 5; image++) {
      ids.push((await upload(sim, token, file)).media.id);
    }
    const five = await publish(sim, token, { status: "Five", media_ids: ids });
    expect(five.response.status).toBe(422);
    expect(five.status.error).toContain("Cannot attach more than 4 files");

    const four = await publish(sim, token, {
      status: "Four",
      media_ids: ids.slice(0, 4),
    });
    expect(four.response.status).toBe(200);
    // A file is in one status.
    const again = await publish(sim, token, {
      status: "Again",
      media_ids: ids.slice(0, 1),
    });
    expect(again.response.status).toBe(422);

    const grace = sim.simulator.addAccount(domain, "grace");
    const hers = await connect(sim, scopes, grace.id);
    const stolen = await publish(sim, hers.token, {
      status: "Not mine",
      media_ids: [ids[4]],
    });
    expect(stolen.response.status).toBe(422);
    expect(feed(sim.world).map(({ post }) => post.text)).toEqual(["Four"]);
  });

  it("works on a GIF after it has answered, and takes no status with it until it is done", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { response, media } = await upload(sim, token, gifFile(9, 7));
    expect(response.status).toBe(202);
    expect(media).toMatchObject({ type: "gifv", url: null });

    const early = await publish(sim, token, {
      status: "Too early",
      media_ids: [media.id],
    });
    expect(early.response.status).toBe(422);
    expect(early.status.error).toContain("have not finished processing");

    const path = `/api/v1/media/${media.id}`;
    const working = await api(sim, "GET", path, token);
    expect(working.status).toBe(206);
    const done = await api(sim, "GET", path, token);
    expect(done.status).toBe(200);
    expect(((await done.json()) as MediaJson).url).not.toBeNull();
    const { response: posted } = await publish(sim, token, {
      status: "Now",
      media_ids: [media.id],
    });
    expect(posted.status).toBe(200);
    // In a status, it is no longer asked about by itself.
    expect((await api(sim, "GET", path, token)).status).toBe(404);
  });

  it("drops an image that is in no status after a day", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { media } = await upload(sim, token, await pngFile(4, 4));
    sim.world.advance(24 * 60 * 60 * 1000 - 1000);
    expect(
      (await api(sim, "GET", `/api/v1/media/${media.id}`, token)).status,
    ).toBe(200);
    sim.world.advance(1000);
    expect(
      (await api(sim, "GET", `/api/v1/media/${media.id}`, token)).status,
    ).toBe(404);
    const { response } = await publish(sim, token, {
      status: "Too late",
      media_ids: [media.id],
    });
    expect(response.status).toBe(422);
  });

  it("deletes the images of a status with the status", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const { media } = await upload(sim, token, await pngFile(4, 4));
    const { status } = await publish(sim, token, {
      status: "With an image",
      media_ids: [media.id],
    });
    await api(sim, "DELETE", `/api/v1/statuses/${status.id}`, token);
    // The file is not there for a second status.
    const { response } = await publish(sim, token, {
      status: "Once more",
      media_ids: [media.id],
    });
    expect(response.status).toBe(422);
  });

  it("limits how many files an account uploads in half an hour", async () => {
    const sim = setup();
    const { token } = await connect(sim);
    const file = await pngFile(4, 4);
    for (let sent = 0; sent < 30; sent++) {
      expect((await upload(sim, token, file)).response.status).toBe(200);
    }
    expect((await upload(sim, token, file)).response.status).toBe(429);
    // Posting has a limit of its own, which uploading does not use up.
    const { response } = await publish(sim, token, { status: "Hello" });
    expect(response.status).toBe(200);
  });
});
