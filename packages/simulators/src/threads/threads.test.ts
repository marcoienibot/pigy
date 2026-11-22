import { jpegFile, pngFile, webpFile } from "@pigy/core/test-images";
import { describe, expect, it } from "vitest";
import {
  answerConsent,
  createWorld,
  entitiesOf,
  feed,
  isSimulatedSecret,
  simulationNotice,
} from "../world/index.ts";
import { createThreadsSimulator, slowProcessingMs } from "./index.ts";

const www = "https://threads.net";
const graph = "https://graph.threads.net";
const redirectUri = "https://app.example/connect/threads/callback";
const scope =
  "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_delete";
const hour = 60 * 60 * 1000;
const day = 24 * hour;

/** A world with one app and two accounts, at a time that stands still. */
function setup() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createThreadsSimulator(world);
  const app = simulator.addApp({ name: "pigy", redirectUris: [redirectUri] });
  const ada = simulator.addUser({ username: "ada", name: "Ada Lovelace" });
  const grace = simulator.addUser({ username: "grace", name: "Grace Hopper" });
  return { world, simulator, app, ada, grace };
}

type Sim = ReturnType<typeof setup>;

function authorizationUrl(
  { app }: Sim,
  overrides: Record<string, string | null> = {},
) {
  const url = new URL(`${www}/oauth/authorize`);
  const params: Record<string, string | null> = {
    client_id: app.appId,
    redirect_uri: redirectUri,
    scope,
    response_type: "code",
    state: "the-state",
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

/** Consents as `user` and returns the code that the callback carries. */
async function codeFor(sim: Sim, user = sim.ada, url = authorizationUrl(sim)) {
  const callback = await answerConsent(sim.simulator.fetch, url, {
    account: user.id,
  });
  return callback.searchParams.get("code") ?? "";
}

function exchangeCode(
  sim: Sim,
  code: string,
  overrides: Record<string, string> = {},
) {
  return sim.simulator.fetch(`${graph}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: sim.app.appId,
      client_secret: sim.app.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
      ...overrides,
    }).toString(),
  });
}

/** A request to the API, with its parameters in the address. */
function call(
  sim: Sim,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {},
) {
  return sim.simulator.fetch(
    `${graph}/v1.0${path}?${new URLSearchParams(params)}`,
    { method },
  );
}

/** What a request to the API answers, read. */
async function answer(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & {
      id?: string;
      error?: { code?: number; error_subcode?: number; message?: string };
      data?: Record<string, unknown>[];
    },
  };
}

/** A short-lived token of `user`, the way an app gets one. */
async function shortTokenFor(
  sim: Sim,
  user = sim.ada,
  url = authorizationUrl(sim),
) {
  const response = await exchangeCode(sim, await codeFor(sim, user, url));
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

const exchangeToken = (
  sim: Sim,
  token: string,
  overrides: Record<string, string> = {},
) =>
  sim.simulator.fetch(
    `${graph}/access_token?${new URLSearchParams({
      grant_type: "th_exchange_token",
      client_secret: sim.app.appSecret,
      access_token: token,
      ...overrides,
    })}`,
  );

const refreshToken = (sim: Sim, token: string) =>
  sim.simulator.fetch(
    `${graph}/refresh_access_token?${new URLSearchParams({
      grant_type: "th_refresh_token",
      access_token: token,
    })}`,
  );

/** A long-lived token of `user`. */
async function tokenFor(sim: Sim, user = sim.ada, url = authorizationUrl(sim)) {
  const response = await exchangeToken(
    sim,
    await shortTokenFor(sim, user, url),
  );
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

/** Makes a container and returns the answer. */
const container = (
  sim: Sim,
  token: string,
  text: string,
  more: Record<string, string> = {},
) =>
  call(sim, "POST", "/me/threads", {
    media_type: "TEXT",
    text,
    access_token: token,
    ...more,
  });

const publishContainer = (sim: Sim, token: string, creationId: string) =>
  call(sim, "POST", "/me/threads_publish", {
    creation_id: creationId,
    access_token: token,
  });

/** Publishes a post in the two steps of Threads and returns its ID. */
async function post(
  sim: Sim,
  token: string,
  text: string,
  more: Record<string, string> = {},
) {
  const made = await answer(await container(sim, token, text, more));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const published = await answer(
    await publishContainer(sim, token, made.body.id ?? ""),
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body.id ?? "";
}

const statusOf = async (sim: Sim, token: string, id: string) =>
  (
    await answer(
      await call(sim, "GET", `/${id}`, {
        fields: "status",
        access_token: token,
      }),
    )
  ).body.status;

const texts = (sim: Sim) => feed(sim.world).map(({ post }) => post.text);

describe("the consent page", () => {
  it("says that it is a simulation and offers the accounts of the world", async () => {
    const sim = setup();
    const response = await sim.simulator.fetch(authorizationUrl(sim));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(simulationNotice);
    expect(page).toContain("Ada Lovelace");
    expect(page).toContain("@grace");
    expect(page).toContain("threads_content_publish");
  });

  it("sends the browser back with a code and the state, and ends the address with #_", async () => {
    const sim = setup();
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(sim),
      { account: sim.ada.id },
    );
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("the-state");
    // The code is whole in the parameter: what Threads adds is a fragment.
    expect(isSimulatedSecret(callback.searchParams.get("code") ?? "")).toBe(
      true,
    );
    expect(callback.hash).toBe("#_");
  });

  it("says in the callback that the person declined", async () => {
    const sim = setup();
    const callback = await answerConsent(
      sim.simulator.fetch,
      authorizationUrl(sim),
      "deny",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      error: "access_denied",
      error_reason: "user_denied",
      error_description: "The user denied your request",
      state: "the-state",
    });
  });

  it.each([
    ["an app that it does not know", { client_id: "1" }],
    [
      "a redirect address that was not entered for the app",
      { redirect_uri: "https://evil.example/connect/threads/callback" },
    ],
    [
      // The address is compared whole, and not by its path or its start.
      "a redirect address that only begins like one of the app",
      { redirect_uri: `${redirectUri}?next=https://evil.example` },
    ],
    ["no redirect address", { redirect_uri: null }],
    ["a response type other than a code", { response_type: "token" }],
    ["a request without threads_basic", { scope: "threads_content_publish" }],
    ["a scope that there is not", { scope: "threads_basic,threads_all" }],
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
});

describe("the short-lived token", () => {
  it("is given for a code, with the ID of the account as a number", async () => {
    const sim = setup();
    const response = await exchangeCode(sim, await codeFor(sim));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      access_token: expect.any(String),
      user_id: Number(sim.ada.id),
    });
    expect(isSimulatedSecret(body.access_token as string)).toBe(true);
  });

  it("is given once for a code, and not for a code that is an hour old", async () => {
    const sim = setup();
    const code = await codeFor(sim);
    expect((await exchangeCode(sim, code)).status).toBe(200);
    const second = await exchangeCode(sim, code);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error_type: "OAuthException" });

    const old = await codeFor(sim);
    sim.world.advance(hour);
    expect((await exchangeCode(sim, old)).status).toBe(400);
  });

  it.each([
    ["a wrong secret", { client_secret: "pigy-sim-wrong" }],
    [
      // The secret of the app itself, as a real one would look: without
      // the mark of a simulated secret it is compared with nothing.
      "a secret that no simulation made",
      { client_secret: "0123456789abcdef0123456789abcdef" },
    ],
    [
      "another redirect address than the code was asked with",
      { redirect_uri: "https://app.example/other" },
    ],
    ["another grant", { grant_type: "refresh_token" }],
  ])("is refused for %s", async (_name, overrides) => {
    const sim = setup();
    const response = await exchangeCode(sim, await codeFor(sim), overrides);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: "OAuthException",
    });
  });

  it("lasts an hour", async () => {
    const sim = setup();
    const token = await shortTokenFor(sim);
    const me = () => call(sim, "GET", "/me", { access_token: token });
    expect((await me()).status).toBe(200);
    sim.world.advance(hour);
    expect((await answer(await me())).body.error).toMatchObject({
      code: 190,
      error_subcode: 463,
    });
  });
});

