import { describe, expect, it } from "vitest";
import {
  answerConsent,
  createWorld,
  feed,
  isSimulatedSecret,
  simulationNotice,
} from "../world/index.ts";
import { createLinkedInSimulator, linkedInVersions } from "./index.ts";

const www = "https://www.linkedin.com";
const api = "https://api.linkedin.com";
const redirectUri = "https://app.example/connect/linkedin/callback";
const scope = "openid profile w_member_social";
const version = linkedInVersions.at(-1) ?? "";
const day = 24 * 60 * 60 * 1000;

/** A world with one application and two members, at a time that stands still. */
function setup() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createLinkedInSimulator(world);
  const client = simulator.addClient({
    name: "pigy",
    redirectUris: [redirectUri],
  });
  const ada = simulator.addMember("Ada Lovelace");
  const grace = simulator.addMember("Grace Hopper");
  return { world, simulator, client, ada, grace };
}

type Sim = ReturnType<typeof setup>;

function authorizationUrl(
  { client }: Sim,
  overrides: Record<string, string | null> = {},
) {
  const url = new URL(`${www}/oauth/v2/authorization`);
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state: "the-state",
    scope,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

function form(sim: Sim, path: string, params: Record<string, string>) {
  return sim.simulator.fetch(www + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

/** Consents as `member` and returns the code that the callback carries. */
async function codeFor(
  sim: Sim,
  member = sim.ada,
  url = authorizationUrl(sim),
) {
  const callback = await answerConsent(sim.simulator.fetch, url, {
    account: member.id,
  });
  return callback.searchParams.get("code") ?? "";
}

function exchange(
  sim: Sim,
  code: string,
  overrides: Record<string, string> = {},
) {
  return form(sim, "/oauth/v2/accessToken", {
    grant_type: "authorization_code",
    code,
    client_id: sim.client.clientId,
    client_secret: sim.client.clientSecret,
    redirect_uri: redirectUri,
    ...overrides,
  });
}

/** An access token of `member`, the way an application gets one. */
async function tokenFor(
  sim: Sim,
  member = sim.ada,
  url = authorizationUrl(sim),
) {
  const response = await exchange(sim, await codeFor(sim, member, url));
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

const postOf = (author: string, commentary: string) => ({
  author: `urn:li:person:${author}`,
  commentary,
  visibility: "PUBLIC",
  distribution: {
    feedDistribution: "MAIN_FEED",
    targetEntities: [],
    thirdPartyDistributionChannels: [],
  },
  lifecycleState: "PUBLISHED",
  isReshareDisabledByAuthor: false,
});

function publish(
  sim: Sim,
  token: string,
  body: unknown,
  headers: Record<string, string | null> = {},
) {
  const all: Record<string, string | null> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
    ...headers,
  };
  return sim.simulator.fetch(`${api}/rest/posts`, {
    method: "POST",
    headers: Object.entries(all).flatMap(([name, value]) =>
      value === null ? [] : [[name, value] as [string, string]],
    ),
    body: JSON.stringify(body),
  });
}

function remove(sim: Sim, token: string, id: string, encode = true) {
  return sim.simulator.fetch(
    `${api}/rest/posts/${encode ? encodeURIComponent(id) : id}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "LinkedIn-Version": version,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
}

const texts = (sim: Sim) => feed(sim.world).map(({ post }) => post.text);

describe("the consent page", () => {
  it("says that it is a simulation and offers the members of the world", async () => {
    const sim = setup();
    const response = await sim.simulator.fetch(authorizationUrl(sim));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(simulationNotice);
    expect(page).toContain("Ada Lovelace");
    expect(page).toContain("Grace Hopper");
    expect(page).toContain("w_member_social");
  });

  it("sends the browser back with a code and the state", async () => {
    const sim = setup();
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(sim),
      { account: sim.ada.id },
    );
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("the-state");
    expect(isSimulatedSecret(callback.searchParams.get("code") ?? "")).toBe(
      true,
    );
  });

  it("says in the callback that the member cancelled", async () => {
    const sim = setup();
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(sim),
      "deny",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      error: "user_cancelled_authorize",
      error_description: "The user cancelled the authorization",
      state: "the-state",
    });
  });

  it.each([
    ["an application that it does not know", { client_id: "unknown" }],
    [
      "a redirect address that was not entered for the application",
      { redirect_uri: "https://evil.example/connect/linkedin/callback" },
    ],
    ["no redirect address", { redirect_uri: null }],
    ["a response type other than a code", { response_type: "token" }],
  ])(
    "ends on a page of its own, and sends the browser nowhere, for %s",
    async (_name, overrides) => {
      const sim = setup();
      const response = await sim.simulator.fetch(
        authorizationUrl(sim, overrides),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain(simulationNotice);
    },
  );

  it.each([
    ["a scope that the application does not have", "openid r_member_social"],
    ["no scope", null],
  ])("sends the browser back with an error for %s", async (_name, asked) => {
    const sim = setup();
    const response = await sim.simulator.fetch(
      authorizationUrl(sim, { scope: asked }),
    );
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("Location") ?? "");
    expect(callback.searchParams.get("error")).toBe("unauthorized_scope_error");
    expect(callback.searchParams.get("state")).toBe("the-state");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("takes a redirect address only as it was entered for the application, in full", async () => {
    const sim = setup();
    const at = (redirect: string, asked = scope) =>
      sim.simulator.fetch(
        authorizationUrl(sim, { redirect_uri: redirect, scope: asked }),
      );
    expect((await at(redirectUri)).status).toBe(200);
    // The same path at another origin is somebody else's address. It is
    // refused on a page of LinkedIn also where the scope is wrong, which
    // is otherwise said to the application, with a redirect.
    const elsewhere = `https://evil.example${new URL(redirectUri).pathname}`;
    expect((await at(elsewhere)).status).toBe(400);
    expect((await at(elsewhere, "r_member_social")).status).toBe(400);
    // A query could carry what the callback then takes for LinkedIn's.
    expect((await at(`${redirectUri}?code=x`)).status).toBe(400);
  });

  it("takes the redirect addresses that are entered for an application later, and no longer the ones before", async () => {
    const sim = setup();
    const moved = "http://localhost:5173/connect/linkedin/callback";
    sim.simulator.setRedirectUris(sim.client.clientId, [moved]);
    const at = (redirect: string) =>
      sim.simulator.fetch(authorizationUrl(sim, { redirect_uri: redirect }));
    expect((await at(moved)).status).toBe(200);
    expect((await at(redirectUri)).status).toBe(400);
  });
});

describe("the access token", () => {
  it("is given for a code, lasts 60 days and lists its scopes with commas", async () => {
    const sim = setup();
    const response = await exchange(sim, await codeFor(sim));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      access_token: expect.any(String),
      expires_in: 5_184_000,
      scope: "openid,profile,w_member_social",
      token_type: "Bearer",
    });
    expect(isSimulatedSecret(body.access_token as string)).toBe(true);
  });

  it("is given once for a code", async () => {
    const sim = setup();
    const code = await codeFor(sim);
    expect((await exchange(sim, code)).status).toBe(200);
    const second = await exchange(sim, code);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_request" });
  });

  it("is not given for a code that is older than 30 minutes", async () => {
    const sim = setup();
    const code = await codeFor(sim);
    sim.world.advance(30 * 60 * 1000);
    expect((await exchange(sim, code)).status).toBe(400);
  });

  it.each([
    [
      "a wrong secret",
      { client_secret: "pigy-sim-wrong" },
      401,
      "invalid_client",
    ],
    [
      // The secret of the application itself, as a real one would look:
      // without the mark of a simulated secret it is compared with nothing.
      "a secret that no simulation made",
      { client_secret: "WPL_AP1.realLooking.secret==" },
      401,
      "invalid_client",
    ],
    [
      "another redirect address than the code was asked with",
      { redirect_uri: "https://app.example/other" },
      400,
      "invalid_redirect_uri",
    ],
    [
      "a grant that the application does not get",
      { grant_type: "refresh_token" },
      400,
      "unsupported_grant_type",
    ],
  ])("is refused for %s", async (_name, overrides, status, error) => {
    const sim = setup();
    const response = await exchange(sim, await codeFor(sim), overrides);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
  });

  it("is asked for with a form and nothing else", async () => {
    const sim = setup();
    const response = await sim.simulator.fetch(`${www}/oauth/v2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect(response.status).toBe(400);
  });

  it("is a new one for every exchange, and the one before stays good", async () => {
    const sim = setup();
    const first = await tokenFor(sim);
    const second = await tokenFor(sim);
    expect(second).not.toBe(first);
    for (const token of [first, second]) {
      const response = await sim.simulator.fetch(`${api}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    }
  });

  it("is refused once its 60 days are over", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.world.advance(60 * day - 1);
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "In time"))).status,
    ).toBe(201);
    sim.world.advance(1);
    const late = await publish(sim, token, postOf(sim.ada.id, "Too late"));
    expect(late.status).toBe(401);
    expect(await late.json()).toMatchObject({ serviceErrorCode: 65602 });
    expect(texts(sim)).toEqual(["In time"]);
  });

  it("can be given back by the application that it was issued to, and by no other", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const other = sim.simulator.addClient({ name: "Another app" });
    const revoke = (client: { clientId: string; clientSecret: string }) =>
      form(sim, "/oauth/v2/revoke", {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        token,
      });
    expect((await revoke(other)).status).toBe(400);
    expect(
      (await revoke({ ...sim.client, clientSecret: "pigy-sim-wrong" })).status,
    ).toBe(401);
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "Before"))).status,
    ).toBe(201);

    expect((await revoke(sim.client)).status).toBe(200);
    const refused = await publish(sim, token, postOf(sim.ada.id, "After"));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ serviceErrorCode: 65601 });
    // Giving back what is gone already is fine.
    expect((await revoke(sim.client)).status).toBe(200);
  });

  it("says how it stands when the application asks", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const introspect = async () =>
      (await (
        await form(sim, "/oauth/v2/introspectToken", {
          client_id: sim.client.clientId,
          client_secret: sim.client.clientSecret,
          token,
        })
      ).json()) as Record<string, unknown>;
    expect(await introspect()).toMatchObject({
      active: true,
      status: "active",
      scope: "openid,profile,w_member_social",
      auth_type: "3L",
    });
    sim.world.advance(60 * day);
    expect(await introspect()).toMatchObject({
      active: false,
      status: "expired",
    });
  });
});

