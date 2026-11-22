import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { connectErrorSchema, type Fetch, sandboxFeedSchema } from "@pigy/core";
import { feed, type SimToken } from "@pigy/simulators/world";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { sandboxLinkedInClient } from "../src/network/linkedin-client.ts";
import { cutOffMessage } from "../src/publish/delivery.ts";
import { beginsWaitsMs } from "../src/publish/workflow.ts";
import { keyLifetimeMs, WorkspaceStore } from "../src/workspace/store.ts";
import { mutateWorkspace } from "../src/workspace/workspaces.ts";
import {
  channelsOf,
  connectLinkedInInSandbox,
  connectLinkedInLive,
  connectLive,
  consentInSandbox,
  consentUrl,
  disconnected,
  offeredAccounts,
  outcomeOf,
  pathOf,
  sandboxLinkedInMember,
  startConnect,
  storedAccess,
  worldEntries,
} from "./channels.ts";
import { adminEmail, setup, signedIn, urlOf } from "./helpers.ts";
import {
  ended,
  patience,
  publishedOf,
  publishTo,
  retry,
  runOf,
  started,
  targetOf,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import {
  identityOf,
  newId,
  objectOf,
  SyncClient,
  workspaceIds,
} from "./sync-client.ts";

/**
 * LinkedIn in the Worker: connecting a member in a sandbox and for real,
 * publishing a post and a thread, which is one post there, and what the
 * pipeline does about the one network on which pigy can neither look for
 * a post nor ask a second time without posting twice.
 */

const day = 24 * 60 * 60 * 1000;

/** The request that asks LinkedIn to publish a post. */
const postRequest = "POST https://api.linkedin.com/rest/posts";

type Where = "sandbox" | "live";

/** A channel of LinkedIn, connected to a workspace, with a client. */
async function withChannel(
  where: Where,
  options: Parameters<typeof setup>[0] = {},
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces[where];
  const outcome =
    where === "sandbox"
      ? await connectLinkedInInSandbox(browser, workspace)
      : await connectLinkedInLive(test, browser, workspace);
  expect(outcome.connect).toBe("connected");
  const client = new SyncClient();
  await client.connect(browser, workspace);
  /** The texts of the posts on the LinkedIn of the workspace, oldest first. */
  const posted = async () =>
    where === "live"
      ? feed(test.network.world, ["linkedin"]).map(({ post }) => post)
      : sandboxFeedSchema
          .parse(await (await browser.fetch("/api/sandbox/feed")).json())
          .accounts.filter(({ network }) => network === "linkedin")
          .flatMap(({ posts }) => posts);
  /** How often LinkedIn was asked to publish, for real. */
  const asked = () =>
    test.network.requests.filter((request) => request === postRequest).length;
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

/** Arms a fault for the next request that asks LinkedIn to publish. */
async function arm(
  { test, browser }: Context,
  where: Where,
  kind: "rate-limit" | "server-error" | "lost-response" | "token-revoked",
) {
  if (where === "live") {
    test.network.linkedin.arm({ kind, operation: "publish" });
    return;
  }
  const response = await browser.fetch("/api/sandbox/faults", {
    method: "POST",
    json: { network: "linkedin", kind, operation: "publish" },
  });
  expect(response.status).toBe(200);
}

describe("connecting a LinkedIn account", () => {
  it("connects a simulated member to a sandbox, in a pigy that has no application at LinkedIn", async () => {
    const test = setup({
      env: { LINKEDIN_CLIENT_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined },
    });
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);

    const outcome = await connectLinkedInInSandbox(browser, sandbox);

    expect(outcome).toMatchObject({
      connect: "connected",
      network: "linkedin",
    });
    expect(await channelsOf(browser, sandbox)).toMatchObject([
      {
        id: outcome.channel,
        network: "linkedin",
        // LinkedIn gives an application nothing but the name to address a
        // member by.
        handle: "Ada Lovelace",
        name: "Ada Lovelace",
        avatarUrl: null,
        profileUrl: null,
        status: "connected",
        // 60 days, which is how long LinkedIn's access lasts.
        expiresAt: test.clock.time.getTime() + 60 * day,
        limits: { network: "linkedin", maxCharacters: 3000 },
      },
    ]);
    // Nothing left the Worker for it.
    expect(test.network.requests).toEqual([]);
  });

  it("is the sandbox's own application in a sandbox, and never the operator's", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox, live } = await workspaceIds(browser);

    const simulated = new URL(
      await consentUrl(browser, sandbox, undefined, "linkedin"),
    );
    // A page of the app, which stands for LinkedIn's.
    expect(simulated.origin + simulated.pathname).toBe(
      "https://pigy.test/sim/network/www.linkedin.com/oauth/v2/authorization",
    );
    expect(simulated.searchParams.get("client_id")).toBe(
      sandboxLinkedInClient.clientId,
    );
    const real = new URL(
      await consentUrl(browser, live, undefined, "linkedin"),
    );
    expect(real.origin + real.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(real.searchParams.get("client_id")).toBe(
      test.network.linkedinClient.clientId,
    );
    expect(real.searchParams.get("redirect_uri")).toBe(
      "https://pigy.test/connect/linkedin/callback",
    );

    // All the way in the sandbox: the secret of the operator's application
    // is in nothing that the world of the sandbox was told.
    const callback = await consentInSandbox(browser, simulated.href, {
      handle: "Grace Hopper",
    });
    expect(outcomeOf(await browser.fetch(pathOf(callback))).connect).toBe(
      "connected",
    );
    expect(
      JSON.stringify(await worldEntries<unknown>(sandbox, "")),
    ).not.toContain(test.network.linkedinClient.clientSecret);
  });

  it.each([
    // Refused by LinkedIn with a redirect to the application, at once.
    ["a scope that the application does not have", "r_member_social"],
    // Asked of the member on a page that says "pigy".
    ["the scopes that pigy asks for", "openid profile w_member_social"],
  ])(
    "sends the browser to no other site from an address that names one, with %s",
    async (_name, scope) => {
      const test = setup();
      const browser = await signedIn(test, { email: adminEmail });
      const { sandbox } = await workspaceIds(browser);
      // The address of the consent page as pigy makes it, with the redirect
      // address replaced: pigy's own path on somebody else's site. Anybody
      // can write such an address and have a person open it.
      const page = new URL(
        await consentUrl(browser, sandbox, undefined, "linkedin"),
      );
      page.searchParams.set(
        "redirect_uri",
        "https://evil.example/connect/linkedin/callback",
      );
      page.searchParams.set("scope", scope);

      const shown = await browser.fetch(pathOf(page));

      // A page of the simulated LinkedIn that says what is wrong, and no
      // way on: no redirect, and no form that would lead to one.
      expect(shown.status).toBe(400);
      expect(shown.headers.get("Location")).toBeNull();
      expect(await shown.text()).not.toContain("<form");
      // Whoever skips the page and answers it gets the same.
      const members = await offeredAccounts(
        await browser.fetch(
          pathOf(await consentUrl(browser, sandbox, undefined, "linkedin")),
        ),
      );
      const answered = await browser.fetch(pathOf(page), {
        form: { account: members.get(sandboxLinkedInMember) ?? "" },
      });
      expect(answered.status).toBe(400);
      expect(answered.headers.get("Location")).toBeNull();
    },
  );

  it("takes the callback address of the pigy that the browser is at, and connects there", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);

    const callback = await consentInSandbox(
      browser,
      await consentUrl(browser, sandbox, undefined, "linkedin"),
      { handle: sandboxLinkedInMember },
    );

    expect(new URL(callback).origin).toBe("https://pigy.test");
    // The one address that the application of the world has, in full.
    expect(
      await worldEntries<{ redirectUris: string[] }>(
        sandbox,
        "linkedin/client/",
      ),
    ).toMatchObject([
      { redirectUris: ["https://pigy.test/connect/linkedin/callback"] },
    ]);
  });

  it("connects a real member through the fetch of the app, and keeps the token to itself", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);

    const outcome = await connectLinkedInLive(test, browser, live);

    expect(outcome.connect).toBe("connected");
    expect(test.network.requests).toEqual([
      "POST https://www.linkedin.com/oauth/v2/accessToken",
      "GET https://api.linkedin.com/v2/userinfo",
    ]);
    const [channel] = await channelsOf(browser, live);
    expect(channel).toMatchObject({
      network: "linkedin",
      handle: "Rosalind Franklin",
      status: "connected",
    });
    // The token that LinkedIn issued, by its value: in no row that a
    // client gets, and sealed where the workspace keeps it.
    const [token] = test.network.world.tokens<SimToken>("linkedin");
    expect(token?.token).toBeTruthy();
    expect(JSON.stringify(channel)).not.toContain(token?.token);
    const [stored] = await storedAccess(live);
    expect(stored?.credentials).toBeTruthy();
    expect(stored?.credentials).not.toContain(token?.token);
  });

  it("says that it is not set up for LinkedIn in a live workspace without an application, and asks LinkedIn nothing", async () => {
    for (const missing of [
      "LINKEDIN_CLIENT_ID",
      "LINKEDIN_CLIENT_SECRET",
    ] as const) {
      const test = setup({ env: { [missing]: undefined } });
      const browser = await signedIn(test, { email: adminEmail });
      const { live } = await workspaceIds(browser);
      const response = await startConnect(browser, live, {
        network: "linkedin",
      });
      expect(response.status).toBe(503);
      expect(connectErrorSchema.parse(await response.json())).toMatchObject({
        message: expect.stringMatching(/not set up to connect LinkedIn/),
      });
      expect(test.network.requests).toEqual([]);
    }
  });

  it("says that the person cancelled when they decline at LinkedIn", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { sandbox } = await workspaceIds(browser);
    const url = await consentUrl(browser, sandbox, undefined, "linkedin");
    const callback = await consentInSandbox(browser, url, "deny");
    expect(outcomeOf(await browser.fetch(pathOf(callback)))).toMatchObject({
      connect: "cancelled",
      network: "linkedin",
    });
    expect(await channelsOf(browser, sandbox)).toEqual([]);
  });

  it("gives the token back when the channel is disconnected", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);
    const { channel = "" } = await connectLinkedInLive(test, browser, live);

    expect(await disconnected(browser, live, channel)).toBe(true);

    expect(test.network.requests.at(-1)).toBe(
      "POST https://www.linkedin.com/oauth/v2/revoke",
    );
    expect(
      test.network.world
        .tokens<SimToken>("linkedin")
        .map(({ revoked }) => revoked),
    ).toEqual([true]);
  });

  it("leaves the token of the connection before alone when the account is connected again", async () => {
    const test = setup();
    const browser = await signedIn(test, { email: adminEmail });
    const { live } = await workspaceIds(browser);
    const first = await connectLinkedInLive(test, browser, live);
    const second = await connectLinkedInLive(test, browser, live);
    await Promise.all(test.keptAlive);

    // One account is one channel.
    expect(second.channel).toBe(first.channel);
    // Whether a token of LinkedIn's is one connection's alone is not
    // known, PLAN.md section 19, so pigy takes none back that a channel
    // has not held to its end: it could be the one that works.
    expect(test.network.requests).not.toContain(
      "POST https://www.linkedin.com/oauth/v2/revoke",
    );
  });
});

