import {
  connectErrorSchema,
  type SandboxPost,
  sandboxFeedSchema,
} from "@pigy/core";
import { slowProcessingMs } from "@pigy/simulators/threads";
import { feed, type SimToken } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { sandboxThreadsApp } from "../src/network/threads-app.ts";
import {
  channelsOf,
  connectThreadsInSandbox,
  connectThreadsLive,
  consentInSandbox,
  consentUrl,
  disconnected,
  outcomeOf,
  pathOf,
  sandboxThreadsHandle,
  startConnect,
  storedAccess,
  worldEntries,
} from "./channels.ts";
import { clock } from "./clock.ts";
import { adminEmail, setup, signedIn, urlOf } from "./helpers.ts";
import {
  ended,
  publishedOf,
  publishTo,
  started,
  targetOf,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient, workspaceIds } from "./sync-client.ts";

/**
 * Threads in the Worker: connecting an account in a sandbox and for real,
 * publishing a post and a thread, which is a chain of replies there, each
 * made of a container that is then published, and what the pipeline does
 * when Threads fails. test/renewal.test.ts has how its access is renewed.
 */

const day = 24 * 60 * 60 * 1000;
const graph = "https://graph.threads.net";

/** The request that asks Threads to publish a container. */
const publishRequest = `POST ${graph}/v1.0/me/threads_publish`;
/** The request that asks Threads to make a container. */
const containerRequest = `POST ${graph}/v1.0/me/threads`;

type Where = "sandbox" | "live";

/** A channel of Threads, connected to a workspace, with a client. */
async function withChannel(
  where: Where,
  options: Parameters<typeof setup>[0] = {},
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces[where];
  const outcome =
    where === "sandbox"
      ? await connectThreadsInSandbox(browser, workspace)
      : await connectThreadsLive(test, browser, workspace);
  expect(outcome.connect).toBe("connected");
  const client = new SyncClient();
  await client.connect(browser, workspace);
  /**
   * The posts on the Threads of the workspace, oldest first, each with
   * the post that it replies to.
   */
  const posted = async () => {
    if (where === "live") {
      return feed(test.network.world, ["threads"]).map(
        ({ post: { id, text, replyToId } }) => ({ id, text, replyToId }),
      );
    }
    const flat = (
      posts: SandboxPost[],
      replyToId: string | null,
    ): { id: string; text: string; replyToId: string | null }[] =>
      posts.flatMap(({ id, text, replies }) => [
        { id, text, replyToId },
        ...flat(replies, id),
      ]);
    return flat(
      sandboxFeedSchema
        .parse(await (await browser.fetch("/api/sandbox/feed")).json())
        .accounts.filter(({ network }) => network === "threads")
        .flatMap(({ posts }) => posts),
      null,
    );
  };
  /** How often Threads was asked for `request`, for real. */
  const asked = (request: string) =>
    test.network.requests.filter((made) => made === request).length;
  return {
    ...context,
    workspace,
    channel: outcome.channel ?? "",
    client,
    posted,
    asked,
  };
}

type Context = Awaited<ReturnType<typeof withChannel>>;

/** Writes a post and publishes it to the channel. Returns its target. */
async function publish(
  { client, workspace, channel }: Context,
  ...texts: [string, ...string[]]
) {
  const draft = await writeDraft(client, workspace, ...texts);
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  return { draft, targetId };
}

/** Publishes, and follows the delivery to its end. Returns the target. */
async function delivered(context: Context, ...texts: [string, ...string[]]) {
  const sent = await publish(context, ...texts);
  await ended(context.client, sent.draft.postId);
  return { ...sent, target: targetOf(context.client, sent.targetId) };
}

/** Arms a fault for the next request of a kind to Threads. */
async function arm(
  { test, browser }: Context,
  where: Where,
  kind:
    | "rate-limit"
    | "server-error"
    | "lost-response"
    | "token-revoked"
    | "slow-processing",
  operation: "publish" | "container" = "publish",
) {
  if (where === "live") {
    test.network.threads.arm({ kind, operation });
    return;
  }
  const response = await browser.fetch("/api/sandbox/faults", {
    method: "POST",
    json: { network: "threads", kind, operation },
  });
  expect(response.status).toBe(200);
}

