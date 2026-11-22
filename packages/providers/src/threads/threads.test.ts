import type { ContentImage, Fetch, PostContent } from "@pigy/core";
import { pngFile } from "@pigy/core/test-images";
import {
  createThreadsSimulator,
  slowProcessingMs,
} from "@pigy/simulators/threads";
import {
  answerConsent,
  createWorld,
  feed,
  type SimToken,
} from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.ts";
import type { MediaSource, PublishProgress } from "../provider.ts";
import { createThreadsProvider, type ThreadsCredentials } from "./index.ts";

/**
 * What is the Threads adapter's own. What every provider does is in
 * test/conformance.
 */

const redirectUri = "https://pigy.example/connect/threads/callback";
const day = 24 * 60 * 60 * 1000;

type Intercept = (
  request: Request,
) => Promise<Response | undefined> | Response | undefined;

/**
 * The adapter against the simulated Threads. Every request is noted, and
 * `intercept` may answer one in the simulator's place, with what the
 * simulated Threads does not send.
 */
function setup() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createThreadsSimulator(world);
  const app = simulator.addApp({ name: "pigy", redirectUris: [redirectUri] });
  const ada = simulator.addUser({ username: "ada", name: "Ada Lovelace" });
  const grace = simulator.addUser({ username: "grace", name: "Grace Hopper" });
  const requests: Request[] = [];
  const hooks: { intercept?: Intercept } = {};
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return (await hooks.intercept?.(request)) ?? simulator.fetch(request);
  };
  const provider = createThreadsProvider({
    fetch,
    now: world.now,
    appId: app.appId,
    appSecret: app.appSecret,
  });
  return { world, simulator, app, ada, grace, requests, hooks, provider };
}

type Setup = ReturnType<typeof setup>;

async function consented({ provider, simulator }: Setup, user: { id: string }) {
  const start = await provider.beginConnect({ redirectUri });
  const callback = await answerConsent(simulator.fetch, start.url, {
    account: user.id,
  });
  return { pending: start.pending, params: callback.searchParams };
}