describe("the long-lived token", () => {
  it("is given for a short-lived one and lasts 60 days", async () => {
    const sim = setup();
    const response = await exchangeToken(sim, await shortTokenFor(sim));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    expect(body).toEqual({
      access_token: expect.any(String),
      token_type: "bearer",
      expires_in: 5_184_000,
    });
    const me = () =>
      call(sim, "GET", "/me", { access_token: body.access_token });
    sim.world.advance(60 * day - 1000);
    expect((await me()).status).toBe(200);
    sim.world.advance(1000);
    expect((await answer(await me())).body.error?.code).toBe(190);
  });

  it.each([
    ["a wrong secret", { client_secret: "pigy-sim-wrong" }],
    ["another grant", { grant_type: "th_refresh_token" }],
    ["a token that it did not issue", { access_token: "THQVJ-real-looking" }],
  ])("is not given for %s", async (_name, overrides) => {
    const sim = setup();
    const response = await exchangeToken(
      sim,
      await shortTokenFor(sim),
      overrides,
    );
    expect(response.status).toBe(400);
  });

  it("is not given for a long-lived token", async () => {
    const sim = setup();
    expect((await exchangeToken(sim, await tokenFor(sim))).status).toBe(400);
  });

  it("is renewed once it is a day old, for 60 days from then", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    // Too young: Threads renews no token that is less than 24 hours old.
    sim.world.advance(day - 1000);
    expect((await refreshToken(sim, token)).status).toBe(400);
    sim.world.advance(1000);
    const response = await refreshToken(sim, token);
    expect(response.status).toBe(200);
    const renewed = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    expect(renewed.expires_in).toBe(5_184_000);
    // The new one outlasts the one that it was made from by that day.
    sim.world.advance(59 * day);
    const me = (value: string) =>
      call(sim, "GET", "/me", { access_token: value });
    expect((await me(token)).status).toBe(400);
    expect((await me(renewed.access_token)).status).toBe(200);
  });

  it("is not renewed once it has expired, and a short-lived one never is", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.world.advance(60 * day);
    const late = await answer(await refreshToken(sim, token));
    expect(late.body.error).toMatchObject({ code: 190, error_subcode: 463 });

    const short = await shortTokenFor(sim);
    expect((await refreshToken(sim, short)).status).toBe(400);
  });
});