describe("publishing to LinkedIn", () => {
  it.each(["sandbox", "live"] as const)(
    "publishes a post in a %s workspace",
    async (where) => {
      const context = await withChannel(where);
      const text = "Hello LinkedIn (with what it reserves: #1 @all)";

      const { draft, targetId, target } = await delivered(context, text);

      expect(target).toMatchObject({ status: "sent", attempt: 1, error: null });
      const posts = await context.posted();
      expect(posts.map((post) => post.text)).toEqual([text]);
      expect(publishedOf(context.client, targetId, draft)).toEqual([
        posts[0]?.id,
      ]);
      const [result] = context.client.table("target_part_result");
      // A post of a simulated world has no address that a browser opens.
      expect(result?.url).toBe(
        where === "live"
          ? `https://www.linkedin.com/feed/update/${posts[0]?.id}/`
          : null,
      );
      // A sandbox asks the real LinkedIn nothing.
      expect(context.asked()).toBe(where === "live" ? 1 : 0);
    },
  );

  it.each(["sandbox", "live"] as const)(
    "publishes a thread as one post in a %s workspace, which every part is in",
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
      expect(posts.map((post) => post.text)).toEqual(["One\n\nTwo\n\nThree"]);
      const id = posts[0]?.id;
      expect(publishedOf(context.client, targetId, draft)).toEqual([
        id,
        id,
        id,
      ]);
    },
  );

  it("does not send a thread whose parts do not fit into one post together", async () => {
    const context = await withChannel("live");
    // Each fits, and with the empty line between them the two do not.
    const { target } = await delivered(
      context,
      "a".repeat(1500),
      "b".repeat(1500),
    );
    expect(target).toMatchObject({
      status: "error",
      error: expect.stringContaining("3002 characters long together"),
    });
    expect(context.asked()).toBe(0);
  });
});