async function connect(test: Setup, user: { id: string } = test.ada) {
  const connection = await test.provider.completeConnect(
    await consented(test, user),
  );
  return {
    ...connection,
    credentials: connection.access.credentials as ThreadsCredentials,
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

/** What a request asks of Threads, as "METHOD /path". */
const asked = (request: Request) =>
  `${request.method} ${new URL(request.url).pathname}`;

/** Whether `request` asks Threads to publish a container. */
const publishes = (request: Request) =>
  request.method === "POST" && request.url.includes("/threads_publish");

/** Whether `request` asks Threads to make a container. */
const contains = (request: Request) =>
  request.method === "POST" &&
  new URL(request.url).pathname.endsWith("/threads");

/** One step of a post of `texts`, from `progress`. */
const step = (
  { provider }: Setup,
  credentials: ThreadsCredentials,
  texts: string[],
  progress: PublishProgress | null = null,
) =>
  provider.publishStep({
    credentials,
    content: { parts: texts.map((text) => ({ text })) },
    key: "target-1",
    progress,
  });

/** Runs steps until the post is done, waiting as each asks. */
async function publishAll(
  test: Setup,
  credentials: ThreadsCredentials,
  texts: string[],
  from: PublishProgress | null = null,
) {
  let progress = from;
  for (let steps = 0; !progress?.done; steps++) {
    // An adapter that never finishes must not hang the test.
    expect(steps).toBeLessThan(40);
    if (progress) test.world.advance(progress.waitSeconds * 1000);
    progress = await step(test, credentials, texts, progress);
  }
  return progress;
}

const published = ({ world }: Setup) =>
  feed(world, ["threads"]).map(({ post }) => post.text);

/** Posts `text` as `user` without pigy, as a person does in the app of Threads. */
async function postByHand(
  test: Setup,
  credentials: ThreadsCredentials,
  text: string,
  replyTo?: string,
) {
  const form = (path: string, params: Record<string, string>) =>
    test.simulator
      .fetch(`https://graph.threads.net/v1.0${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...params,
          access_token: credentials.accessToken,
        }).toString(),
      })
      .then((response) => response.json() as Promise<{ id: string }>);
  const { id } = await form("/me/threads", {
    media_type: "TEXT",
    text,
    ...(replyTo && { reply_to_id: replyTo }),
  });
  return (await form("/me/threads_publish", { creation_id: id })).id;
}

describe("connecting", () => {
  it("sends the person to Threads' one place to sign in, whatever they typed", async () => {
    const { provider, app } = setup();
    const { url, state } = await provider.beginConnect({
      redirectUri,
      identifier: "evil.example",
    });
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe(
      "https://threads.net/oauth/authorize",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      client_id: app.appId,
      redirect_uri: redirectUri,
      scope:
        "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_delete,threads_manage_insights",
      response_type: "code",
      state,
    });
  });

  it("exchanges the code for a token of an hour and that for the one that lasts, and names the account", async () => {
    const test = setup();
    const { account, access, credentials } = await connect(test);
    expect(account).toEqual({
      id: test.ada.id,
      handle: "@ada",
      name: "Ada Lovelace",
      avatarUrl: null,
      profileUrl: "https://www.threads.com/@ada",
    });
    expect(test.requests.map(asked)).toEqual([
      "POST /oauth/access_token",
      "GET /access_token",
      "GET /v1.0/me",
    ]);
    // 60 days from now, as Threads said, and renewed after a week of them.
    expect(access.expiresAt).toEqual(new Date("2027-01-14T10:00:00Z"));
    expect(access.refreshAt).toEqual(new Date("2026-11-22T10:00:00Z"));
    // What is kept is the token that lasts: the one of an hour ends a
    // day before the other can first be renewed.
    test.world.advance(2 * day);
    expect((await test.provider.refresh?.(credentials))?.expiresAt).toEqual(
      new Date("2027-01-16T10:00:00Z"),
    );
  });

  it("takes the name of the account from its username where it has none, and a picture only from an HTTPS address", async () => {
    const test = setup();
    test.hooks.intercept = (request) =>
      request.url.includes("/v1.0/me?")
        ? Response.json({
            id: test.ada.id,
            username: "ada",
            threads_profile_picture_url: "http://media.example/ada.jpg",
          })
        : undefined;
    const { account } = await connect(test);
    expect(account).toMatchObject({ name: "ada", avatarUrl: null });
  });

  it("takes a code that still ends with the #_ of Threads", async () => {
    const test = setup();
    const { pending, params } = await consented(test, test.ada);
    params.set("code", `${params.get("code")}#_`);
    const { account } = await test.provider.completeConnect({
      pending,
      params,
    });
    expect(account.id).toBe(test.ada.id);
  });

  it("takes access_denied for a person who said no", async () => {
    const test = setup();
    const { pending } = await test.provider.beginConnect({ redirectUri });
    const { state } = pending as { state: string };
    const failed = await failure(() =>
      test.provider.completeConnect({
        pending,
        params: new URLSearchParams({
          error: "access_denied",
          error_reason: "user_denied",
          error_description: "The user denied your request",
          state,
        }),
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", declined: true });
  });

  it("quotes what a callback says went wrong, without what the connection is made with", async () => {
    const test = setup();
    const { pending } = await test.provider.beginConnect({ redirectUri });
    const { state } = pending as { state: string };
    const failed = await failure(() =>
      test.provider.completeConnect({
        pending,
        params: new URLSearchParams({
          error: "invalid_scope",
          // Anybody can send a browser to the callback address.
          error_description: `Invalid scopes, state ${state}, secret ${test.app.appSecret}`,
          state,
        }),
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", declined: false });
    expect(failed.message).toContain("Invalid scopes");
    expect(failed.message).not.toContain(state);
    expect(failed.message).not.toContain(test.app.appSecret);
  });

  it("fails for good, and names no secret, when Threads repeats the request in its refusal", async () => {
    const test = setup();
    const callback = await consented(test, test.ada);
    const code = callback.params.get("code") ?? "";
    let shortToken = "";
    test.hooks.intercept = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/access_token") {
        const answer = await test.simulator.fetch(request);
        ({ access_token: shortToken } = (await answer.clone().json()) as {
          access_token: string;
        });
        return answer;
      }
      if (url.pathname !== "/access_token") return undefined;
      // The secret of the app and the token travel in the address of
      // this request, and a server may quote an address.
      return Response.json(
        { error: { message: `Cannot exchange at ${request.url}`, code: 100 } },
        { status: 400 },
      );
    };
    const failed = await failure(() => test.provider.completeConnect(callback));
    expect(failed.kind).toBe("fail");
    expect(shortToken).not.toBe("");
    for (const secret of [test.app.appSecret, shortToken, code]) {
      expect(failed.message).not.toContain(encodeURIComponent(secret));
    }
  });
});

describe("the access", () => {
  it("is renewed with a token that lasts 60 days from then", async () => {
    const test = setup();
    const { access, credentials } = await connect(test);
    test.world.advance(7 * day);
    const renewed = await test.provider.refresh?.(credentials);
    expect(renewed?.credentials).not.toEqual(credentials);
    expect(renewed?.expiresAt).toEqual(
      new Date((access.expiresAt?.getTime() ?? 0) + 7 * day),
    );
    expect(renewed?.refreshAt).toEqual(new Date("2026-11-29T10:00:00Z"));
  });

  it("asks for a new connection when the token has ended: Threads renews none that has", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.world.advance(60 * day);
    expect(
      (await failure(async () => test.provider.refresh?.(credentials))).kind,
    ).toBe("reconnect");
    // A step does not ask for a refresh either, which could cure nothing.
    expect(
      (await failure(() => step(test, credentials, ["Too late"]))).kind,
    ).toBe("reconnect");
  });

  it("asks to renew later when Threads is out of reach or in trouble", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.world.advance(7 * day);
    test.simulator.arm({ kind: "server-error", operation: "refresh" });
    expect(
      (await failure(async () => test.provider.refresh?.(credentials))).kind,
    ).toBe("retry");
    test.simulator.arm({ kind: "lost-response", operation: "refresh" });
    expect(
      (await failure(async () => test.provider.refresh?.(credentials))).kind,
    ).toBe("retry");
  });

  it("is not given back: disconnecting sends nothing and says that it could not", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const before = test.requests.length;
    const failed = await failure(() => test.provider.disconnect(credentials));
    expect(failed.kind).toBe("fail");
    expect(failed.message).not.toContain(credentials.accessToken);
    expect(test.requests).toHaveLength(before);
  });
});

describe("publishing", () => {
  it("makes a container in one step and publishes it in the next, having asked for its status", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.requests.length = 0;

    const first = await step(test, credentials, ["Hello"]);
    expect(first).toMatchObject({ parts: [], done: false, waitSeconds: 0 });
    // Nothing is published by a container.
    expect(published(test)).toEqual([]);
    expect(test.requests.map(asked)).toEqual([
      "GET /v1.0/me/threads",
      "POST /v1.0/me/threads",
    ]);
    // The token travels in the form of a request that has one, and in no
    // address then.
    const made = test.requests[1];
    expect(made?.url).not.toContain(credentials.accessToken);
    expect(Object.fromEntries(new URLSearchParams(await made?.text()))).toEqual(
      {
        media_type: "TEXT",
        text: "Hello",
        access_token: credentials.accessToken,
      },
    );
    // And never in what is recorded of the step.
    expect(JSON.stringify(first)).not.toContain(credentials.accessToken);

    test.requests.length = 0;
    const second = await step(test, credentials, ["Hello"], first);
    expect(second).toMatchObject({ done: true, waitSeconds: 0, state: null });
    const [post] = feed(test.world, ["threads"]);
    expect(second.parts).toEqual([{ id: post?.post.id, url: post?.post.url }]);
    expect(test.requests.map(asked)).toEqual([
      expect.stringMatching(/^GET \/v1\.0\/\d+$/),
      "POST /v1.0/me/threads_publish",
      `GET /v1.0/${post?.post.id}`,
    ]);
  });

  it("publishes a thread as a chain of replies", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await publishAll(test, credentials, [
      "One",
      "Two",
      "Three",
    ]);
    const posts = feed(test.world, ["threads"]).map(({ post }) => post);
    expect(posts.map(({ text }) => text)).toEqual(["One", "Two", "Three"]);
    expect(posts.map(({ replyToId }) => replyToId)).toEqual([
      null,
      posts[0]?.id,
      posts[1]?.id,
    ]);
    expect(progress.parts.map(({ id }) => id)).toEqual(
      posts.map(({ id }) => id),
    );
  });

  it("finds a first part whose answer was lost among what the account has posted since, and takes nothing from before", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The same text, from before the delivery: by hand, or by a delivery
    // long ago.
    const older = await postByHand(test, credentials, "Hello");
    test.world.advance(1000);

    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect(
      (await failure(() => step(test, credentials, ["Hello"], made))).kind,
    ).toBe("retry");
    expect(published(test)).toEqual(["Hello", "Hello"]);
    const own = feed(test.world, ["threads"])[1]?.post;
    // And once more since, by hand.
    test.world.advance(1000);
    const newer = await postByHand(test, credentials, "Hello");

    // Days later, the step is run again with what was recorded.
    test.world.advance(3 * day);
    test.requests.length = 0;
    const progress = await step(test, credentials, ["Hello"], made);
    expect(progress.done).toBe(true);
    expect(progress.parts).toEqual([{ id: own?.id, url: own?.url }]);
    expect(progress.parts[0]?.id).not.toBe(older);
    expect(progress.parts[0]?.id).not.toBe(newer);
    // It has published nothing.
    expect(test.requests.filter(publishes)).toEqual([]);
    expect(published(test)).toHaveLength(3);
  });

  it("looks at nothing that is older than the post that was the newest when the delivery began, also when that one is gone", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await postByHand(test, credentials, "Hello");
    test.world.advance(1000);
    const newest = await postByHand(test, credentials, "Something else");
    test.world.advance(1000);

    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    // The person deletes the post by which the step would know where
    // the delivery began.
    await test.provider.deletePost(credentials, newest);

    const progress = await step(test, credentials, ["Hello"], made);
    expect(progress.parts).toEqual([{ id: own?.id, url: own?.url }]);
  });

  it("finds a later part whose answer was lost among the replies to the part before it, and takes nobody else's", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The first part is published, the second has its container.
    let progress = await step(test, credentials, ["One", "Two"]);
    progress = await step(test, credentials, ["One", "Two"], progress);
    progress = await step(test, credentials, ["One", "Two"], progress);
    expect(progress.parts).toHaveLength(1);
    const first = progress.parts[0]?.id ?? "";

    // Somebody else replies with the same words, before and after, in
    // the app of Threads: no app replies under a post of another account.
    const byGrace = () =>
      test.simulator.addPost(test.grace.id, { text: "Two", replyToId: first });
    byGrace();
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["One", "Two"], progress));
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    byGrace();

    test.requests.length = 0;
    const done = await step(test, credentials, ["One", "Two"], progress);
    expect(done.done).toBe(true);
    expect(done.parts[1]).toEqual({ id: own?.id, url: own?.url });
    expect(test.requests.filter(publishes)).toEqual([]);
  });

  it("says that it cannot find a part that Threads has published, and does not publish it again", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    // The person deletes the post before pigy has heard of it.
    const [post] = feed(test.world, ["threads"]);
    await test.provider.deletePost(credentials, post?.post.id ?? "");

    test.requests.length = 0;
    // The lists of Threads may be behind, so the step looks three times
    // more, ten seconds apart, and counts that in what it records.
    let progress = made;
    for (let look = 1; look <= 3; look++) {
      progress = await step(test, credentials, ["Hello"], progress);
      expect(progress).toMatchObject({
        parts: [],
        done: false,
        waitSeconds: 10,
        state: { looks: look },
      });
    }
    // Then, however often it is asked: the container says that it was
    // published.
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await failure(() =>
        step(test, credentials, ["Hello"], progress),
      );
      expect(failed.kind).toBe("uncertain");
      expect(failed.message).not.toContain(credentials.accessToken);
    }
    expect(test.requests.filter(publishes)).toEqual([]);
    expect(test.requests.filter(contains)).toEqual([]);
    expect(published(test)).toEqual([]);
  });

  it("finds a part that Threads has published and lists only some seconds later", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const [own] = feed(test.world, ["threads"]);
    // The container says that it is published, and the list of the
    // account's posts does not have the post yet.
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("/me/threads?")
        ? Response.json({ data: [] })
        : undefined;
    const waiting = await step(test, credentials, ["Hello"], made);
    expect(waiting).toMatchObject({ parts: [], done: false, waitSeconds: 10 });

    delete test.hooks.intercept;
    const progress = await step(test, credentials, ["Hello"], waiting);
    expect(progress).toMatchObject({
      done: true,
      parts: [{ id: own?.post.id }],
    });
    expect(published(test)).toEqual(["Hello"]);
  });

  it("takes no post of the same second from before the delivery for its own, also when the newest of then is gone", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // Two posts within one second, which is as exactly as Threads says a
    // time: the same words as the delivery's, and then the post that is
    // the newest when the delivery begins.
    const older = await postByHand(test, credentials, "Hello");
    test.world.advance(100);
    const newest = await postByHand(test, credentials, "Something else");
    test.world.advance(100);

    // The delivery begins in that second too, and so does its post.
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    expect(own?.id).not.toBe(older);
    await test.provider.deletePost(credentials, newest);

    const progress = await step(test, credentials, ["Hello"], made);
    // Not the one from before: a thread would go on under it.
    expect(progress.parts).toEqual([{ id: own?.id, url: own?.url }]);
  });

  it("takes no post of the same second from before the delivery for its own when that second has more posts than one list holds", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // 101 posts in one second, which an import or another tool can make:
    // the oldest has the words of the delivery, and one list of Threads
    // holds the 100 after it.
    const older = test.simulator.addPost(test.ada.id, { text: "Hello" }).id;
    for (let number = 1; number <= 100; number++) {
      test.simulator.addPost(test.ada.id, { text: `Other ${number}` });
    }

    // The delivery begins in that second too, and so does its post.
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    expect(own?.id).not.toBe(older);

    const progress = await step(test, credentials, ["Hello"], made);
    // Not the one from before, which the first list did not have.
    expect(progress.parts).toEqual([{ id: own?.id, url: own?.url }]);
  });

  it("cannot tell a post of the second in which the delivery began from its own when that second has more posts than it reads through", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const older = test.simulator.addPost(test.ada.id, { text: "Hello" }).id;
    // More in that second than the step reads when it notes where the
    // posts of the account stand: three lists of a hundred.
    for (let number = 1; number <= 300; number++) {
      test.simulator.addPost(test.ada.id, { text: `Other ${number}` });
    }
    test.requests.length = 0;
    const made = await step(test, credentials, ["Hello"]);
    // It gave up, and did not read for ever.
    expect(
      test.requests.filter(
        (request) => asked(request) === "GET /v1.0/me/threads",
      ),
    ).toHaveLength(3);

    // A second later, so that the post of the delivery is not of that
    // second: only the one from before is.
    test.world.advance(1000);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    expect(published(test).filter((text) => text === "Hello")).toHaveLength(2);
    // The own post is gone, and the one from before is left, which the
    // step did not note: it must not be taken, and a thread go on under it.
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    expect(own?.id).not.toBe(older);
    await test.provider.deletePost(credentials, own?.id ?? "");

    // The look that follows reads that second to its end, which is
    // within what it reads through, and finds the one from before.
    const error = await failure(() => step(test, credentials, ["Hello"], made));
    expect(error.kind).toBe("uncertain");
    expect(published(test).filter((text) => text === "Hello")).toHaveLength(1);
  });

  it("takes no post with a photo, a quote or a poll for its own, whatever its words", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    // The person posts the same words in the app of Threads after the
    // delivery began and before its part is published: with a photo,
    // quoting a post, and with a poll.
    const byHand = [
      test.simulator.addPost(test.ada.id, { text: "Hello", media: "IMAGE" }),
      test.simulator.addPost(test.ada.id, { text: "Hello", quote: true }),
      test.simulator.addPost(test.ada.id, { text: "Hello", poll: true }),
    ].map(({ id }) => id);
    test.world.advance(1000);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const own = feed(test.world, ["threads"]).at(-1)?.post;
    expect(byHand).not.toContain(own?.id);

    // The oldest post since that reads like the part is one of those
    // three, and none of them is plain text.
    const progress = await step(test, credentials, ["Hello"], made);
    expect(progress.parts).toEqual([{ id: own?.id, url: own?.url }]);
  });

  it("says that it cannot find a part when the account has posted more since than it is willing to read", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    // A list that goes on and on, with other posts than the one.
    let pages = 0;
    test.hooks.intercept = (request) => {
      const url = new URL(request.url);
      if (request.method !== "GET" || !url.pathname.endsWith("/me/threads")) {
        return undefined;
      }
      pages++;
      return Response.json({
        data: [{ id: String(900 + pages), text: "Another post" }],
        paging: { cursors: { after: `page-${pages}` } },
      });
    };
    const error = await failure(() => step(test, credentials, ["Hello"], made));
    expect(error.kind).toBe("uncertain");
    // It gave up, and did not read for ever.
    expect(pages).toBe(5);
    // Threads has said that the post is published, so the message does
    // not doubt that, and does not advise to publish it anew, which
    // would post it twice.
    expect(error.message).toBe(
      "Threads says that it has published the post. pigy could not look through enough of the account to find it, and does not post it a second time: look at the account.",
    );
  });

  it("says the same when a post of the account has no time that pigy can read, which is where it stops looking", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The account has a post, so the delivery notes a time to look back to.
    await postByHand(test, credentials, "From before");
    test.world.advance(1000);
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    test.hooks.intercept = (request) => {
      const url = new URL(request.url);
      if (request.method !== "GET" || !url.pathname.endsWith("/me/threads")) {
        return undefined;
      }
      // One post, and nothing that says when it was made: the account
      // has not posted more than pigy reads.
      return Response.json({ data: [{ id: "901", text: "Another post" }] });
    };
    const error = await failure(() => step(test, credentials, ["Hello"], made));
    expect(error.kind).toBe("uncertain");
    expect(error.message).toBe(
      "Threads says that it has published the post. pigy could not look through enough of the account to find it, and does not post it a second time: look at the account.",
    );
    expect(published(test)).toEqual(["From before", "Hello"]);
  });

  it("makes no new container when Threads has forgotten the one it had and the account has posted more since than it is willing to read", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    // Published, with the answer lost: the post is there.
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    test.requests.length = 0;
    let pages = 0;
    test.hooks.intercept = (request) => {
      const url = new URL(request.url);
      if (request.method !== "GET") return undefined;
      // Days later Threads no longer knows the container, which says
      // nothing of whether it was published.
      if (url.searchParams.get("fields")?.startsWith("status")) {
        return Response.json(
          { error: { message: "Gone", code: 100, error_subcode: 33 } },
          { status: 400 },
        );
      }
      if (!url.pathname.endsWith("/me/threads")) return undefined;
      // And the account has posted so much since that the step stops
      // reading before it comes to the post.
      pages++;
      return Response.json({
        data: [{ id: String(900 + pages), text: "Another post" }],
        paging: { cursors: { after: `page-${pages}` } },
      });
    };
    // Not having found the post is not knowing that there is none: a new
    // container would be published as a second post.
    expect(
      (await failure(() => step(test, credentials, ["Hello"], made))).kind,
    ).toBe("uncertain");
    expect(pages).toBe(5);
    expect(test.requests.filter(contains)).toEqual([]);
    expect(published(test)).toEqual(["Hello"]);
  });

  it("waits for a container that Threads is still preparing, and publishes it when it is ready", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.simulator.arm({ kind: "slow-processing" });
    const made = await step(test, credentials, ["Slowly"]);
    const waiting = await step(test, credentials, ["Slowly"], made);
    // Nothing but a wait: the same container, asked about again later.
    expect(waiting).toMatchObject({ parts: [], done: false, waitSeconds: 10 });
    expect(published(test)).toEqual([]);

    const progress = await publishAll(test, credentials, ["Slowly"], waiting);
    expect(progress.done).toBe(true);
    expect(published(test)).toEqual(["Slowly"]);
    // One container was enough.
    expect(test.requests.filter(contains)).toHaveLength(1);
  });

  it("asks to be tried again later when a container is not ready after a minute of asking", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.simulator.arm({ kind: "slow-processing" });
    let progress = await step(test, credentials, ["Slowly"]);
    // The clock stands still, so the container never gets ready.
    for (let poll = 0; poll < 6; poll++) {
      progress = await step(test, credentials, ["Slowly"], progress);
      expect(progress.waitSeconds).toBe(10);
    }
    expect(
      (await failure(() => step(test, credentials, ["Slowly"], progress))).kind,
    ).toBe("retry");
    // Tried again when it is ready, the step publishes the same container.
    test.world.advance(slowProcessingMs);
    expect((await step(test, credentials, ["Slowly"], progress)).done).toBe(
      true,
    );
    expect(test.requests.filter(contains)).toHaveLength(1);
  });

  it("makes a new container when the one it has is a day old, and publishes that one in a step of its own", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await postByHand(test, credentials, "From before");
    const made = await step(test, credentials, ["Late"]);
    test.world.advance(day);
    test.requests.length = 0;

    const again = await step(test, credentials, ["Late"], made);
    // Nothing is published by the step that finds the container expired.
    expect(again).toMatchObject({ parts: [], done: false });
    expect(test.requests.filter(publishes)).toEqual([]);
    expect(test.requests.filter(contains)).toHaveLength(1);
    // The new container is recorded, with where the delivery began.
    const state = (progress: PublishProgress) =>
      progress.state as { container: string; after: unknown };
    expect(state(again).container).not.toBe(state(made).container);
    expect(state(again).after).toEqual(state(made).after);

    expect((await step(test, credentials, ["Late"], again)).done).toBe(true);
    expect(published(test)).toEqual(["From before", "Late"]);
  });

  it("looks for the post when Threads no longer knows the container, and makes a new one only if there is none", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // What Threads says of an ID that it has nothing under.
    const forgotten = (request: Request) =>
      request.method === "GET" && request.url.includes("fields=status")
        ? Response.json(
            {
              error: {
                message: "Unsupported get request. Object does not exist",
                type: "THApiException",
                code: 100,
                error_subcode: 33,
              },
            },
            { status: 400 },
          )
        : undefined;

    // Published, with the answer lost, and forgotten since: the post is
    // found, and nothing is sent.
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    test.hooks.intercept = forgotten;
    test.requests.length = 0;
    const found = await step(test, credentials, ["Hello"], made);
    expect(found.done).toBe(true);
    expect(test.requests.filter(contains)).toEqual([]);
    expect(published(test)).toEqual(["Hello"]);

    // Never published, and forgotten: a new container, for the next step.
    delete test.hooks.intercept;
    const other = await step(test, credentials, ["Another"]);
    test.hooks.intercept = forgotten;
    test.requests.length = 0;
    const again = await step(test, credentials, ["Another"], other);
    expect(again).toMatchObject({ parts: [], done: false });
    expect(test.requests.filter(contains)).toHaveLength(1);
    expect(test.requests.filter(publishes)).toEqual([]);
    delete test.hooks.intercept;
    expect((await step(test, credentials, ["Another"], again)).done).toBe(true);
    expect(published(test)).toEqual(["Hello", "Another"]);
  });

  it("looks for the post before it makes a new container for one that says that it has expired", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await failure(() => step(test, credentials, ["Hello"], made));
    const [own] = feed(test.world, ["threads"]);
    // What the simulated Threads never says of a container that was
    // published, and what nobody knows of the real one.
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("fields=status")
        ? Response.json({ status: "EXPIRED" })
        : undefined;
    test.requests.length = 0;
    const progress = await step(test, credentials, ["Hello"], made);
    expect(progress).toMatchObject({
      done: true,
      parts: [{ id: own?.post.id }],
    });
    expect(test.requests.filter(contains)).toEqual([]);
    expect(published(test)).toEqual(["Hello"]);
  });

  it("goes by the status of the container when Threads refuses to publish it: published, it finds the post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    // Threads says that the container is ready, and something else
    // publishes it before the step does: a run of the same step that was
    // taken for dead. The simulated Threads refuses the second request.
    const container = (made.state as { container: string }).container;
    test.hooks.intercept = async (request) => {
      if (!publishes(request)) return undefined;
      await test.simulator.fetch(request.clone());
      return undefined;
    };
    test.requests.length = 0;
    const progress = await step(test, credentials, ["Hello"], made);
    const [own] = feed(test.world, ["threads"]);
    expect(progress).toMatchObject({
      done: true,
      parts: [{ id: own?.post.id, url: own?.post.url }],
    });
    expect(published(test)).toEqual(["Hello"]);
    // It asked for the status before and after the refusal.
    expect(
      test.requests.map(asked).filter((it) => it === `GET /v1.0/${container}`),
    ).toHaveLength(2);
  });

  it("goes by the status of the container when Threads refuses to publish it: not ready after all, it waits", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.simulator.arm({ kind: "slow-processing" });
    const made = await step(test, credentials, ["Slowly"]);
    // Threads says once that the container is ready, too early.
    let asks = 0;
    test.hooks.intercept = (request) =>
      request.method === "GET" &&
      request.url.includes("fields=status") &&
      asks++ === 0
        ? Response.json({ status: "FINISHED" })
        : undefined;
    const waiting = await step(test, credentials, ["Slowly"], made);
    expect(waiting).toMatchObject({ parts: [], done: false, waitSeconds: 10 });
    expect(published(test)).toEqual([]);

    const progress = await publishAll(test, credentials, ["Slowly"], waiting);
    expect(progress.done).toBe(true);
    expect(published(test)).toEqual(["Slowly"]);
  });

  it("fails with what Threads said when it refuses to publish a container that is still ready", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.hooks.intercept = (request) =>
      publishes(request)
        ? Response.json(
            { error: { message: "This post is not allowed", code: 100 } },
            { status: 400 },
          )
        : undefined;
    const failed = await failure(() =>
      step(test, credentials, ["Hello"], made),
    );
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("This post is not allowed");
    expect(published(test)).toEqual([]);
  });

  it("asks to try again when Threads answers with the error that it has no better word for", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.hooks.intercept = (request) =>
      publishes(request)
        ? Response.json(
            {
              error: {
                message: "An unknown error has occurred.",
                type: "OAuthException",
                code: 1,
              },
            },
            // Not a status that says by itself that Threads is in trouble.
            { status: 400 },
          )
        : undefined;
    expect(
      (await failure(() => step(test, credentials, ["Hello"], made))).kind,
    ).toBe("retry");
    // The step that is tried again looks at the container first, and
    // publishes it once.
    delete test.hooks.intercept;
    expect((await step(test, credentials, ["Hello"], made)).done).toBe(true);
    expect(published(test)).toEqual(["Hello"]);
  });

  it("fails with what Threads says of a container that it could not prepare", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("fields=status")
        ? Response.json({ status: "ERROR", error_message: "UNKNOWN" })
        : undefined;
    const failed = await failure(() =>
      step(test, credentials, ["Hello"], made),
    );
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("UNKNOWN");
    expect(published(test)).toEqual([]);
  });

  it("records a part without its link when Threads publishes it and then does not say the link", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    // Threads fails when it is asked for the link, and for nothing else.
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("permalink")
        ? Response.json(
            { error: { message: "An unknown error occurred", code: 2 } },
            { status: 500 },
          )
        : undefined;
    const progress = await step(test, credentials, ["Hello"], made);
    const [post] = feed(test.world, ["threads"]);
    expect(progress).toMatchObject({
      done: true,
      parts: [{ id: post?.post.id, url: null }],
    });
  });

  it("asks to try again later when Threads says that the account has posted too often", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const made = await step(test, credentials, ["Hello"]);
    test.hooks.intercept = (request) =>
      publishes(request)
        ? Response.json(
            {
              error: {
                message:
                  "(#613) Calls to this api have exceeded the rate limit.",
                type: "OAuthException",
                code: 613,
              },
            },
            { status: 403 },
          )
        : undefined;
    const failed = await failure(() =>
      step(test, credentials, ["Hello"], made),
    );
    expect(failed.kind).toBe("retry");
  });

  it("fails with what Threads says of a post that it refuses", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const failed = await failure(() =>
      step(test, credentials, ["a".repeat(501)]),
    );
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("500 characters");
  });

  it("does not go on from progress that it cannot read", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const failed = await failure(() =>
      step(test, credentials, ["Hello"], {
        parts: [],
        done: false,
        waitSeconds: 0,
        state: { container: "not a number" },
      }),
    );
    expect(failed.kind).toBe("fail");
    expect(test.requests.filter(contains)).toEqual([]);
  });
});