describe("the account", () => {
  it("is who the token is for, with the fields that are asked for", async () => {
    const sim = setup();
    const token = await tokenFor(sim, sim.grace);
    const me = await answer(
      await call(sim, "GET", "/me", {
        fields: "id,username,name,threads_profile_picture_url",
        access_token: token,
      }),
    );
    // A field without a value is left out.
    expect(me.body).toEqual({
      id: sim.grace.id,
      username: "grace",
      name: "Grace Hopper",
    });
    // Without fields, the ID alone.
    expect(
      (await answer(await call(sim, "GET", "/me", { access_token: token })))
        .body,
    ).toEqual({ id: sim.grace.id });
  });

  it("takes the token in a header too, and refuses a field that there is not", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const withHeader = await sim.simulator.fetch(`${graph}/v1.0/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(withHeader.status).toBe(200);
    const unknown = await answer(
      await call(sim, "GET", "/me", { fields: "email", access_token: token }),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.code).toBe(100);
  });

  it.each([
    ["no token", {}, 104],
    ["a token that it did not issue", { access_token: "THQVJ-real" }, 190],
  ])("is not said for %s", async (_name, params, code) => {
    const sim = setup();
    const response = await answer(await call(sim, "GET", "/me", params));
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(code);
  });
});

describe("publishing", () => {
  it("takes two steps: a container, which is then published", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const made = await answer(await container(sim, token, "Hello"));
    expect(made.status).toBe(200);
    const creationId = made.body.id ?? "";
    // Nothing is published yet.
    expect(texts(sim)).toEqual([]);
    expect(await statusOf(sim, token, creationId)).toBe("FINISHED");

    const published = await answer(
      await publishContainer(sim, token, creationId),
    );
    expect(published.status).toBe(200);
    expect(published.body.id).not.toBe(creationId);
    expect(texts(sim)).toEqual(["Hello"]);
    expect(await statusOf(sim, token, creationId)).toBe("PUBLISHED");
  });

  it("takes the parameters of a container as a form too", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const response = await sim.simulator.fetch(`${graph}/v1.0/me/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        media_type: "TEXT",
        text: "From a form",
        access_token: token,
      }).toString(),
    });
    expect(response.status).toBe(200);
  });

  it("publishes a container once", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const made = await answer(await container(sim, token, "Once"));
    const creationId = made.body.id ?? "";
    expect((await publishContainer(sim, token, creationId)).status).toBe(200);
    expect((await publishContainer(sim, token, creationId)).status).toBe(400);
    expect(texts(sim)).toEqual(["Once"]);
  });

  it("does not publish a container that is a day old, which has expired", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const made = await answer(await container(sim, token, "Too late"));
    const creationId = made.body.id ?? "";
    sim.world.advance(day);
    expect(await statusOf(sim, token, creationId)).toBe("EXPIRED");
    expect((await publishContainer(sim, token, creationId)).status).toBe(400);
    expect(texts(sim)).toEqual([]);
  });

  it("does not publish the container of another account", async () => {
    const sim = setup();
    const ada = await tokenFor(sim, sim.ada);
    const grace = await tokenFor(sim, sim.grace);
    const made = await answer(await container(sim, ada, "Ada's"));
    const creationId = made.body.id ?? "";
    expect((await publishContainer(sim, grace, creationId)).status).toBe(400);
    // Nor does it say anything of it.
    expect(
      (
        await call(sim, "GET", `/${creationId}`, {
          fields: "status",
          access_token: grace,
        })
      ).status,
    ).toBe(400);
    expect(texts(sim)).toEqual([]);
  });

  it("makes containers and publishes for the account of the token alone", async () => {
    const sim = setup();
    const ada = await tokenFor(sim, sim.ada);
    // Its own ID names the account as `me` does.
    expect(
      (
        await call(sim, "POST", `/${sim.ada.id}/threads`, {
          media_type: "TEXT",
          text: "By ID",
          access_token: ada,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(sim, "POST", `/${sim.grace.id}/threads`, {
          media_type: "TEXT",
          text: "As somebody else",
          access_token: ada,
        })
      ).status,
    ).toBe(400);
  });

  it("counts 500 characters, with an emoji as the bytes that it takes", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    expect((await container(sim, token, "é".repeat(500))).status).toBe(200);
    expect((await container(sim, token, "é".repeat(501))).status).toBe(400);
    // An emoji of four bytes counts four.
    expect((await container(sim, token, "😀".repeat(125))).status).toBe(200);
    expect((await container(sim, token, `${"😀".repeat(125)}a`)).status).toBe(
      400,
    );
  });

  it.each([
    ["no text", { text: " " }],
    ["no media type", { media_type: "" }],
    ["a picture, which is not simulated", { media_type: "IMAGE" }],
    [
      "a link attachment, which is not simulated",
      { link_attachment: "https://example.com" },
    ],
    ["a parameter that there is not", { visibility: "public" }],
    ["a reply control that there is not", { reply_control: "nobody" }],
    ["a reply to a post that there is not", { reply_to_id: "17" }],
  ])("refuses a container with %s", async (_name, more) => {
    const sim = setup();
    const token = await tokenFor(sim);
    const response = await answer(await container(sim, token, "Text", more));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 100 });
  });

  it("refuses what the token was not given the permission for", async () => {
    const sim = setup();
    const basic = await tokenFor(
      sim,
      sim.ada,
      authorizationUrl(sim, { scope: "threads_basic" }),
    );
    const refused = await answer(await container(sim, basic, "No"));
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe(10);

    // Publishing alone does not cover a reply, reading one or deleting.
    const publisher = await tokenFor(
      sim,
      sim.ada,
      authorizationUrl(sim, { scope: "threads_basic,threads_content_publish" }),
    );
    const id = await post(sim, publisher, "A post");
    expect(
      (await container(sim, publisher, "A reply", { reply_to_id: id })).status,
    ).toBe(403);
    expect(
      (await call(sim, "GET", `/${id}/replies`, { access_token: publisher }))
        .status,
    ).toBe(403);
    expect(
      (await call(sim, "DELETE", `/${id}`, { access_token: publisher })).status,
    ).toBe(403);
    expect(texts(sim)).toEqual(["A post"]);
  });

  it("publishes a reply to a post, which makes a thread", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const first = await post(sim, token, "First");
    const second = await post(sim, token, "Second", { reply_to_id: first });
    const read = await answer(
      await call(sim, "GET", `/${second}`, {
        fields: "id,text,is_reply,replied_to,root_post,permalink,username",
        access_token: token,
      }),
    );
    expect(read.body).toEqual({
      id: second,
      text: "Second",
      is_reply: true,
      replied_to: { id: first },
      root_post: { id: first },
      permalink: expect.stringMatching(
        /^https:\/\/www\.threads\.com\/@ada\/post\/\w+$/,
      ),
      username: "ada",
    });
    expect(feed(sim.world).map(({ post }) => post.replyToId)).toEqual([
      null,
      first,
    ]);
  });

  it("refuses a reply in a thread that somebody else began, however deep", async () => {
    const sim = setup();
    const ada = await tokenFor(sim, sim.ada);
    const grace = await tokenFor(sim, sim.grace);
    const first = await post(sim, ada, "Ada's post");
    const refused = await answer(
      await container(sim, grace, "Me too", { reply_to_id: first }),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe(10);
    // Also under a reply of the account's own, which a person can post
    // there in the app of Threads: the thread is still Ada's.
    const { id: own } = sim.simulator.addPost(sim.grace.id, {
      text: "Grace, by hand",
      replyToId: first,
    });
    expect(
      (await container(sim, grace, "And again", { reply_to_id: own })).status,
    ).toBe(403);
    // Ada replies to Grace in her own thread.
    await post(sim, ada, "Thank you", { reply_to_id: own });
    expect(texts(sim)).toEqual(["Ada's post", "Grace, by hand", "Thank you"]);
  });

  it("says of a post what it has besides its text", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const text = await post(sim, token, "Words");
    // What a person posts in the app of Threads.
    const photo = sim.simulator.addPost(sim.ada.id, {
      text: "Words",
      media: "IMAGE",
    });
    const quote = sim.simulator.addPost(sim.ada.id, {
      text: "Words",
      quote: true,
    });
    const poll = sim.simulator.addPost(sim.ada.id, {
      text: "Words",
      poll: true,
    });
    const said = async (id: string) =>
      (
        await answer(
          await call(sim, "GET", `/${id}`, {
            fields: "media_type,is_quote_post,poll_attachment",
            access_token: token,
          }),
        )
      ).body;
    expect(await said(text)).toEqual({
      media_type: "TEXT_POST",
      is_quote_post: false,
    });
    expect(await said(photo.id)).toEqual({
      media_type: "IMAGE",
      is_quote_post: false,
    });
    expect(await said(quote.id)).toEqual({
      media_type: "TEXT_POST",
      is_quote_post: true,
    });
    expect(await said(poll.id)).toMatchObject({
      media_type: "TEXT_POST",
      poll_attachment: expect.any(Object),
    });
  });

  it("previews the first link of a post, takes its first tag for its topic, and links the accounts that it mentions", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id = await post(
      sim,
      token,
      `Thanks @${sim.grace.username.toUpperCase()} and @nobody. https://news.example.test/story and https://example.test/ #First #second`,
    );
    const said = (
      await answer(
        await call(sim, "GET", `/${id}`, {
          fields: "media_type,link_attachment_url,topic_tag",
          access_token: token,
        }),
      )
    ).body;
    // A text post with a preview is a text post still.
    expect(said).toEqual({
      media_type: "TEXT_POST",
      link_attachment_url: "https://news.example.test/story",
      topic_tag: "First",
    });
    const kept = feed(sim.world)[0]?.post;
    expect(kept && entitiesOf(kept)).toEqual([
      // In whatever case it is written, and without the full stop of the
      // sentence. Nobody is called "nobody", so that one stays text.
      ["mention", `@${sim.grace.username.toUpperCase()}`, sim.grace.id],
      [
        "link",
        "https://news.example.test/story",
        "https://news.example.test/story",
      ],
      ["link", "https://example.test/", "https://example.test/"],
      // One tag per post: the second is text.
      ["hashtag", "#First", "First"],
    ]);
    // The page has no Open Graph tags: the card is its title and its
    // description.
    expect(kept?.card).toEqual({
      url: "https://news.example.test/story",
      title: "A story from the simulated news",
      description: "Nothing happened today, and here is all of it.",
    });
  });

  it("says nothing of a preview or a topic of a post that has neither", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id = await post(sim, token, "Words, and #1 is no tag");
    const said = (
      await answer(
        await call(sim, "GET", `/${id}`, {
          fields: "link_attachment_url,topic_tag",
          access_token: token,
        }),
      )
    ).body;
    expect(said).toEqual({});
  });

  it("limits the posts of an account to 250 in 24 hours, and says how many are used", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    for (let count = 0; count < 250; count++) {
      await post(sim, token, `Post ${count}`);
    }
    const limit = await answer(
      await call(sim, "GET", "/me/threads_publishing_limit", {
        fields: "quota_usage,config",
        access_token: token,
      }),
    );
    expect(limit.body.data).toEqual([
      {
        quota_usage: 250,
        config: { quota_total: 250, quota_duration: 86_400 },
      },
    ]);
    const made = await answer(await container(sim, token, "One too many"));
    const refused = await publishContainer(sim, token, made.body.id ?? "");
    expect(refused.status).toBe(403);
    // The limit is the account's: another account goes on posting.
    const grace = await tokenFor(sim, sim.grace);
    await post(sim, grace, "Grace's");
    // A reply has a quota of its own.
    const [first] = feed(sim.world);
    await post(sim, token, "A reply", { reply_to_id: first?.post.id ?? "" });
  });
});