describe("connecting a Threads account", () => {
  it("connects a simulated account to a sandbox, in a pigy that has no app at Meta", async () => {
    const test = setup({
      env: { THREADS_APP_ID: undefined, THREADS_APP_SECRET: undefined },
    });
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);

    const outcome = await connectThreadsInSandbox(browser, sandbox);

    expect(outcome).toMatchObject({ connect: "connected", network: "threads" });
    expect(await channelsOf(browser, sandbox)).toMatchObject([
      {
        id: outcome.channel,
        network: "threads",
        handle: sandboxThreadsHandle,
        name: "Ada Lovelace",
        avatarUrl: null,
        // The profile of a simulated account is at no address that a
        // browser can open.
        profileUrl: null,
        status: "connected",
        // 60 days, which is how long a token of Threads lasts unless it
        // is renewed.
        expiresAt: test.clock.time.getTime() + 60 * day,
        limits: { network: "threads", maxCharacters: 500 },
      },
    ]);
    // Nothing left the Worker for it.
    expect(test.network.requests).toEqual([]);
  });

  it("is the sandbox's own app in a sandbox, and never the operator's", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox, live } = await workspaceIds(browser);

    const simulated = new URL(
      await consentUrl(browser, sandbox, undefined, "threads"),
    );
    // A page of the app, which stands for the one of Threads.
    expect(simulated.origin + simulated.pathname).toBe(
      "https://pigy.test/sim/network/threads.net/oauth/authorize",
    );
    expect(simulated.searchParams.get("client_id")).toBe(
      sandboxThreadsApp.appId,
    );
    const real = new URL(await consentUrl(browser, live, undefined, "threads"));
    expect(real.origin + real.pathname).toBe(
      "https://threads.net/oauth/authorize",
    );
    expect(real.searchParams.get("client_id")).toBe(
      test.network.threadsApp.appId,
    );
    expect(real.searchParams.get("redirect_uri")).toBe(
      "https://pigy.test/connect/threads/callback",
    );

    // All the way in the sandbox: the secret of the operator's app is in
    // nothing that the world of the sandbox was told.
    const callback = await consentInSandbox(browser, simulated.href, {
      handle: "@grace.sandbox",
    });
    // Threads ends the address with a fragment, which a browser keeps to
    // itself: the callback is asked without it.
    expect(new URL(callback).hash).toBe("#_");
    expect(outcomeOf(await browser.fetch(pathOf(callback))).connect).toBe(
      "connected",
    );
    expect(
      JSON.stringify(await worldEntries<unknown>(sandbox, "")),
    ).not.toContain(test.network.threadsApp.appSecret);
    // The one address that the app of the world has, in full: that of the
    // pigy which the browser is at.
    expect(
      await worldEntries<{ redirectUris: string[] }>(sandbox, "threads/app/"),
    ).toMatchObject([
      { redirectUris: ["https://pigy.test/connect/threads/callback"] },
    ]);
  });

  it("sends the browser to no other site from an address that names one", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);
    // The address of the consent page as pigy makes it, with the redirect
    // address replaced: pigy's own path on somebody else's site. Anybody
    // can write such an address and have a person open it.
    const page = new URL(
      await consentUrl(browser, sandbox, undefined, "threads"),
    );
    page.searchParams.set(
      "redirect_uri",
      "https://evil.example/connect/threads/callback",
    );

    // Shown or answered: a page of the simulated Threads that says what
    // is wrong, and no way on.
    for (const init of [undefined, { form: { action: "deny" } }]) {
      const response = await browser.fetch(pathOf(page), init);
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).not.toContain("<form");
    }
  });

  it("connects a real account through the fetch of the app, and keeps the token to itself", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);

    const outcome = await connectThreadsLive(test, browser, live);

    expect(outcome.connect).toBe("connected");
    // The requests as they are noted hold the secret of the app and the
    // tokens, which travel in the addresses of some: only where they
    // went is compared.
    expect(
      test.network.requests.map((request) => request.replace(/\?.*$/, "")),
    ).toEqual([
      `POST ${graph}/oauth/access_token`,
      `GET ${graph}/access_token`,
      `GET ${graph}/v1.0/me`,
    ]);
    const [channel] = await channelsOf(browser, live);
    expect(channel).toMatchObject({
      network: "threads",
      handle: "@rosalind",
      name: "Rosalind Franklin",
      profileUrl: "https://www.threads.com/@rosalind",
      status: "connected",
    });
    // The tokens that Threads issued, by their values: in no row that a
    // client gets, and sealed where the workspace keeps the one that lasts.
    const tokens = test.network.world.tokens<SimToken>("threads");
    expect(tokens).toHaveLength(2);
    const [stored] = await storedAccess(live);
    expect(stored?.credentials).toBeTruthy();
    for (const { token } of tokens) {
      expect(JSON.stringify(channel)).not.toContain(token);
      expect(stored?.credentials).not.toContain(token);
    }
  });

  it("says that it is not set up for Threads in a live workspace without an app, and asks Threads nothing", async () => {
    for (const missing of ["THREADS_APP_ID", "THREADS_APP_SECRET"] as const) {
      const test = setup({ env: { [missing]: undefined } });
      const browser = await signedIn(test, { email: adminEmail });
      const { live } = await workspaceIds(browser);
      const response = await startConnect(browser, live, {
        network: "threads",
      });
      expect(response.status).toBe(503);
      expect(connectErrorSchema.parse(await response.json())).toMatchObject({
        message: expect.stringMatching(/not set up to connect Threads/),
      });
      expect(test.network.requests).toEqual([]);
    }
  });

  it("says that the person cancelled when they decline at Threads", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);
    const url = await consentUrl(browser, sandbox, undefined, "threads");
    const callback = await consentInSandbox(browser, url, "deny");
    expect(outcomeOf(await browser.fetch(pathOf(callback)))).toMatchObject({
      connect: "cancelled",
      network: "threads",
    });
    expect(await channelsOf(browser, sandbox)).toEqual([]);
  });

  it("removes a channel and says that the access was not given back: Threads has no way", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);
    const { channel = "" } = await connectThreadsLive(test, browser, live);
    const before = test.network.requests.length;

    expect(await disconnected(browser, live, channel)).toBe(false);

    expect(await channelsOf(browser, live)).toEqual([]);
    // Nothing was asked of Threads, and the token is as it was.
    expect(test.network.requests).toHaveLength(before);
    expect(
      test.network.world
        .tokens<SimToken>("threads")
        .map(({ revoked }) => revoked),
    ).toEqual([false, false]);
  });

  it("asks Threads for nothing more when an account is connected again", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);
    const first = await connectThreadsLive(test, browser, live);
    const second = await connectThreadsLive(test, browser, live);
    await Promise.all(test.keptAlive);

    // One account is one channel, and nothing gives the access of the
    // connection before back: there is no way to. So nothing is tried:
    // two connections of three requests each.
    expect(second.channel).toBe(first.channel);
    expect(test.network.requests).toHaveLength(6);
  });
});