describe("images", () => {
  /**
   * The adapter against a simulated Threads whose web serves the images
   * of a test at links that the source hands out, as pigy serves its
   * signed links, until `revoked` says otherwise. Every link that the
   * source handed out, and every address that Threads fetched, is noted.
   */
  async function withImages(...alts: string[]) {
    const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
    const links: string[] = [];
    const fetched: string[] = [];
    const served = new Map<string, Uint8Array>();
    const hooks: { intercept?: Intercept; unreachable?: boolean } = {};
    const simulator = createThreadsSimulator(world, {
      web: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        fetched.push(url);
        const bytes = served.get(url);
        if (hooks.unreachable || !bytes) {
          return new Response("Nothing here", { status: 404 });
        }
        return new Response(bytes as Uint8Array<ArrayBuffer>);
      },
    });
    const app = simulator.addApp({ name: "pigy", redirectUris: [redirectUri] });
    const ada = simulator.addUser({ username: "ada", name: "Ada Lovelace" });
    const requests: Request[] = [];
    const fetch: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return (await hooks.intercept?.(request)) ?? simulator.fetch(request);
    };
    const provider = createThreadsProvider({
      fetch,
      now: world.now,
      appId: app.appId,
      appSecret: app.appSecret,
    });
    const test = {
      world,
      simulator,
      app,
      ada,
      grace: ada,
      requests,
      hooks,
      provider,
    };
    const { credentials } = await connect(test);
    const images: ContentImage[] = [];
    const bytesOf = new Map<string, Uint8Array>();
    for (const [index, alt] of alts.entries()) {
      const bytes = await pngFile(400 + index, 300);
      const image: ContentImage = {
        id: `image-${index + 1}`,
        type: "image/png",
        size: bytes.length,
        width: 400 + index,
        height: 300,
        alt,
      };
      images.push(image);
      bytesOf.set(image.id, bytes);
    }
    const media: MediaSource = {
      read: async () => {
        throw new Error("Threads takes no bytes");
      },
      link: async (id) => {
        const link = `https://pigy.example/api/media-links/${id}?signature=${crypto.randomUUID()}`;
        links.push(link);
        served.set(link, bytesOf.get(id) ?? new Uint8Array());
        return link;
      },
    };
    /** One step of a post of `text` with the images, from `progress`. */
    const imageStep = (progress: PublishProgress | null, text = "Images") =>
      provider.publishStep({
        credentials,
        content: { parts: [{ text, media: images }] } satisfies PostContent,
        key: "target-1",
        progress,
        media,
      });
    /** Runs steps until the post is done, waiting as each asks. */
    const all = async (from: PublishProgress | null = null) => {
      const steps: PublishProgress[] = [];
      let progress = from;
      while (!progress?.done) {
        expect(steps.length).toBeLessThan(40);
        if (progress) world.advance(progress.waitSeconds * 1000);
        progress = await imageStep(progress);
        steps.push(JSON.parse(JSON.stringify(progress)) as PublishProgress);
      }
      return steps;
    };
    return { ...test, credentials, links, fetched, images, imageStep, all };
  }

  it("hands Threads a link to an image that it makes in the step that hands it over, and keeps it nowhere", async () => {
    const test = await withImages("A harbour");
    const steps = await test.all();

    // A container of the image, which Threads fetched from the one link,
    // and its publishing.
    expect(test.requests.filter(contains)).toHaveLength(1);
    expect(test.links).toHaveLength(1);
    expect(test.fetched).toEqual(test.links);
    for (const link of test.links) {
      expect(JSON.stringify(steps)).not.toContain(link);
    }
    expect(JSON.stringify(steps)).not.toContain("signature=");
    const [{ post } = { post: undefined }] = feed(test.world, ["threads"]);
    expect(post?.images).toMatchObject([
      { alt: "A harbour", width: 400, height: 300 },
    ]);
  });

  it("makes a carousel of a part with several images: an item in a step each, then the carousel of them", async () => {
    const test = await withImages("One", "", "Three");
    const steps = await test.all();

    // Three items, the carousel and its publishing.
    expect(steps.map(({ parts }) => parts.length)).toEqual([0, 0, 0, 0, 1]);
    expect(steps[2]?.state).toMatchObject({
      container: null,
      items: [expect.any(String), expect.any(String), expect.any(String)],
    });
    expect(test.links).toHaveLength(3);
    expect(
      feed(test.world, ["threads"]).map(({ post }) => [
        post.text,
        post.images?.map(({ alt, width }) => [alt, width]),
      ]),
    ).toEqual([
      [
        "Images",
        [
          ["One", 400],
          ["", 401],
          ["Three", 402],
        ],
      ],
    ]);
    // Read back as what it is.
    const [part] = steps.at(-1)?.parts ?? [];
    const read = await test.provider.readPost?.(
      test.credentials,
      part?.id ?? "",
    );
    expect(read?.images).toEqual([
      { alt: "One" },
      { alt: "" },
      { alt: "Three" },
    ]);
  });

  it("waits for the items of a carousel that Threads is still preparing, and makes the carousel when they are ready", async () => {
    const test = await withImages("One", "Two");
    let progress = await test.imageStep(null);
    // Threads takes its time with the second.
    test.simulator.arm({ kind: "slow-processing", operation: "container" });
    progress = await test.imageStep(progress);
    progress = await test.imageStep(progress);
    expect(progress).toMatchObject({
      waitSeconds: 10,
      state: { container: null },
    });
    expect(test.requests.filter(contains)).toHaveLength(2);

    test.world.advance(slowProcessingMs);
    progress = await test.imageStep(progress);
    expect(progress.state).toMatchObject({ container: expect.any(String) });
    await test.all(progress);
    expect(feed(test.world, ["threads"])[0]?.post.images).toHaveLength(2);
  });

  it("makes the items of a carousel anew when Threads no longer knows one, and publishes nothing with them", async () => {
    const test = await withImages("One", "Two");
    let progress = await test.imageStep(null);
    progress = await test.imageStep(progress);
    const [first = ""] =
      (progress.state as { items?: string[] } | null)?.items ?? [];
    // Expired: an item is a container, which lasts a day.
    test.world.advance(day);
    progress = await test.imageStep(progress);
    expect(progress).toMatchObject({ parts: [], state: { items: [] } });
    expect(test.requests.filter(publishes)).toHaveLength(0);

    await test.all(progress);
    expect(test.links).toHaveLength(4);
    const [{ post } = { post: undefined }] = feed(test.world, ["threads"]);
    expect(post?.images).toHaveLength(2);
    expect(first).not.toBe("");
  });

  it("fails with what Threads says of an image that it could not fetch, without the link", async () => {
    const test = await withImages("Unreachable");
    test.hooks.unreachable = true;
    const error = await failure(() => test.all());
    expect(error.kind).toBe("fail");
    expect(error.message).toContain("Threads could not prepare the post");
    for (const link of test.links) {
      expect(error.message).not.toContain(link);
    }
    expect(feed(test.world, ["threads"])).toEqual([]);
  });

  it("says no address in a message of Threads, which can repeat the link of an image", async () => {
    const test = await withImages("Repeated");
    test.hooks.intercept = (request) =>
      request.method === "GET" &&
      /\/v1\.0\/\d+$/.test(new URL(request.url).pathname)
        ? Response.json({
            status: "ERROR",
            error_message: `Could not fetch ${test.links.at(-1)} in time`,
          })
        : undefined;
    const error = await failure(() => test.all());
    expect(error.message).toBe(
      "Threads could not prepare the post: Could not fetch an address in time",
    );
  });

  it("fails a part with images without a source of them, and asks nothing", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const error = await failure(() =>
      test.provider.publishStep({
        credentials,
        content: {
          parts: [
            {
              text: "No source",
              media: [
                {
                  id: "image-1",
                  type: "image/png",
                  size: 10,
                  width: 10,
                  height: 10,
                  alt: "",
                },
              ],
            },
          ],
        },
        key: "target-1",
        progress: null,
      }),
    );
    expect(error.kind).toBe("fail");
    expect(test.requests.filter(contains)).toHaveLength(0);
  });

  it("takes no post of the same words with other images, or none, for a part whose answer was lost", async () => {
    const test = await withImages("Mine");
    // The container is made and published, and the answer of the latter
    // is lost.
    let progress = await test.imageStep(null);
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    await expect(test.imageStep(progress)).rejects.toMatchObject({
      kind: "retry",
    });
    // Meanwhile the person posts the same words twice by hand: as text,
    // and with a photo that says something else.
    test.simulator.addPost(test.ada.id, { text: "Images" });
    test.simulator.addPost(test.ada.id, {
      text: "Images",
      media: "IMAGE",
      images: [
        {
          blob: "none",
          type: "image/png",
          width: 1,
          height: 1,
          size: 1,
          alt: "Another",
        },
      ],
    });
    const own = feed(test.world, ["threads"])[0]?.post.id;
    progress = await test.imageStep(progress);
    expect(progress.parts.map(({ id }) => id)).toEqual([own]);
    // Asked to publish once: the step that was run again found its post.
    expect(test.requests.filter(publishes)).toHaveLength(1);
  });
});