describe("images", () => {
  /**
   * A world whose web has `pages`: what Threads fetches an `image_url`
   * from. Every address that the web is asked for is noted.
   */
  function withWeb(pages: Record<string, Uint8Array | number>) {
    const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
    const fetched: string[] = [];
    const simulator = createThreadsSimulator(world, {
      web: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        fetched.push(url);
        const page = pages[url];
        if (page === undefined) throw new TypeError(`Nothing at ${url}`);
        return typeof page === "number"
          ? new Response("No", { status: page })
          : new Response(page as Uint8Array<ArrayBuffer>);
      },
    });
    const app = simulator.addApp({ name: "pigy", redirectUris: [redirectUri] });
    const ada = simulator.addUser({ username: "ada", name: "Ada Lovelace" });
    const grace = simulator.addUser({
      username: "grace",
      name: "Grace Hopper",
    });
    return { world, simulator, app, ada, grace, fetched };
  }

  /** Makes a container and returns its ID, or what refused it. */
  async function container(
    sim: Sim,
    token: string,
    params: Record<string, string>,
  ) {
    const made = await answer(
      await call(sim, "POST", "/me/threads", {
        ...params,
        access_token: token,
      }),
    );
    return made.status === 200 ? (made.body.id ?? "") : made;
  }

  /** What Threads says of a container. */
  async function statusOf(sim: Sim, token: string, id: string) {
    const { body } = await answer(
      await call(sim, "GET", `/${id}`, {
        fields: "status,error_message",
        access_token: token,
      }),
    );
    return body;
  }

  const publishOf = async (sim: Sim, token: string, id: string) =>
    answer(
      await call(sim, "POST", "/me/threads_publish", {
        creation_id: id,
        access_token: token,
      }),
    );

  it("fetches the image of a container from its address, once, and publishes a post of it with what it shows", async () => {
    const png = await pngFile(640, 480);
    const sim = withWeb({ "https://pigy.example/image?signature=x": png });
    const token = await tokenFor(sim);
    const id = await container(sim, token, {
      media_type: "IMAGE",
      image_url: "https://pigy.example/image?signature=x",
      alt_text: "A harbour",
      text: "With an image",
    });
    expect(sim.fetched).toEqual(["https://pigy.example/image?signature=x"]);
    expect(await statusOf(sim, token, String(id))).toMatchObject({
      status: "FINISHED",
    });
    const { body } = await publishOf(sim, token, String(id));
    // Nothing is fetched again when it is published.
    expect(sim.fetched).toHaveLength(1);

    const read = await answer(
      await call(sim, "GET", `/${body.id}`, {
        fields: "media_type,alt_text,text",
        access_token: token,
      }),
    );
    expect(read.body).toEqual({
      media_type: "IMAGE",
      alt_text: "A harbour",
      text: "With an image",
    });
    const [{ post } = { post: undefined }] = feed(sim.world);
    expect(post?.images).toMatchObject([
      { type: "image/png", width: 640, height: 480, alt: "A harbour" },
    ]);
    expect(sim.world.blobs.get(post?.images?.[0]?.blob ?? "")).toEqual(png);
  });

  it("publishes a carousel of items that were made before, in their order, and says what each shows", async () => {
    const sim = withWeb({
      "https://pigy.example/1": await pngFile(300, 200),
      "https://pigy.example/2": jpegFile(200, 300),
    });
    const token = await tokenFor(sim);
    const item = (url: string, alt: string) =>
      container(sim, token, {
        media_type: "IMAGE",
        image_url: url,
        alt_text: alt,
        is_carousel_item: "true",
      });
    const one = String(await item("https://pigy.example/1", "One"));
    const two = String(await item("https://pigy.example/2", ""));
    // An item is published with its carousel and not by itself.
    expect((await publishOf(sim, token, one)).status).toBe(400);
    const carousel = String(
      await container(sim, token, {
        media_type: "CAROUSEL",
        children: `${one},${two}`,
        text: "Two images",
      }),
    );
    const { body } = await publishOf(sim, token, carousel);

    const read = await answer(
      await call(sim, "GET", `/${body.id}`, {
        fields: "media_type,text,children{media_type,alt_text}",
        access_token: token,
      }),
    );
    expect(read.body).toEqual({
      media_type: "CAROUSEL_ALBUM",
      text: "Two images",
      children: {
        data: [
          { media_type: "IMAGE", alt_text: "One" },
          { media_type: "IMAGE", alt_text: "" },
        ],
      },
    });
    // Without braces, the items are named by their IDs.
    const ids = await answer(
      await call(sim, "GET", `/${body.id}`, {
        fields: "children",
        access_token: token,
      }),
    );
    expect(ids.body).toEqual({
      children: {
        data: [{ id: expect.any(String) }, { id: expect.any(String) }],
      },
    });
    expect(
      feed(sim.world)[0]?.post.images?.map(({ width, alt }) => [width, alt]),
    ).toEqual([
      [300, "One"],
      [200, ""],
    ]);
  });

  it("refuses a carousel of one item and of 21, of an item that is not ready, and of a container that is no item", async () => {
    const sim = withWeb({ "https://pigy.example/1": await pngFile(300, 200) });
    const token = await tokenFor(sim);
    const item = async () =>
      String(
        await container(sim, token, {
          media_type: "IMAGE",
          image_url: "https://pigy.example/1",
          is_carousel_item: "true",
        }),
      );
    const ready = await item();
    const refused = async (children: string) => {
      const made = await container(sim, token, {
        media_type: "CAROUSEL",
        children,
      });
      return typeof made === "string" ? 200 : made.status;
    };
    expect(await refused(ready)).toBe(400);
    expect(
      await refused(Array.from({ length: 21 }, () => ready).join(",")),
    ).toBe(400);
    const text = String(
      await container(sim, token, { media_type: "TEXT", text: "No item" }),
    );
    expect(await refused(`${ready},${text}`)).toBe(400);
    sim.simulator.arm({ kind: "slow-processing", operation: "container" });
    const slow = await item();
    expect(await refused(`${ready},${slow}`)).toBe(400);
    sim.world.advance(slowProcessingMs);
    expect(await refused(`${ready},${slow}`)).toBe(200);
  });

  it("says by the status of a container what is wrong with the image at its address, and does not repeat the address", async () => {
    const sim = withWeb({
      "https://pigy.example/gone?signature=secret": 404,
      "https://pigy.example/webp?signature=secret": webpFile(300, 200),
      "https://pigy.example/long?signature=secret": await pngFile(1100, 100),
      "https://pigy.example/large?signature=secret": new Uint8Array(
        8 * 1024 * 1024 + 1,
      ),
    });
    const token = await tokenFor(sim);
    for (const path of ["gone", "nowhere", "webp", "long", "large"]) {
      const id = String(
        await container(sim, token, {
          media_type: "IMAGE",
          image_url: `https://pigy.example/${path}?signature=secret`,
        }),
      );
      const status = await statusOf(sim, token, id);
      expect(status).toMatchObject({ status: "ERROR" });
      expect(String(status.error_message)).not.toContain("secret");
      expect((await publishOf(sim, token, id)).status).toBe(400);
    }
    // An address that is no HTTPS one is refused at once.
    const plain = await container(sim, token, {
      media_type: "IMAGE",
      image_url: "http://pigy.example/1",
    });
    expect(plain).toMatchObject({ status: 400 });
    expect(feed(sim.world)).toEqual([]);
  });

  it("fetches nothing in a world without a web, and fails the container", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const id = String(
      await container(sim, token, {
        media_type: "IMAGE",
        image_url: "https://pigy.example/1",
      }),
    );
    expect(await statusOf(sim, token, id)).toMatchObject({ status: "ERROR" });
  });

  it("refuses a description of more than 1000 characters, an item with a text or a reply, and what belongs to another kind of container", async () => {
    const sim = withWeb({ "https://pigy.example/1": await pngFile(300, 200) });
    const token = await tokenFor(sim);
    const image = { media_type: "IMAGE", image_url: "https://pigy.example/1" };
    const status = async (params: Record<string, string>) => {
      const made = await container(sim, token, params);
      return typeof made === "string" ? 200 : made.status;
    };
    expect(await status({ ...image, alt_text: "a".repeat(1001) })).toBe(400);
    expect(await status({ ...image, alt_text: "a".repeat(1000) })).toBe(200);
    expect(
      await status({ ...image, is_carousel_item: "true", text: "No" }),
    ).toBe(400);
    expect(
      await status({
        media_type: "TEXT",
        text: "a",
        image_url: "https://pigy.example/1",
      }),
    ).toBe(400);
    expect(
      await status({ media_type: "TEXT", text: "a", alt_text: "No" }),
    ).toBe(400);
    expect(
      await status({ media_type: "VIDEO", video_url: "https://x.example/" }),
    ).toBe(400);
  });
});