describe("the member of a token", () => {
  it("is told with its ID and its names", async () => {
    const sim = setup();
    const response = await sim.simulator.fetch(`${api}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${await tokenFor(sim, sim.grace)}` },
    });
    expect(await response.json()).toMatchObject({
      sub: sim.grace.id,
      name: "Grace Hopper",
      given_name: "Grace",
      family_name: "Hopper",
    });
  });

  it("is not told to a token without the scopes of signing in", async () => {
    const sim = setup();
    const token = await tokenFor(
      sim,
      sim.ada,
      authorizationUrl(sim, { scope: "w_member_social" }),
    );
    const response = await sim.simulator.fetch(`${api}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it.each([
    ["no token", undefined, 65604],
    ["a token that the world did not issue", "pigy-sim-unknown", 65600],
    ["a token that no simulation made", "AQV-real-looking-token", 65600],
  ])("is not told for %s", async (_name, token, code) => {
    const sim = setup();
    const response = await sim.simulator.fetch(`${api}/v2/userinfo`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ serviceErrorCode: code });
  });
});

describe("posting", () => {
  it("publishes a post and names it in a header, with no body", async () => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim),
      postOf(sim.ada.id, "Hello LinkedIn"),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    const id = response.headers.get("x-restli-id") ?? "";
    expect(id).toMatch(/^urn:li:share:\d+$/);
    expect(feed(sim.world)).toMatchObject([
      {
        post: {
          id,
          text: "Hello LinkedIn",
          replyToId: null,
          url: `https://www.linkedin.com/feed/update/${id}/`,
        },
        account: { name: "Ada Lovelace" },
      },
    ]);
  });

  it("shows a reserved character that is escaped as the character", async () => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim),
      postOf(sim.ada.id, "1 \\* 2 \\(two\\) \\#tag a\\_b \\\\ \\@ada"),
    );
    expect(response.status).toBe(201);
    expect(texts(sim)).toEqual(["1 * 2 (two) #tag a_b \\ @ada"]);
  });

  it.each([
    ["a reserved character that is not escaped", "Hello (world)"],
    ["a mention", "Hello @[Ada](urn:li:person:abc)"],
    ["a backslash that escapes nothing", "a \\ b"],
    ["a backslash at the end", "a \\"],
  ])("refuses %s, and publishes nothing", async (_name, commentary) => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim),
      postOf(sim.ada.id, commentary),
    );
    expect(response.status).toBe(400);
    expect(texts(sim)).toEqual([]);
  });

  it("takes 3000 characters and refuses 3001, counted in UTF-16 code units and without the backslashes", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    // An emoji outside the basic plane is two, and an escaped character
    // one: 2 + 1 + 2997.
    const fits = `😀\\#${"a".repeat(2997)}`;
    expect((await publish(sim, token, postOf(sim.ada.id, fits))).status).toBe(
      201,
    );
    const over = await publish(sim, token, postOf(sim.ada.id, `${fits}b`));
    expect(over.status).toBe(422);
    expect(texts(sim)).toHaveLength(1);
  });

  it.each([
    ["no version", { "LinkedIn-Version": null }, 400, "VERSION_MISSING"],
    [
      "a version that is no month",
      { "LinkedIn-Version": "2026-11" },
      400,
      "VERSION_MISSING",
    ],
    [
      "a version that LinkedIn has retired",
      { "LinkedIn-Version": "202301" },
      426,
      "NONEXISTENT_VERSION",
    ],
  ])("refuses a request with %s", async (_name, headers, status, code) => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim),
      postOf(sim.ada.id, "Hello"),
      headers,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(texts(sim)).toEqual([]);
  });

  it("refuses a request that does not say which protocol it speaks", async () => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim),
      postOf(sim.ada.id, "Hello"),
      { "X-Restli-Protocol-Version": null },
    );
    expect(response.status).toBe(400);
    expect(texts(sim)).toEqual([]);
  });

  it.each([
    ["no text", { commentary: undefined }, 422],
    ["a text of spaces", { commentary: "  " }, 422],
    ["no visibility", { visibility: undefined }, 422],
    ["a visibility that it does not know", { visibility: "EVERYBODY" }, 422],
    ["no distribution", { distribution: undefined }, 422],
    ["a draft", { lifecycleState: "DRAFT" }, 422],
    ["a field that it does not know", { colour: "blue" }, 422],
    [
      "media, which is not simulated",
      { content: { media: { id: "urn:li:image:1" } } },
      400,
    ],
    ["an organization as the author", { author: "urn:li:organization:1" }, 400],
  ])("refuses a post with %s", async (_name, overrides, status) => {
    const sim = setup();
    const response = await publish(sim, await tokenFor(sim), {
      ...postOf(sim.ada.id, "Hello"),
      ...overrides,
    });
    expect(response.status).toBe(status);
    expect(texts(sim)).toEqual([]);
  });

  it("lets a token post as its own member only", async () => {
    const sim = setup();
    const response = await publish(
      sim,
      await tokenFor(sim, sim.ada),
      postOf(sim.grace.id, "Not mine"),
    );
    expect(response.status).toBe(403);
    expect(texts(sim)).toEqual([]);
  });

  it("refuses a token without the scope to post", async () => {
    const sim = setup();
    const token = await tokenFor(
      sim,
      sim.ada,
      authorizationUrl(sim, { scope: "openid profile" }),
    );
    const response = await publish(sim, token, postOf(sim.ada.id, "Hello"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("refuses the same text of the same member for ten minutes, and names the post that is there", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const first = await publish(sim, token, postOf(sim.ada.id, "Twice"));
    const id = first.headers.get("x-restli-id");

    sim.world.advance(10 * 60 * 1000 - 1);
    const second = await publish(sim, token, postOf(sim.ada.id, "Twice"));
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      message: `Content is a duplicate of ${id}`,
      errorDetails: { inputErrors: [{ code: "DUPLICATE_POST" }] },
    });
    // Another member may say the same.
    expect(
      (
        await publish(
          sim,
          await tokenFor(sim, sim.grace),
          postOf(sim.grace.id, "Twice"),
        )
      ).status,
    ).toBe(201);

    sim.world.advance(1);
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "Twice"))).status,
    ).toBe(201);
    expect(texts(sim)).toEqual(["Twice", "Twice", "Twice"]);
  });

  it("limits the posts of a member to 150 in a day, which begins at midnight UTC", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    for (let count = 0; count < 150; count++) {
      const response = await publish(
        sim,
        token,
        postOf(sim.ada.id, `Post ${count}`),
      );
      expect(response.status).toBe(201);
    }
    const refused = await publish(sim, token, postOf(sim.ada.id, "One more"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ serviceErrorCode: 101 });
    // The limit names no time to come back at.
    expect(refused.headers.get("Retry-After")).toBeNull();

    // The world began at 10:00, so midnight is 14 hours away.
    sim.world.advance(14 * 60 * 60 * 1000);
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "A new day"))).status,
    ).toBe(201);
  });
});