describe("a delivery to LinkedIn that goes wrong", () => {
  it.each(["sandbox", "live"] as const)(
    "asks a person to look when the answer to a post is lost in a %s workspace, and takes the post that LinkedIn names when they try again",
    async (where) => {
      const context = await withChannel(where);
      await arm(context, where, "lost-response");

      const { draft, targetId, target } = await delivered(context, "Lost");

      expect(target).toMatchObject({
        status: "uncertain",
        attempt: 1,
        error: expect.stringContaining("Look at the account"),
      });
      // The post is there, and the workflow did not ask a second time,
      // which would have been a second post: it did not wait to, either.
      expect((await context.posted()).map((post) => post.text)).toEqual([
        "Lost",
      ]);
      if (where === "live") expect(context.asked()).toBe(1);
      expect(await waitsOf(context.workspace, targetId)).toEqual({});
      // Nothing is wrong with the account.
      expect(context.client.table("channel")[0]?.status).toBe("connected");

      // The person tries again a moment later. LinkedIn refuses the text
      // as one that it has, and names the post: that is the delivery's.
      await retry(context.client, targetId);
      await ended(context.client, draft.postId);
      expect(targetOf(context.client, targetId)).toMatchObject({
        status: "sent",
        attempt: 2,
      });
      const posts = await context.posted();
      expect(posts).toHaveLength(1);
      expect(publishedOf(context.client, targetId, draft)).toEqual([
        posts[0]?.id,
      ]);
    },
  );

  it("asks a person to look when LinkedIn fails while it takes a post, and does not try again by itself", async () => {
    const context = await withChannel("live");
    await arm(context, "live", "server-error");

    const { targetId, target } = await delivered(context, "Maybe");

    // A server that fails says nothing of how far it got.
    expect(target).toMatchObject({ status: "uncertain", attempt: 1 });
    expect(context.asked()).toBe(1);
    expect(await waitsOf(context.workspace, targetId)).toEqual({});
    expect(await context.posted()).toEqual([]);
  });

  it("fails a delivery that LinkedIn refuses for the day, without waiting for the day to end", async () => {
    const context = await withChannel("live");
    await arm(context, "live", "rate-limit");

    const { targetId, target } = await delivered(context, "Too many");

    // LinkedIn's day ends at midnight UTC, which is 14 hours away, and
    // the workflow waits for no more than one.
    expect(target).toMatchObject({
      status: "error",
      attempt: 1,
      error: expect.stringContaining("limiting how often pigy may ask today"),
    });
    expect(await waitsOf(context.workspace, targetId)).toEqual({});
    expect(await context.posted()).toEqual([]);
    expect(context.client.table("channel")[0]?.status).toBe("connected");
  });

  it("asks for a new connection when LinkedIn has taken the access back", async () => {
    const context = await withChannel("live");
    await arm(context, "live", "token-revoked");

    const { target } = await delivered(context, "Revoked");

    expect(target).toMatchObject({ status: "error", attempt: 1 });
    expect(context.client.table("channel")[0]?.status).toBe("needs_reconnect");
    expect(await context.posted()).toEqual([]);
  });

  it("asks for a new connection when the time of an access is up", async () => {
    const context = await withChannel("live");
    // The token ends, as it does after its 60 days. The clock is not
    // moved that far: the session of the test would be over long before.
    const [token] = context.test.network.world.tokens<SimToken>("linkedin");
    context.test.network.world.expireToken("linkedin", token?.token ?? "");

    const { target } = await delivered(context, "Too late");

    expect(target).toMatchObject({
      status: "error",
      error: expect.stringContaining("60 days"),
    });
    expect(context.client.table("channel")[0]?.status).toBe("needs_reconnect");
    expect(await context.posted()).toEqual([]);
  });
});