describe("reading", () => {
  it("lists the posts of the account, newest first and without its replies, in pages", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const ids: string[] = [];
    for (const text of ["One", "Two", "Three"]) {
      ids.push(await post(sim, token, text));
      sim.world.advance(1000);
    }
    await post(sim, token, "A reply", { reply_to_id: ids[0] ?? "" });
    await post(sim, await tokenFor(sim, sim.grace), "Grace's");

    const list = (more: Record<string, string> = {}) =>
      call(sim, "GET", "/me/threads", {
        fields: "id,text,timestamp",
        limit: "2",
        access_token: token,
        ...more,
      });
    const first = await answer(await list());
    expect(first.body.data).toEqual([
      { id: ids[2], text: "Three", timestamp: "2026-11-15T10:00:02+0000" },
      { id: ids[1], text: "Two", timestamp: "2026-11-15T10:00:01+0000" },
    ]);
    type Paged = { paging: { cursors: { after: string } } };
    const second = await answer(
      await list({ after: (first.body as Paged).paging.cursors.after }),
    );
    expect(second.body.data).toMatchObject([{ id: ids[0] }]);
    // The list ends with a page that is empty and has no cursor.
    expect(
      (
        await answer(
          await list({ after: (second.body as Paged).paging.cursors.after }),
        )
      ).body,
    ).toEqual({ data: [] });
  });

  it("lists the replies to a post, and says which are the account's own", async () => {
    const sim = setup();
    const ada = await tokenFor(sim, sim.ada);
    const first = await post(sim, ada, "First");
    sim.world.advance(1000);
    const own = await post(sim, ada, "Ada's reply", { reply_to_id: first });
    sim.world.advance(1000);
    // Somebody else replies in the app of Threads: no app of this
    // simulation replies under a post that is not its account's own.
    const { id: other } = sim.simulator.addPost(sim.grace.id, {
      text: "Grace's reply",
      replyToId: first,
    });
    // A reply to a reply is no reply to the first post.
    await post(sim, ada, "Deeper", { reply_to_id: own });

    const replies = await answer(
      await call(sim, "GET", `/${first}/replies`, {
        fields: "id,text,is_reply_owned_by_me",
        access_token: ada,
      }),
    );
    expect(replies.body.data).toEqual([
      { id: other, text: "Grace's reply", is_reply_owned_by_me: false },
      { id: own, text: "Ada's reply", is_reply_owned_by_me: true },
    ]);
  });

  it("says of an ID that it has nothing under that there is no such object", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const response = await answer(
      await call(sim, "GET", "/17", { access_token: token }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 100, error_subcode: 33 });
  });
});

