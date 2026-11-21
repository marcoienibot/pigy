import type { Fetch } from "@pigy/core";
import { createLinkedInSimulator } from "@pigy/simulators/linkedin";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.ts";
import {
  createLinkedInProvider,
  type LinkedInCredentials,
  linkedInApiVersion,
} from "./index.ts";

/**
 * What is the LinkedIn adapter's own. What every provider does is in
 * test/conformance.
 */

const redirectUri = "https://pigy.example/connect/linkedin/callback";

type Intercept = (
  request: Request,
) => Promise<Response | undefined> | Response | undefined;

/**
 * The adapter against the simulated LinkedIn. Every request is noted, and
 * `intercept` may answer one in the simulator's place, with what the
 * simulated LinkedIn does not send.
 */
function setup() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createLinkedInSimulator(world);
  const client = simulator.addClient({
    name: "pigy",
    redirectUris: [redirectUri],
  });
  const ada = simulator.addMember("Ada Lovelace");
  const requests: Request[] = [];
  const hooks: { intercept?: Intercept } = {};
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return (await hooks.intercept?.(request)) ?? simulator.fetch(request);
  };
  const provider = createLinkedInProvider({
    fetch,
    now: world.now,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  return { world, simulator, client, ada, requests, hooks, provider };
}

type Setup = ReturnType<typeof setup>;

async function consented({ provider, simulator, ada }: Setup) {
  const start = await provider.beginConnect({ redirectUri });
  const callback = await answerConsent(simulator.fetch, start.url, {
    account: ada.id,
  });
  return { pending: start.pending, params: callback.searchParams };
}

async function connect(test: Setup) {
  const connection = await test.provider.completeConnect(await consented(test));
  return {
    ...connection,
    credentials: connection.access.credentials as LinkedInCredentials,
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

/** Whether `request` asks LinkedIn to publish a post. */
const posts = (request: Request) =>
  request.method === "POST" && request.url.endsWith("/rest/posts");

const step = (
  { provider }: Setup,
  credentials: LinkedInCredentials,
  ...texts: string[]
) =>
  provider.publishStep({
    credentials,
    content: { parts: texts.map((text) => ({ text })) },
    key: "target-1",
    progress: null,
  });

const published = ({ world }: Setup) =>
  feed(world, ["linkedin"]).map(({ post }) => post.text);

describe("connecting", () => {
  it("sends the person to LinkedIn's one place to sign in, whatever they typed", async () => {
    const { provider, client } = setup();
    const { url, state } = await provider.beginConnect({
      redirectUri,
      identifier: "evil.example",
    });
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      scope: "openid profile w_member_social",
    });
  });

  it("names the account by the member's name, which is all that LinkedIn gives to address it by", async () => {
    const test = setup();
    const { account, access } = await connect(test);
    expect(account).toEqual({
      id: test.ada.id,
      handle: "Ada Lovelace",
      name: "Ada Lovelace",
      avatarUrl: null,
      profileUrl: null,
    });
    // 60 days from now, as LinkedIn said, and nothing to renew it with.
    expect(access.expiresAt).toEqual(new Date("2027-01-14T10:00:00Z"));
    expect(access.refreshAt).toBeNull();
    expect(test.provider.refresh).toBeUndefined();
  });

  it("takes a picture only from an HTTPS address, and makes a name of its parts where LinkedIn sends no whole one", async () => {
    const test = setup();
    test.hooks.intercept = (request) =>
      request.url.endsWith("/v2/userinfo")
        ? Response.json({
            sub: test.ada.id,
            given_name: "Ada",
            family_name: "Lovelace",
            picture: "http://media.example/ada.jpg",
          })
        : undefined;
    const { account } = await connect(test);
    expect(account).toMatchObject({ name: "Ada Lovelace", avatarUrl: null });
  });

  it.each(["user_cancelled_login", "user_cancelled_authorize"])(
    "takes %s for a person who said no",
    async (error) => {
      const test = setup();
      const { pending } = await test.provider.beginConnect({ redirectUri });
      const { state } = pending as { state: string };
      const failed = await failure(() =>
        test.provider.completeConnect({
          pending,
          params: new URLSearchParams({ error, state }),
        }),
      );
      expect(failed).toMatchObject({ kind: "fail", declined: true });
    },
  );

  it("quotes what a callback says went wrong, without what the connection is made with", async () => {
    const test = setup();
    const { pending } = await test.provider.beginConnect({ redirectUri });
    const { state } = pending as { state: string };
    const failed = await failure(() =>
      test.provider.completeConnect({
        pending,
        params: new URLSearchParams({
          error: "unauthorized_scope_error",
          // Anybody can send a browser to the callback address.
          error_description: `Scope not authorized, state ${state}, secret ${test.client.clientSecret}`,
          state,
        }),
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", declined: false });
    expect(failed.message).toContain("Scope not authorized");
    expect(failed.message).not.toContain(state);
    expect(failed.message).not.toContain(test.client.clientSecret);
  });

  it.each([
    ["with commas between them", "openid,profile,w_member_social", true],
    ["with spaces between them", "w_member_social profile openid", true],
    ["without the one to post with", "openid,profile", false],
  ])("reads the scopes of a token %s", async (_name, scope, enough) => {
    const test = setup();
    test.hooks.intercept = async (request) => {
      if (!request.url.endsWith("/oauth/v2/accessToken")) return undefined;
      const answer = await test.simulator.fetch(request);
      return Response.json({ ...(await answer.json()), scope });
    };
    const connecting = connect(test);
    if (enough) {
      expect((await connecting).account.id).toBe(test.ada.id);
    } else {
      expect((await failure(() => connecting)).kind).toBe("fail");
    }
  });

  it("does not put the secret of the application into a message when LinkedIn repeats it", async () => {
    const test = setup();
    const callback = await consented(test);
    test.hooks.intercept = (request) =>
      request.url.endsWith("/oauth/v2/accessToken")
        ? Response.json(
            {
              error: "invalid_request",
              error_description: `Bad secret ${test.client.clientSecret} for code ${callback.params.get("code")}`,
            },
            { status: 400 },
          )
        : undefined;
    const failed = await failure(() => test.provider.completeConnect(callback));
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("Bad secret");
    expect(failed.message).not.toContain(test.client.clientSecret);
    expect(failed.message).not.toContain(callback.params.get("code"));
  });
});

describe("limits", () => {
  it("are LinkedIn's 3000 characters, without asking LinkedIn", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const before = test.requests.length;
    expect(await test.provider.limits(credentials)).toEqual({
      network: "linkedin",
      maxCharacters: 3000,
    });
    expect(test.requests).toHaveLength(before);
  });
});

describe("publishing", () => {
  it("says which version of the API it speaks, and posts as the member", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await step(test, credentials, "Hello");
    const request = test.requests.find(posts);
    expect(request?.headers.get("LinkedIn-Version")).toBe(linkedInApiVersion);
    expect(request?.headers.get("X-Restli-Protocol-Version")).toBe("2.0.0");
    expect(await request?.json()).toMatchObject({
      author: `urn:li:person:${test.ada.id}`,
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
  });

  it("escapes what LinkedIn reserves, so that the post reads as it was written", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const text =
      "A (new) post_with #tags, @mentions, a \\ and [brackets] {x|y} <z> *b* ~s~";
    await step(test, credentials, text);
    expect(published(test)).toEqual([text]);
  });

  it("joins the parts of a thread with an empty line, and gives every part the one post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await step(test, credentials, "One", "Two", "Three");
    expect(published(test)).toEqual(["One\n\nTwo\n\nThree"]);
    const [first] = progress.parts;
    expect(progress).toEqual({
      parts: [first, first, first],
      done: true,
      waitSeconds: 0,
      state: null,
    });
    expect(first).toEqual({
      id: expect.stringMatching(/^urn:li:share:\d+$/),
      url: `https://www.linkedin.com/feed/update/${first?.id}/`,
    });
  });

  it("sends nothing for a post that an attempt before it has published", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await step(test, credentials, "Once");
    const before = test.requests.length;
    const again = await test.provider.publishStep({
      credentials,
      content: { parts: [{ text: "Once" }] },
      key: "target-1",
      progress,
    });
    expect(again).toEqual(progress);
    expect(test.requests).toHaveLength(before);
  });

  it("takes the post that LinkedIn names when it refuses the text as a repetition", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The answer to the first request is lost: the post is there, and
    // nobody knows.
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(() => step(test, credentials, "Hello"))).kind).toBe(
      "uncertain",
    );
    // A person looks, finds nothing or does not look, and tries again
    // within the minutes in which LinkedIn tells a repetition.
    test.world.advance(5 * 60 * 1000);
    const progress = await step(test, credentials, "Hello");
    expect(progress.done).toBe(true);
    const [post] = feed(test.world, ["linkedin"]);
    expect(progress.parts).toEqual([
      { id: post?.post.id, url: post?.post.url },
    ]);
    expect(published(test)).toEqual(["Hello"]);
  });

  it("fails, and says why, when LinkedIn refuses a repetition without naming the post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.hooks.intercept = (request) =>
      posts(request)
        ? Response.json(
            { message: "Content is a duplicate", status: 422 },
            { status: 422 },
          )
        : undefined;
    const failed = await failure(() => step(test, credentials, "Hello"));
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("Content is a duplicate");
  });

  it.each([
    ["no ID", {}],
    ["an ID that is no post", { "x-restli-id": "urn:li:person:abc" }],
  ])(
    "cannot tell which post it made when LinkedIn takes one and answers with %s",
    async (_name, headers) => {
      const test = setup();
      const { credentials } = await connect(test);
      test.hooks.intercept = (request) =>
        posts(request)
          ? new Response(null, { status: 201, headers })
          : undefined;
      expect((await failure(() => step(test, credentials, "Hello"))).kind).toBe(
        "uncertain",
      );
    },
  );

  it("asks to try again at midnight UTC when LinkedIn has been asked too often for the day", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.simulator.arm({ kind: "rate-limit", operation: "publish" });
    const failed = await failure(() => step(test, credentials, "Hello"));
    // A refusal says that nothing was posted, so this is no `uncertain`.
    expect(failed.kind).toBe("retry");
    expect(failed.retryAt).toEqual(new Date("2026-11-16T00:00:00Z"));
    expect(published(test)).toEqual([]);
  });

  it("says that pigy has to be updated when LinkedIn has retired its version of the API", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const old = createLinkedInProvider({
      fetch: test.simulator.fetch,
      now: test.world.now,
      clientId: test.client.clientId,
      clientSecret: test.client.clientSecret,
      apiVersion: "202301",
    });
    const failed = await failure(() =>
      old.publishStep({
        credentials,
        content: { parts: [{ text: "Hello" }] },
        key: "target-1",
        progress: null,
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", status: 426 });
    expect(failed.message).toContain("update");
  });

  it("fails for a refusal that says what is wrong with the post, and quotes it", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const failed = await failure(() =>
      step(test, credentials, "a".repeat(3001)),
    );
    expect(failed).toMatchObject({ kind: "fail", status: 422 });
    expect(failed.message).toContain("3001 characters");
    expect(failed.message).not.toContain(credentials.accessToken);
  });
});

describe("deleting", () => {
  it("writes the ID of the post into the address with its colons encoded", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await step(test, credentials, "To delete");
    const id = parts[0]?.id ?? "";
    await test.provider.deletePost(credentials, id);
    expect(test.requests.at(-1)?.url).toBe(
      `https://api.linkedin.com/rest/posts/${id.replaceAll(":", "%3A")}`,
    );
    expect(published(test)).toEqual([]);
  });

  it("is fine with a post that LinkedIn does not have, and asks nothing for what is no post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await test.provider.deletePost(credentials, "urn:li:share:1");
    const before = test.requests.length;
    // An ID goes into an address: only what is one gets there.
    const failed = await failure(() =>
      test.provider.deletePost(credentials, "../../v2/userinfo"),
    );
    expect(failed.kind).toBe("fail");
    expect(test.requests).toHaveLength(before);
  });
});

describe("disconnecting", () => {
  it("gives the token back, as the application that it was issued to", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await test.provider.disconnect(credentials);
    const request = test.requests.at(-1);
    expect(request?.url).toBe("https://www.linkedin.com/oauth/v2/revoke");
    expect((await failure(() => step(test, credentials, "Gone"))).kind).toBe(
      "reconnect",
    );
  });
});