describe("publishing to Threads", () => {
  it.each(["sandbox", "live"] as const)(
    "publishes a post in a %s workspace, as a container that is then published",
    async (where) => {
      const context = await withChannel(where);
      const text = "Hello Threads 👋 https://example.com/a?b=c";

      const { draft, targetId, target } = await delivered(context, text);

      expect(target).toMatchObject({ status: "sent", attempt: 1, error: null });
      const posts = await context.posted();
      expect(posts).toMatchObject([{ text, replyToId: null }]);
      expect(publishedOf(context.client, targetId, draft)).toEqual([
        posts[0]?.id,
      ]);
      const [result] = context.client.table("target_part_result");
      // A post of a simulated world has no address that a browser opens.
      if (where === "live") {
        expect(result?.url).toMatch(
          /^https:\/\/www\.threads\.com\/@rosalind\/post\/\w+$/,
        );
      } else {
        expect(result?.url).toBeNull();
      }
      // A sandbox asks the real Threads nothing.
      const times = where === "live" ? 1 : 0;
      expect(context.asked(containerRequest)).toBe(times);
      expect(context.asked(publishRequest)).toBe(times);
    },
  );

  it.each(["sandbox", "live"] as const)(
    "publishes a thread in a %s workspace as a chain of replies, part by part",
    async (where) => {
      const context = await withChannel(where);

      const { draft, targetId, target } = await delivered(
        context,
        "One",
        "Two",
        "Three",
      );

      expect(target).toMatchObject({ status: "sent", attempt: 1 });
      const posts = await context.posted();
      expect(posts).toMatchObject([
        { text: "One", replyToId: null },
        { text: "Two", replyToId: posts[0]?.id },
        { text: "Three", replyToId: posts[1]?.id },
      ]);
      expect(publishedOf(context.client, targetId, draft)).toEqual(
        posts.map(({ id }) => id),
      );
    },
  );

  it("does not send a post that is too long for Threads, where an emoji counts as its bytes", async () => {
    const context = await withChannel("live");
    // 126 emoji of four bytes each are 504 to Threads, and 126 to a person.
    const { target } = await delivered(context, "😀".repeat(126));

    expect(target.status).toBe("error");
    expect(target.error).toContain("504 characters");
    expect(context.asked(containerRequest)).toBe(0);
  });

  it.each(["sandbox", "live"] as const)(
    "finds a post whose answer was lost in a %s workspace, and publishes it once",
    async (where) => {
      const context = await withChannel(where);
      await arm(context, where, "lost-response");

      const { draft, targetId, target } = await delivered(
        context,
        "Lost",
        "And found",
      );

      // The step that lost its answer was run again, asked Threads what
      // had become of its container, and found the post.
      expect(target).toMatchObject({ status: "sent", attempt: 1 });
      const posts = await context.posted();
      expect(posts.map(({ text }) => text)).toEqual(["Lost", "And found"]);
      expect(publishedOf(context.client, targetId, draft)).toEqual(
        posts.map(({ id }) => id),
      );
      if (where === "live") {
        // Each part was asked to be published once: a container that
        // says that it is published is not published again.
        expect(context.asked(publishRequest)).toBe(2);
      }
    },
  );

  it.each(["rate-limit", "server-error"] as const)(
    "tries again after a %s and publishes once",
    async (kind) => {
      const context = await withChannel("live");
      await arm(context, "live", kind);

      const { target, targetId } = await delivered(context, "Second time");

      expect(target).toMatchObject({ status: "sent", attempt: 1 });
      expect((await context.posted()).map(({ text }) => text)).toEqual([
        "Second time",
      ]);
      // It waited as the workflow does for a network that names no time.
      expect(await waitsOf(context.workspace, targetId)).toEqual({
        "publish-2-wait-1": 60,
      });
      // The container was made once, and published at the second asking.
      expect(context.asked(containerRequest)).toBe(1);
      expect(context.asked(publishRequest)).toBe(2);
    },
  );

  it("waits for a container that Threads takes long to prepare, and publishes it when it is ready", async () => {
    // The clock of a test stands still, so a container that is slow stays
    // so until the test moves the clock. It does when Threads is asked
    // about the container for the third time: within the request, so that
    // the workflow, whose waits take no time here, cannot get ahead.
    let looks = 0;
    const context = await withChannel("live", {
      interceptNetwork: (network) => (input, init) => {
        const { pathname, searchParams } = new URL(urlOf(input));
        if (
          /^\/v1\.0\/\d+$/.test(pathname) &&
          searchParams.get("fields")?.startsWith("status") &&
          ++looks === 3
        ) {
          clock.time = new Date(clock.time.getTime() + slowProcessingMs);
        }
        return network(input, init);
      },
    });
    await arm(context, "live", "slow-processing", "container");

    const { target, targetId } = await delivered(context, "Slowly");

    expect(target).toMatchObject({ status: "sent", attempt: 1 });
    expect((await context.posted()).map(({ text }) => text)).toEqual([
      "Slowly",
    ]);
    // The adapter asked for both waits, between its looks: no step failed.
    expect(await waitsOf(context.workspace, targetId)).toEqual({
      "wait-3": 10,
      "wait-4": 10,
    });
    expect(context.asked(containerRequest)).toBe(1);
    expect(context.asked(publishRequest)).toBe(1);
  });

  it.each(["sandbox", "live"] as const)(
    "asks for the account to be connected again when its token was taken back in a %s workspace",
    async (where) => {
      const context = await withChannel(where);
      await arm(context, where, "token-revoked", "container");

      const { target } = await delivered(context, "Never arrives");

      expect(target.status).toBe("error");
      expect(target.error).toContain("no longer accepts");
      expect(
        context.client.table("channel").find(({ id }) => id === context.channel)
          ?.status,
      ).toBe("needs_reconnect");
      expect(await context.posted()).toEqual([]);
    },
  );
});