describe("reading and deleting", () => {
  it("reads a post with what it replies to, and nothing for one that is gone", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await publishAll(test, credentials, ["One", "Two"]);
    const [first, second] = parts;
    expect(
      await test.provider.readPost?.(credentials, second?.id ?? ""),
    ).toEqual({
      id: second?.id,
      url: second?.url,
      text: "Two",
      replyToId: first?.id,
      images: [],
    });
    await test.provider.deletePost(credentials, second?.id ?? "");
    expect(
      await test.provider.readPost?.(credentials, second?.id ?? ""),
    ).toBeNull();
    // What is no ID of Threads is not asked about.
    const before = test.requests.length;
    expect(await test.provider.readPost?.(credentials, "../me")).toBeNull();
    expect(
      (await failure(() => test.provider.deletePost(credentials, "../me")))
        .kind,
    ).toBe("fail");
    expect(test.requests).toHaveLength(before);
  });
});

describe("stats", () => {
  it("reads the insights of a post: its views, likes, replies, reposts and quotes", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await publishAll(test, credentials, ["Counted"]);
    const id = parts[0]?.id ?? "";
    test.world.engage("threads", id, { views: 120, likes: 7, reposts: 1 });

    expect(await test.provider.metrics?.(credentials, id)).toEqual({
      views: 120,
      likes: 7,
      replies: 0,
      reposts: 1,
      quotes: 0,
    });
    expect(asked(test.requests.at(-1) as Request)).toBe(
      `GET /v1.0/${id}/insights`,
    );
  });

  it("says why there are none for an account that was connected before pigy asked for them", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await publishAll(test, credentials, ["Counted"]);
    // A token as Threads gave one out to pigy before it asked for the
    // permission to read insights: with the five permissions of before.
    const older = test.world.issueToken<
      SimToken & { kind: "long"; createdAt: number }
    >({
      network: "threads",
      accountId: test.ada.id,
      clientId: test.app.appId,
      scopes: [
        "threads_basic",
        "threads_content_publish",
        "threads_manage_replies",
        "threads_read_replies",
        "threads_delete",
      ],
      kind: "long",
      createdAt: test.world.now().getTime(),
      expiresAt: test.world.now().getTime() + 60 * day,
    });

    const error = await failure(async () =>
      test.provider.metrics?.({ accessToken: older.token }, parts[0]?.id ?? ""),
    );

    // Not a channel to connect again for posting: the post is fine, and
    // so is the access, for what it reaches.
    expect(error.kind).toBe("fail");
    expect(error.message).toBe(
      "Threads lets pigy read the stats of this account once it is connected again.",
    );
  });

  it("says that a post is gone that Threads no longer has, and asks for a new connection for a token that it refuses", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await publishAll(test, credentials, ["Counted"]);
    const id = parts[0]?.id ?? "";

    await test.provider.deletePost(credentials, id);
    expect(await test.provider.metrics?.(credentials, id)).toBeNull();

    test.world.revokeToken("threads", credentials.accessToken);
    const error = await failure(async () =>
      test.provider.metrics?.(credentials, id),
    );
    expect(error.kind).toBe("reconnect");
  });
});