describe("deleting", () => {
  it("deletes a post of the account, once, and leaves its replies", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const first = await post(sim, token, "First");
    await post(sim, token, "Second", { reply_to_id: first });
    const remove = () =>
      call(sim, "DELETE", `/${first}`, { access_token: token });
    expect((await answer(await remove())).body).toEqual({
      success: true,
      deleted_id: first,
    });
    expect(texts(sim)).toEqual(["Second"]);
    // Gone is like never there.
    expect((await answer(await remove())).body.error).toMatchObject({
      code: 100,
      error_subcode: 33,
    });
  });

  it("does not delete the post of another account", async () => {
    const sim = setup();
    const id = await post(sim, await tokenFor(sim, sim.ada), "Ada's");
    const grace = await tokenFor(sim, sim.grace);
    expect(
      (await call(sim, "DELETE", `/${id}`, { access_token: grace })).status,
    ).toBe(400);
    expect(texts(sim)).toEqual(["Ada's"]);
  });
});

describe("faults", () => {
  it("strikes the next request of the kind that it is armed for, once", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "server-error", operation: "publish" });
    // A container is no publishing: the fault waits.
    const made = await answer(await container(sim, token, "Hello"));
    expect(made.status).toBe(200);
    const creationId = made.body.id ?? "";
    const failed = await answer(await publishContainer(sim, token, creationId));
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatchObject({ code: 2, is_transient: true });
    expect(texts(sim)).toEqual([]);
    expect((await publishContainer(sim, token, creationId)).status).toBe(200);
  });

  it("answers that it was asked too often", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "rate-limit" });
    const limited = await answer(await container(sim, token, "Hello"));
    expect(limited.status).toBe(403);
    expect(limited.body.error?.code).toBe(4);
  });

  it("publishes and loses the answer", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const made = await answer(await container(sim, token, "Hello"));
    const creationId = made.body.id ?? "";
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    await expect(publishContainer(sim, token, creationId)).rejects.toThrow(
      TypeError,
    );
    expect(texts(sim)).toEqual(["Hello"]);
    // Which the container says to whoever asks.
    expect(await statusOf(sim, token, creationId)).toBe("PUBLISHED");
  });

  it("takes the token of a request back, for good", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "token-revoked" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await answer(
        await call(sim, "GET", "/me", { access_token: token }),
      );
      expect(refused.body.error).toMatchObject({
        code: 190,
        error_subcode: 458,
      });
    }
  });

  it("takes its time to prepare a container, and does not publish it meanwhile", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "slow-processing" });
    // The fault is of a container: a request of another kind leaves it armed.
    expect(
      (await call(sim, "GET", "/me", { access_token: token })).status,
    ).toBe(200);
    const made = await answer(await container(sim, token, "Slowly"));
    const creationId = made.body.id ?? "";
    expect(await statusOf(sim, token, creationId)).toBe("IN_PROGRESS");
    expect((await publishContainer(sim, token, creationId)).status).toBe(400);
    expect(texts(sim)).toEqual([]);

    sim.world.advance(slowProcessingMs);
    expect(await statusOf(sim, token, creationId)).toBe("FINISHED");
    expect((await publishContainer(sim, token, creationId)).status).toBe(200);
    // The next container is ready at once.
    const next = await answer(await container(sim, token, "At once"));
    expect(await statusOf(sim, token, next.body.id ?? "")).toBe("FINISHED");
  });

  it("makes a container slow also when the fault was armed for posting, which a container is part of", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    sim.simulator.arm({ kind: "slow-processing", operation: "publish" });
    const made = await answer(await container(sim, token, "Slowly"));
    expect(await statusOf(sim, token, made.body.id ?? "")).toBe("IN_PROGRESS");
    // It has struck: the next container is ready at once.
    const next = await answer(await container(sim, token, "At once"));
    expect(await statusOf(sim, token, next.body.id ?? "")).toBe("FINISHED");
  });

  it("refuses to arm what it does not have", () => {
    const sim = setup();
    expect(() =>
      // @ts-expect-error A token of Threads that has expired is not renewed.
      sim.simulator.arm({ kind: "token-expired" }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error No request of that name.
      sim.simulator.arm({ kind: "rate-limit", operation: "revoke" }),
    ).toThrow();
  });
});