describe("a step that asks LinkedIn to publish and is cut off", () => {
  /**
   * For `interceptNetwork`: lets a request to publish through to LinkedIn,
   * which carries it out, and keeps its answer from coming back while
   * `held.closed`. That is a step whose request went out and that then
   * gets no further: its time runs out, or the Worker goes away under it.
   *
   * The test and the request look at `held` on timers of their own, and
   * neither wakes the other: see `gate` of publishing.ts.
   */
  function answersHeld() {
    const held = { closed: true, arrived: 0 };
    const intercept =
      (network: Fetch): Fetch =>
      async (input, init) => {
        const response = await network(input, init);
        if (`${init?.method ?? "GET"} ${urlOf(input)}` === postRequest) {
          held.arrived++;
          while (held.closed) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return response;
      };
    return { held, intercept };
  }

  it("is not run a second time when the run is taken up again: the delivery ends as one that nobody knows the outcome of", async () => {
    const { held, intercept } = answersHeld();
    const context = await withChannel("live", { interceptNetwork: intercept });
    onTestFinished(() => {
      held.closed = false;
    });
    const { draft, targetId } = await publish(context, "Cut off");
    // The request has reached LinkedIn, which has published the post, and
    // the step that sent it is still waiting for the answer.
    await vi.waitFor(() => expect(held.arrived).toBe(1), patience);
    expect((await context.posted()).map((post) => post.text)).toEqual([
      "Cut off",
    ]);

    // The run is taken up again from its first step, as when somebody
    // restarts it. Nothing of the step was recorded: to the run, it never
    // happened. The platform itself runs only the step again when its
    // time has run out, which the test after the next is about.
    using run = await runOf(context.workspace, targetId);
    await run.restart();

    expect(await ended(context.client, draft.postId)).toMatchObject({
      status: "error",
    });
    expect(targetOf(context.client, targetId)).toMatchObject({
      status: "uncertain",
      attempt: 1,
      error: cutOffMessage,
    });
    // LinkedIn was asked once, and has one post. An adapter that cannot
    // look would have asked again here, and there would be two.
    expect(context.asked()).toBe(1);
    expect(await context.posted()).toHaveLength(1);

    // The answer that was held comes back to a step that nobody waits
    // for. Nothing changes.
    held.closed = false;
    await vi.waitFor(async () => {
      expect(targetOf(context.client, targetId).status).toBe("uncertain");
      expect(await context.posted()).toHaveLength(1);
    }, patience);

    // The person looks, and asks for another try: a new attempt, with
    // notes of its own, which does ask LinkedIn.
    await retry(context.client, targetId);
    await ended(context.client, draft.postId);
    expect(targetOf(context.client, targetId)).toMatchObject({
      status: "sent",
      attempt: 2,
    });
    expect(context.asked()).toBe(2);
    // Within the minutes in which LinkedIn tells a repetition, that is
    // the post of the step that was cut off.
    expect(await context.posted()).toHaveLength(1);
  });

  it("is not run again either when the run is taken up after so long that the workspace has cleared its note away", async () => {
    const { held, intercept } = answersHeld();
    const context = await withChannel("live", { interceptNetwork: intercept });
    onTestFinished(() => {
      held.closed = false;
    });
    const { targetId } = await publish(context, "Cut off for long");
    // LinkedIn has published the post, and the step waits for the answer.
    await vi.waitFor(() => expect(held.arrived).toBe(1), patience);
    const notes = () =>
      runInDurableObject(objectOf(context.workspace), (_, state) =>
        state.storage.sql
          .exec<{ key: string }>(
            "select key from keyed_call where key like '%/begins/%'",
          )
          .toArray(),
      );
    expect(await notes()).toHaveLength(1);

    // The run stays as it is for longer than a workspace keeps a call
    // with a key, as a run does that somebody has paused: the platform
    // keeps such a run for as long as it is paused. Meanwhile another call
    // with a key comes, which is when the workspace clears the old ones
    // away, the note of the step among them.
    context.test.advance(keyLifetimeMs + day);
    const identity = await identityOf(context.test, context.workspace);
    expect(
      await mutateWorkspace(
        env.WORKSPACE,
        identity,
        "post.create",
        { id: newId(), partId: newId(), text: "Something else" },
        "another call with a key",
      ),
    ).toEqual({ ok: true });
    // The note is gone: without that, the test would show nothing but
    // what the test before it shows.
    expect(await notes()).toEqual([]);

    // Taken up again from its first step. LinkedIn would take the text a
    // second time by now: it refuses a repetition for some minutes only.
    using run = await runOf(context.workspace, targetId);
    await run.restart();
    // Read from the workspace itself: the session of the client has
    // ended in the month that has passed, and its socket with it.
    const target = () =>
      runInDurableObject(objectOf(context.workspace), (_, state) =>
        state.storage.sql
          .exec("select status, attempt, error from post_target")
          .one(),
      );
    await vi.waitFor(
      async () =>
        expect(await target()).toEqual({
          status: "uncertain",
          attempt: 1,
          error: cutOffMessage,
        }),
      patience,
    );
    expect(context.asked()).toBe(1);
    expect(await context.posted()).toHaveLength(1);
  });

  it("goes on when the workspace has noted that it begins and only the answer was lost: the step tells it again, with the same mark", async () => {
    const context = await withChannel("live");
    // The workspace notes that the step begins, and its answer is lost on
    // the way back, as when a deploy takes the object away under the
    // call. Once: the step asks again.
    const original = WorkspaceStore.prototype.stepBegins;
    const noted = vi
      .spyOn(WorkspaceStore.prototype, "stepBegins")
      .mockImplementationOnce(function (this: WorkspaceStore, ...args) {
        original.apply(this, args);
        throw new Error("The answer was lost");
      });
    onTestFinished(() => noted.mockRestore());

    const { target } = await delivered(context, "Noted");

    // Told twice, by the same run of the step: with one mark, which the
    // second call is handed back as its own.
    expect(noted).toHaveBeenCalledTimes(2);
    expect(noted.mock.calls[1]?.[1]).toBe(noted.mock.calls[0]?.[1]);
    // Nothing had been sent, and nothing kept the step from sending.
    expect(target).toMatchObject({ status: "sent", attempt: 1 });
    expect(context.asked()).toBe(1);
    expect((await context.posted()).map((post) => post.text)).toEqual([
      "Noted",
    ]);
  });

  it("is not run a second time by the platform either, which runs a step again that failed as a step", async () => {
    const context = await withChannel("live");
    // The workspace notes that the step begins, and the step never hears
    // of it, however often it asks: it fails before it has called the
    // adapter, and the platform runs it again, as another run of the
    // step, with a mark of its own. To that run, the note says what it
    // would say after a step that was cut off with its request out.
    const original = WorkspaceStore.prototype.stepBegins;
    const noted = vi.spyOn(WorkspaceStore.prototype, "stepBegins");
    for (let call = 0; call <= beginsWaitsMs.length; call++) {
      noted.mockImplementationOnce(function (this: WorkspaceStore, ...args) {
        original.apply(this, args);
        throw new Error("The answer was lost");
      });
    }
    onTestFinished(() => noted.mockRestore());
    // The platform waits a minute before it runs a step again, and a test
    // does not.
    await context.workflows.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    const { draft, targetId, target } = await delivered(context, "Noted");

    // Every call of the first run, and one of the second.
    expect(noted).toHaveBeenCalledTimes(beginsWaitsMs.length + 2);
    expect(noted.mock.calls.at(-1)?.[1]).not.toBe(noted.mock.calls[0]?.[1]);
    expect(target).toMatchObject({
      status: "uncertain",
      attempt: 1,
      error: cutOffMessage,
    });
    // The second run did not call the adapter: LinkedIn was never asked.
    expect(context.asked()).toBe(0);

    // The next attempt is a new run, which the notes of this one say
    // nothing to.
    await retry(context.client, targetId);
    await ended(context.client, draft.postId);
    expect(targetOf(context.client, targetId).status).toBe("sent");
    expect((await context.posted()).map((post) => post.text)).toEqual([
      "Noted",
    ]);
  });

  it("is no concern of an adapter that can look, whose steps are run again as before", async () => {
    const context = await started();
    const { test, browser, workspaces } = context;
    const noted = vi.spyOn(WorkspaceStore.prototype, "stepBegins");
    onTestFinished(() => noted.mockRestore());
    const outcome = await connectLive(test, browser, workspaces.live);
    const client = new SyncClient();
    await client.connect(browser, workspaces.live);
    const draft = await writeDraft(client, workspaces.live, "To Mastodon");
    await publishTo(client, draft.postId, outcome.channel ?? "");

    expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
    // Mastodon's adapter finds what a run before it has posted. Nothing
    // is noted for it, and nothing keeps its steps from being run again.
    expect(noted).not.toHaveBeenCalled();
  });
});