describe("deleting and reading", () => {
  it("deletes a post, and answers the same for one that is deleted already", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id =
      (await publish(sim, token, postOf(sim.ada.id, "To delete"))).headers.get(
        "x-restli-id",
      ) ?? "";
    expect((await remove(sim, token, id)).status).toBe(204);
    expect(texts(sim)).toEqual([]);
    expect((await remove(sim, token, id)).status).toBe(204);
  });

  it("refuses an ID that is not encoded, a post that never was, and a post of another member", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id =
      (await publish(sim, token, postOf(sim.ada.id, "Stays"))).headers.get(
        "x-restli-id",
      ) ?? "";
    expect((await remove(sim, token, id, false)).status).toBe(400);
    expect((await remove(sim, token, "urn:li:share:1")).status).toBe(404);
    expect((await remove(sim, await tokenFor(sim, sim.grace), id)).status).toBe(
      403,
    );
    expect(texts(sim)).toEqual(["Stays"]);
  });

  it("lets an application of this world read no post", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id =
      (await publish(sim, token, postOf(sim.ada.id, "Unread"))).headers.get(
        "x-restli-id",
      ) ?? "";
    const response = await sim.simulator.fetch(
      `${api}/rest/posts/${encodeURIComponent(id)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "LinkedIn-Version": version,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("faults", () => {
  it("fails with an error of the server, once, and publishes nothing", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "server-error", operation: "publish" });
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "Hello"))).status,
    ).toBe(500);
    expect(texts(sim)).toEqual([]);
    expect(
      (await publish(sim, token, postOf(sim.ada.id, "Hello"))).status,
    ).toBe(201);
  });

  it("says that it was asked too often", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "rate-limit" });
    const response = await publish(sim, token, postOf(sim.ada.id, "Hello"));
    expect(response.status).toBe(429);
    expect(texts(sim)).toEqual([]);
  });

  it("publishes and loses the answer, the way a connection breaks", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    await expect(
      publish(sim, token, postOf(sim.ada.id, "Hello")),
    ).rejects.toBeInstanceOf(TypeError);
    expect(texts(sim)).toEqual(["Hello"]);
  });

  it("takes the token back for good", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "token-revoked", operation: "publish" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await publish(sim, token, postOf(sim.ada.id, "Hello"));
      expect(response.status).toBe(401);
    }
    expect(texts(sim)).toEqual([]);
  });

  it("strikes only the kind of request that it was armed for", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "server-error", operation: "delete" });
    const posted = await publish(sim, token, postOf(sim.ada.id, "Hello"));
    expect(posted.status).toBe(201);
    const id = posted.headers.get("x-restli-id") ?? "";
    expect((await remove(sim, token, id)).status).toBe(500);
  });

  it("refuses to arm what LinkedIn cannot suffer from", () => {
    const { simulator } = setup();
    expect(() =>
      simulator.arm({ kind: "token-expired" as "rate-limit" }),
    ).toThrow();
    expect(() =>
      simulator.arm({ kind: "rate-limit", operation: "read" as "publish" }),
    ).toThrow();
  });
});

describe("the hosts", () => {
  it("answers on LinkedIn's two and fails for every other, like a host out of reach", async () => {
    const { simulator } = setup();
    expect(simulator.owns("www.linkedin.com")).toBe(true);
    expect(simulator.owns("api.linkedin.com")).toBe(true);
    expect(simulator.owns("linkedin.com")).toBe(false);
    await expect(
      simulator.fetch("https://mastodon.example/api/v2/instance"),
    ).rejects.toBeInstanceOf(TypeError);
    // Without HTTPS it is not LinkedIn.
    await expect(
      simulator.fetch("http://api.linkedin.com/v2/userinfo"),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("has nothing at an address that is not simulated", async () => {
    const { simulator } = setup();
    expect((await simulator.fetch(`${api}/v2/me`)).status).toBe(404);
    expect((await simulator.fetch(`${www}/feed/`)).status).toBe(404);
  });

  it("takes an application only with a simulated secret", () => {
    const { simulator } = setup();
    expect(() =>
      simulator.addClient({ name: "pigy", clientSecret: "a-real-secret" }),
    ).toThrow();
  });
});