describe("what it keeps to itself", () => {
  it("fails like a host out of reach for every host but its own two, and without HTTPS", async () => {
    const sim = setup();
    for (const url of [
      "https://www.threads.net/oauth/authorize",
      "https://graph.facebook.com/v1.0/me",
      "http://graph.threads.net/v1.0/me",
    ]) {
      await expect(sim.simulator.fetch(url)).rejects.toThrow(TypeError);
    }
    expect(sim.simulator.owns("graph.threads.net")).toBe(true);
    expect(sim.simulator.owns("threads.net")).toBe(true);
    expect(sim.simulator.owns("www.threads.net")).toBe(false);
  });

  it("makes an app only with a secret that says that it is simulated", () => {
    const sim = setup();
    expect(() =>
      sim.simulator.addApp({ name: "pigy", appSecret: "a-real-secret" }),
    ).toThrow();
  });

  it("answers what it does not simulate as the API answers an address that it does not have", async () => {
    const sim = setup();
    const token = await tokenFor(sim);
    const response = await answer(
      await call(sim, "GET", "/me/replies", { access_token: token }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(100);
  });
});

describe("insights", () => {
  /** A token of Ada's that may read insights too. */
  const insightful = (sim: Sim) =>
    tokenFor(
      sim,
      sim.ada,
      authorizationUrl(sim, { scope: `${scope},threads_manage_insights` }),
    );

  const insightsOf = (
    sim: Sim,
    token: string,
    id: string,
    metric = "views,likes,replies,reposts,quotes",
  ) => call(sim, "GET", `/${id}/insights`, { metric, access_token: token });

  it("says what people did with a post of the account, by each metric that is asked for", async () => {
    const sim = setup();
    const token = await insightful(sim);
    const id = await post(sim, token, "Counted");
    await post(sim, token, "Me again", { reply_to_id: id });
    sim.world.engage("threads", id, { views: 40, likes: 3, quotes: 1 });

    const { status, body } = await answer(await insightsOf(sim, token, id));

    expect(status).toBe(200);
    // The reply of the account itself is among the replies.
    expect(body.data?.map(({ name, values }) => [name, values])).toEqual([
      ["views", [{ value: 40 }]],
      ["likes", [{ value: 3 }]],
      ["replies", [{ value: 1 }]],
      ["reposts", [{ value: 0 }]],
      ["quotes", [{ value: 1 }]],
    ]);
    expect(body.data?.[0]).toMatchObject({
      period: "lifetime",
      id: `${id}/insights/views/lifetime`,
    });
  });

  it("counts every reply below a post that begins a thread, and only those to it below a reply", async () => {
    const sim = setup();
    const token = await insightful(sim);
    // A thread of three parts, each a reply to the one before, and an
    // answer of somebody else's to the second.
    const root = await post(sim, token, "First");
    const second = await post(sim, token, "Second", { reply_to_id: root });
    const third = await post(sim, token, "Third", { reply_to_id: second });
    // As a person does in the app of Threads.
    sim.simulator.addPost(sim.grace.id, {
      text: "Grace answers",
      replyToId: second,
    });
    const repliesOf = async (id: string) =>
      (await answer(await insightsOf(sim, token, id, "replies"))).body.data?.[0]
        ?.values;

    // As Meta documents the metric: of a root post, the replies in its
    // whole thread, the account's own among them.
    expect(await repliesOf(root)).toEqual([{ value: 3 }]);
    // Of a reply, the replies to it alone.
    expect(await repliesOf(second)).toEqual([{ value: 2 }]);
    expect(await repliesOf(third)).toEqual([{ value: 0 }]);
  });

  it("refuses a token without the permission to read insights", async () => {
    const sim = setup();
    // What an account that was connected before pigy asked for it has.
    const token = await tokenFor(sim);
    const id = await post(sim, token, "Counted");

    const { status, body } = await answer(await insightsOf(sim, token, id));

    expect(status).toBe(403);
    expect(body.error?.code).toBe(10);
  });

  it("has none of a post of somebody else's or of one that is gone, and none of a metric that it does not know", async () => {
    const sim = setup();
    const token = await insightful(sim);
    const graces = await post(sim, await tokenFor(sim, sim.grace), "Grace's");
    const mine = await post(sim, token, "Mine");

    const other = await answer(await insightsOf(sim, token, graces));
    expect(other.body.error).toMatchObject({ code: 100, error_subcode: 33 });
    await call(sim, "DELETE", `/${mine}`, { access_token: token });
    const gone = await answer(await insightsOf(sim, token, mine));
    expect(gone.body.error).toMatchObject({ code: 100, error_subcode: 33 });
    const mineAgain = await post(sim, token, "Mine again");
    const unknown = await answer(
      await insightsOf(sim, token, mineAgain, "likes,hearts"),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.code).toBe(100);
  });

  it("can be made to fail like the rest of the API", async () => {
    const sim = setup();
    const token = await insightful(sim);
    const id = await post(sim, token, "Counted");
    sim.simulator.arm({ kind: "rate-limit", operation: "stats" });

    const { body } = await answer(await insightsOf(sim, token, id));

    expect(body.error).toMatchObject({ code: 4 });
  });
});
