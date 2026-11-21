import {
  connectErrorSchema,
  type Fetch,
  sandboxBlueskyHandles,
} from "@pigy/core";
import {
  accessTokenLifetimeMs,
  type PostRecord,
} from "@pigy/simulators/bluesky";
import { feed } from "@pigy/simulators/world";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { developmentBlueskyClientKeys } from "../src/development-keys.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import {
  channelsOf,
  connectBlueskyInSandbox,
  connectBlueskyLive,
  consentUrl,
  disconnected,
  startConnect,
  storedAccess,
  worldEntries,
} from "./channels.ts";
import {
  adminEmail,
  blueskyClientKey,
  expectErrors,
  expectWarnings,
  logged,
  realBlueskyHandle,
  realBlueskyPds,
  setup,
  signedIn,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import {
  ended,
  eventsOf,
  patience,
  postOf,
  publishedOf,
  publishTo,
  retry,
  started,
  storedProgress,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient, workspaceIds } from "./sync-client.ts";

/**
 * Bluesky in the Worker: pigy's client metadata, connecting an account in
 * a sandbox and for real, publishing, and renewing an access, which no
 * network before Bluesky asked for.
 */

const metadataPath = "/connect/bluesky/client-metadata.json";

/**
 * A key of pigy's client other than the one of the tests: the one of the
 * repository, which is as good as any other here.
 */
const otherClientKey = developmentBlueskyClientKeys.replace(/^\d+:/, "");

/** A signed-in admin and their workspaces. */
async function start(options: Parameters<typeof setup>[0] = {}) {
  const test = setup(options);
  const browser = await signedIn(test, { email: adminEmail });
  return { test, browser, workspaces: await workspaceIds(browser) };
}

/** A channel of Bluesky, connected to a workspace, with a client. */
async function withChannel(where: "sandbox" | "live") {
  const context = await started();
  const { test, browser, workspaces } = context;
  const workspace = workspaces[where];
  const outcome =
    where === "sandbox"
      ? await connectBlueskyInSandbox(browser, workspace)
      : await connectBlueskyLive(test, browser, workspace);
  expect(outcome.connect).toBe("connected");
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return { ...context, workspace, channel: outcome.channel ?? "", client };
}

describe("pigy as a client of Bluesky", () => {
  it("serves its client metadata at its client ID, with the public halves of its keys", async () => {
    const { test } = await start();
    const response = await test.browser().fetch(metadataPath);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      client_id: `https://pigy.test${metadataPath}`,
      redirect_uris: ["https://pigy.test/connect/bluesky/callback"],
      token_endpoint_auth_method: "private_key_jwt",
      dpop_bound_access_tokens: true,
      jwks: { keys: [{ kty: "EC", crv: "P-256", kid: "pigy-1" }] },
    });
    // Nothing of the private half: a key in the document is a key given
    // away.
    expect(JSON.stringify(metadata)).not.toMatch(/"d"/);
  });

  it("is no client of Bluesky without keys, and says so to whoever connects", async () => {
    const { test, browser, workspaces } = await start({
      env: { BLUESKY_CLIENT_KEYS: undefined },
    });
    expect((await test.browser().fetch(metadataPath)).status).toBe(404);
    for (const workspace of [workspaces.live, workspaces.sandbox]) {
      const response = await startConnect(browser, workspace, {
        network: "bluesky",
        identifier: realBlueskyHandle,
      });
      expect(response.status).toBe(503);
      expect(connectErrorSchema.parse(await response.json())).toMatchObject({
        message: expect.stringMatching(/not set up to connect Bluesky/),
      });
    }
    // Refused before anything was asked of a network.
    expect(test.network.requests).toEqual([]);
  });

  it("uses the key of the repository only where it is reached locally", async () => {
    const { test } = await start({
      developmentCredentialKeys: true,
      env: { BLUESKY_CLIENT_KEYS: undefined },
    });
    const local = await test
      .browser("http://localhost:5173")
      .fetch(metadataPath);
    expect(await local.json()).toMatchObject({
      client_id: `http://localhost:5173${metadataPath}`,
      jwks: { keys: [{ kid: "pigy-0" }] },
    });
    expect((await test.browser().fetch(metadataPath)).status).toBe(404);
  });

  it("names the key that it signs new connections with, and keeps the others", async () => {
    const { test } = await start({
      env: { BLUESKY_CLIENT_KEYS: `1:${blueskyClientKey},2:${otherClientKey}` },
    });
    const metadata = await (await test.browser().fetch(metadataPath)).json();
    // The highest version first: it signs the connections that begin.
    expect(metadata).toMatchObject({
      jwks: { keys: [{ kid: "pigy-2" }, { kid: "pigy-1" }] },
    });
  });
});

describe("connecting a Bluesky account", () => {
  it("connects a simulated account to a sandbox without leaving the Worker", async () => {
    const { test, browser, workspaces } = await start();
    const [, grace = ""] = sandboxBlueskyHandles;
    const url = await consentUrl(browser, workspaces.sandbox, grace, "bluesky");
    // The consent page of the simulated entryway, which the app serves.
    expect(url).toMatch(
      /^https:\/\/pigy\.test\/sim\/network\/bsky\.social\/oauth\/authorize\?/,
    );
    const outcome = await connectBlueskyInSandbox(
      browser,
      workspaces.sandbox,
      grace,
    );
    expect(outcome).toMatchObject({ connect: "connected", network: "bluesky" });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([
      {
        id: outcome.channel,
        network: "bluesky",
        accountId: expect.stringMatching(/^did:plc:[a-z2-7]{24}$/),
        handle: `@${grace}`,
        name: "Grace Hopper",
        // A simulated account has no address that a browser can open.
        avatarUrl: null,
        profileUrl: null,
        status: "connected",
        connectedAt: test.clock.time.getTime(),
        // Bluesky does not say when an access ends.
        expiresAt: null,
        limits: { network: "bluesky", maxCharacters: 300, maxBytes: 3000 },
        limitsCheckedAt: test.clock.time.getTime(),
      },
    ]);
    expect(test.network.requests).toEqual([]);
  });

  it("tells a person in a sandbox which accounts the sandbox has", async () => {
    const { test, browser, workspaces } = await start();
    // A real handle, which a person may well enter. The world of a
    // sandbox does not have it, and never will.
    const response = await startConnect(browser, workspaces.sandbox, {
      network: "bluesky",
      identifier: "ada.bsky.social",
    });
    expect(response.status).toBe(400);
    expect(connectErrorSchema.parse(await response.json())).toEqual({
      error: "InvalidInputError",
      message:
        "The sandbox has no account ada.bsky.social. Enter the handle of one of its simulated accounts: ada.bsky.test, grace.bsky.test and alan.bsky.test.",
      field: "identifier",
    });
    expect(test.network.requests).toEqual([]);
  });

  it("connects a real account through the fetch of the app, which Bluesky reads pigy from", async () => {
    const { test, browser, workspaces } = await start();
    const outcome = await connectBlueskyLive(test, browser, workspaces.live);
    expect(outcome.connect).toBe("connected");
    const [channel] = await channelsOf(browser, workspaces.live);
    expect(channel).toMatchObject({
      network: "bluesky",
      accountId: test.network.blueskyAccount.id,
      handle: `@${realBlueskyHandle}`,
      // A real account has a page on Bluesky.
      profileUrl: `https://bsky.app/profile/${test.network.blueskyAccount.id}`,
    });
    // The account was found the way atproto has it, and its posts go to
    // its own PDS.
    expect(test.network.requests).toEqual(
      expect.arrayContaining([
        `GET https://cloudflare-dns.com/dns-query?name=_atproto.${realBlueskyHandle}&type=TXT`,
        `GET https://plc.directory/${test.network.blueskyAccount.id}`,
        `GET https://${realBlueskyPds}/.well-known/oauth-protected-resource`,
        "POST https://bsky.social/oauth/par",
        "POST https://bsky.social/oauth/token",
      ]),
    );
  });

  it("gives the access back when the channel is disconnected", async () => {
    const { test, browser, workspaces } = await start();
    const { channel = "" } = await connectBlueskyLive(
      test,
      browser,
      workspaces.live,
    );
    expect(await disconnected(browser, workspaces.live, channel)).toBe(true);
    // Every token of the session is worthless now.
    expect(
      test.network.world
        .tokens("bluesky")
        .every((token) => test.network.world.tokenStatus(token) !== "valid"),
    ).toBe(true);
  });

  /** Makes the workspace fail to store a channel, in the way of `how`. */
  function failingToStore(how: "throws" | "refuses") {
    const stores = vi
      .spyOn(WorkspaceStore.prototype, "connectChannel")
      .mockImplementation(() => {
        if (how === "throws") {
          throw new Error("The database of the workspace is in trouble");
        }
        return {
          ok: false,
          code: "invalid_arguments",
          message: "Not this channel",
        };
      });
    onTestFinished(() => stores.mockRestore());
    return stores;
  }

  /** What Bluesky has issued, and which of it still works. */
  const sessionTokens = ({ network }: Pick<TestSetup, "network">) =>
    network.world.tokens("bluesky").map((token) => ({
      token: token.token,
      status: network.world.tokenStatus(token),
    }));

  it.each(["throws", "refuses"] as const)(
    "gives the access back when the workspace %s while it stores the channel",
    async (how) => {
      const { test, browser, workspaces } = await start();
      const stores = failingToStore(how);
      const errors = expectErrors();

      const outcome = await connectBlueskyLive(test, browser, workspaces.live);

      // The connection got as far as the channel: Bluesky has handed over
      // a session, and the workspace did not keep it. A workspace that
      // throws is asked a second time, in case only its answer was lost,
      // and one that refuses has answered.
      expect(stores).toHaveBeenCalledTimes(how === "throws" ? 2 : 1);
      expect(outcome).toMatchObject({ connect: "failed", network: "bluesky" });
      expect(await channelsOf(browser, workspaces.live)).toEqual([]);
      // The answer does not wait for Bluesky. What the app has asked the
      // runtime to keep going is all that is left of the request for
      // somebody who has closed the tab.
      await Promise.all(test.keptAlive);
      // Nobody holds the refresh token of that session, so nobody could
      // end it later. It is ended now: none of its tokens works.
      const tokens = sessionTokens(test);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.filter(({ status }) => status === "valid")).toEqual([]);
      expect(test.network.requests).toContain(
        "POST https://bsky.social/oauth/revoke",
      );
      // The log says why the connection failed, and holds no token.
      const log = errors.mock.calls.flat().map(logged).join("\n");
      expect(log).toContain(
        how === "throws" ? "is in trouble" : "Not this channel",
      );
      for (const { token } of tokens) expect(log).not.toContain(token);
    },
  );

  /**
   * A Bluesky whose token endpoint holds the answer in which it hands out
   * a session, until `release` is called: the session stands at Bluesky,
   * and pigy does not have it yet. `reached` settles when the answer has
   * got that far.
   */
  function heldTokenAnswer() {
    let reach = () => {};
    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interceptNetwork = (network: Fetch): Fetch => {
      return async (input, init) => {
        const response = await network(input, init);
        // Only the answer with the tokens: the server refuses the first
        // request once, for a nonce.
        if (urlOf(input).endsWith("/oauth/token") && response.ok) {
          reach();
          await released;
        }
        return response;
      };
    };
    return { interceptNetwork, reached, release: () => release() };
  }

  it("gives the access back when nobody waits for the callback and the channel is not stored", async () => {
    const tokenAnswer = heldTokenAnswer();
    const { test, browser, workspaces } = await start(tokenAnswer);
    failingToStore("throws");
    expectErrors();
    const before = test.keptAlive.length;

    // Somebody who consents and closes the tab while pigy exchanges the
    // code: Bluesky has issued the session, and nobody reads the answer of
    // the callback.
    const unread = connectBlueskyLive(test, browser, workspaces.live);
    await tokenAnswer.reached;
    expect(sessionTokens(test).some(({ status }) => status === "valid")).toBe(
      true,
    );
    // The runtime ends what is left of such a request, except the work that
    // it was asked to keep going. So that work has to be there by now,
    // before the workspace is asked and fails, and it is all that this
    // test waits for.
    const kept = test.keptAlive.slice(before);
    expect(kept).toHaveLength(1);
    tokenAnswer.release();
    await Promise.all(kept);

    // It went to its end, which is the revocation: no token works.
    expect(
      sessionTokens(test).filter(({ status }) => status === "valid"),
    ).toEqual([]);
    expect(await unread).toMatchObject({ connect: "failed" });
  });

  it("keeps the access of a channel that the workspace stored when only its answer was lost", async () => {
    const { test, browser, workspaces } = await start();
    const connectChannel = WorkspaceStore.prototype.connectChannel;
    // The workspace stores the channel, and its answer does not arrive.
    const stores = vi
      .spyOn(WorkspaceStore.prototype, "connectChannel")
      .mockImplementationOnce(function (this: WorkspaceStore, ...call) {
        connectChannel.apply(this, call);
        throw new Error("The answer of the workspace was lost");
      });
    onTestFinished(() => stores.mockRestore());
    const errors = expectErrors();

    const outcome = await connectBlueskyLive(test, browser, workspaces.live);
    await Promise.all(test.keptAlive);

    // The callback asked again, and was answered as the first time: the
    // person is told what is true, and the channel was stored once.
    expect(stores).toHaveBeenCalledTimes(2);
    const [channel] = await channelsOf(browser, workspaces.live);
    expect(channel).toMatchObject({ status: "connected" });
    expect(outcome).toMatchObject({
      connect: "connected",
      channel: channel?.id,
    });
    // The second call stored nothing: the channel has the credentials of
    // the first, which are the same sealed text only because nothing was
    // written again.
    expect(await storedAccess(workspaces.live)).toHaveLength(1);
    // The session of the channel stands. Given back, the channel would say
    // `connected` with an access that is gone.
    expect(test.network.requests).not.toContain(
      "POST https://bsky.social/oauth/revoke",
    );
    expect(
      sessionTokens(test).filter(({ status }) => status !== "valid"),
    ).toEqual([]);
    // The operator still reads that the workspace failed once.
    expect(errors.mock.calls.flat().map(logged).join("\n")).toContain(
      "was lost",
    );
  });

  it("stores the channel with a second call when the first one never happened", async () => {
    const { test, browser, workspaces } = await start();
    // The workspace fails once, before it has stored anything.
    const stores = vi
      .spyOn(WorkspaceStore.prototype, "connectChannel")
      .mockImplementationOnce(() => {
        throw new Error("The database of the workspace is in trouble");
      });
    onTestFinished(() => stores.mockRestore());
    expectErrors();

    const outcome = await connectBlueskyLive(test, browser, workspaces.live);
    await Promise.all(test.keptAlive);

    expect(stores).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ connect: "connected" });
    expect(await channelsOf(browser, workspaces.live)).toMatchObject([
      { id: outcome.channel, status: "connected" },
    ]);
    // Nothing was given back: the session is the channel's.
    expect(
      sessionTokens(test).filter(({ status }) => status !== "valid"),
    ).toEqual([]);
  });

  it("ends the session of the connection before when the account is connected again", async () => {
    const { test, browser, workspaces } = await start();
    const first = await connectBlueskyLive(test, browser, workspaces.live);
    const before = sessionTokens(test).map(({ token }) => token);
    expect(before.length).toBeGreaterThan(0);
    // The second connection is a later one, as it is in life.
    test.advance(60_000);

    const second = await connectBlueskyLive(test, browser, workspaces.live);
    // The earlier session is given back apart from the answer.
    await Promise.all(test.keptAlive);

    // The same channel, with the session of the second connection.
    expect(second).toMatchObject({
      connect: "connected",
      channel: first.channel,
    });
    // Nothing holds the session of the first connection any more, so
    // nothing could end it later: it is ended now. The session of the
    // second is the channel's, and stands.
    const tokens = sessionTokens(test);
    const earlier = tokens.filter(({ token }) => before.includes(token));
    const later = tokens.filter(({ token }) => !before.includes(token));
    expect(earlier.map(({ status }) => status)).not.toContain("valid");
    expect(later.length).toBeGreaterThan(0);
    expect(later.filter(({ status }) => status !== "valid")).toEqual([]);
    // And it is what the channel acts with: the network takes it back
    // when the channel is disconnected, which it would not if the channel
    // held the session that was ended.
    expect(
      await disconnected(browser, workspaces.live, second.channel ?? ""),
    ).toBe(true);
    expect(
      sessionTokens(test).filter(({ status }) => status === "valid"),
    ).toEqual([]);
  });

  it("says in the log, without a secret, when Bluesky does not take the access of a failed connection back", async () => {
    const { test, browser, workspaces } = await start({
      // Bluesky is in trouble where it takes a token back.
      interceptNetwork: (network: Fetch): Fetch => {
        return async (input, init) =>
          urlOf(input).endsWith("/oauth/revoke")
            ? Response.json({ error: "server_error" }, { status: 500 })
            : network(input, init);
      },
    });
    failingToStore("throws");
    const errors = expectErrors();
    const warnings = expectWarnings();

    const outcome = await connectBlueskyLive(test, browser, workspaces.live);
    await Promise.all(test.keptAlive);

    // The person is told what they would be told anyway.
    expect(outcome).toMatchObject({ connect: "failed" });
    // The operator reads that a session is left at Bluesky. Its tokens
    // are still good there, so they above all must not be in the log.
    const log = [...errors.mock.calls, ...warnings.mock.calls]
      .flat()
      .map(logged)
      .join("\n");
    expect(log).toContain("was not given back");
    const tokens = sessionTokens(test);
    expect(tokens.some(({ status }) => status === "valid")).toBe(true);
    for (const { token } of tokens) expect(log).not.toContain(token);
  });

  it("keeps none of the session's secrets where a client can see them", async () => {
    const { test, browser, workspaces } = await start();
    await connectBlueskyLive(test, browser, workspaces.live);
    const client = new SyncClient();
    await client.connect(browser, workspaces.live);
    // Everything that the workspace has sent the client.
    const synced = client.received.join("\n");
    const stored = JSON.stringify(await storedAccess(workspaces.live));
    for (const { token } of test.network.world.tokens("bluesky")) {
      // Not in a sync message, and sealed where the workspace keeps it.
      expect(synced).not.toContain(token);
      expect(stored).not.toContain(token);
    }
  });
});

describe("publishing to Bluesky", () => {
  it("publishes a thread to a simulated account in the sandbox", async () => {
    const { test, workspace, channel, client } = await withChannel("sandbox");
    const draft = await writeDraft(client, workspace, "One", "Two");
    const [targetId = ""] = await publishTo(client, draft.postId, channel);

    expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
    const posts = await worldEntries<{
      id: string;
      text: string;
      replyToId: string | null;
    }>(workspace, "post/bluesky/");
    const ids = publishedOf(client, targetId, draft);
    expect(
      [...posts].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    ).toMatchObject([
      { id: ids[0], text: "One", replyToId: null },
      { id: ids[1], text: "Two", replyToId: ids[0] },
    ]);
    expect(test.network.requests).toEqual([]);
  });

  it("publishes a thread to a real account, with a link to each part", async () => {
    const { test, workspace, channel, client } = await withChannel("live");
    const draft = await writeDraft(client, workspace, "One", "Two");
    const [targetId = ""] = await publishTo(client, draft.postId, channel);

    expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
    const [first, second] = feed(test.network.world, ["bluesky"]).map(
      ({ post }) => post,
    );
    expect([first?.text, second?.text]).toEqual(["One", "Two"]);
    expect(second?.replyToId).toBe(first?.id);
    // The results name the parts in the order of the thread, each with
    // its link.
    expect(publishedOf(client, targetId, draft)).toEqual([
      first?.id,
      second?.id,
    ]);
    const urls = new Map(
      client
        .table("target_part_result")
        .map(({ remoteId, url }) => [remoteId, url]),
    );
    expect([urls.get(first?.id ?? ""), urls.get(second?.id ?? "")]).toEqual([
      first?.url,
      second?.url,
    ]);
    expect(first?.url).toMatch(/^https:\/\/bsky\.app\/profile\/did:plc:/);
  });

  it("renews an access that has ended in the step that was refused, and keeps what it got", async () => {
    const { test, browser, workspace, channel, client } =
      await withChannel("live");
    const sealed = async () =>
      (await storedAccess(workspace)).find(({ id }) => id === channel)
        ?.credentials;
    const before = await sealed();
    // Long enough for the access token to have ended, and for the socket
    // of the client, which is connected anew.
    test.advance(accessTokenLifetimeMs + 1000);
    await client.connect(browser, workspace);

    const first = await writeDraft(client, workspace, "After a while");
    await publishTo(client, first.postId, channel);
    expect(await ended(client, first.postId)).toMatchObject({ status: "sent" });
    // The refresh replaced the credentials in the channel. Bluesky ends
    // the refresh token that it was given, so these are now the only ones
    // that work.
    const after = await sealed();
    expect(after).not.toBe(before);

    // A later post goes out with what was stored: a second refresh from
    // the credentials before would have ended the session.
    test.advance(accessTokenLifetimeMs + 1000);
    await client.connect(browser, workspace);
    const second = await writeDraft(client, workspace, "Later still");
    await publishTo(client, second.postId, channel);
    expect(await ended(client, second.postId)).toMatchObject({
      status: "sent",
    });
    expect(
      feed(test.network.world, ["bluesky"]).map(({ post }) => post.text),
    ).toEqual(["After a while", "Later still"]);
    expect(client.table("channel")[0]?.status).toBe("connected");
  });

  it("asks for the account to be connected again when the key that it was connected with is gone", async () => {
    const { test, browser, workspace, channel, client } =
      await withChannel("live");
    // The access token has ended by the time of the post, so that its
    // first step is refused and renews the access: a refresh is what
    // needs the key of the client. A post needs none, so with an access
    // token that is still good it would go out. The socket of the client
    // has ended too, and is connected anew.
    test.advance(accessTokenLifetimeMs + 1000);
    await client.connect(browser, workspace);
    // The operator replaced the key without keeping the old one.
    test.redeploy({ BLUESKY_CLIENT_KEYS: `2:${otherClientKey}` });

    const draft = await writeDraft(client, workspace, "Without the key");
    const [targetId = ""] = await publishTo(client, draft.postId, channel);
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "error",
    });
    expect(targetOf(client, targetId).status).toBe("error");
    // In the same change as the target.
    expect(
      client.table("channel").find(({ id }) => id === channel)?.status,
    ).toBe("needs_reconnect");
    expect(feed(test.network.world, ["bluesky"])).toEqual([]);
    expect(postOf(client, draft.postId).status).toBe("error");
  });

  it("records the key of each part before it writes the part, and nothing secret", async () => {
    // The PDS holds a request that writes a part under a key until the test
    // lets the key through. The test and the request each look at the
    // value on a timer of their own: the request is made by a step of a
    // workflow, which a promise of the test must not wake.
    const writes = {
      holding: true,
      waiting: null as string | null,
      passed: new Set<string>(),
    };
    const createRecord = `https://${realBlueskyPds}/xrpc/com.atproto.repo.createRecord`;
    const context = await started({
      interceptNetwork:
        (network: Fetch): Fetch =>
        async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "POST" && request.url === createRecord) {
            const { rkey } = (await request.clone().json()) as {
              rkey: string;
            };
            while (writes.holding && !writes.passed.has(rkey)) {
              writes.waiting = rkey;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
          return network(request);
        },
    });
    const { test, browser, workspaces } = context;
    const workspace = workspaces.live;
    const { channel = "" } = await connectBlueskyLive(test, browser, workspace);
    const client = new SyncClient();
    await client.connect(browser, workspace);
    const did = test.network.blueskyAccount.id;
    const progress = async () => {
      const [row] = await storedProgress(workspace);
      return row?.progress ?? "";
    };
    /** A part as the network has it, and as the progress names it. */
    const part = (text: string) => {
      const post = feed(test.network.world, ["bluesky"]).find(
        (entry) => entry.post.text === text,
      )?.post as PostRecord | undefined;
      if (!post) throw new Error(`Bluesky has no post "${text}"`);
      return {
        published: { id: post.id, url: post.url },
        ref: { uri: post.id, cid: post.cid },
        rkey: post.rkey,
      };
    };

    try {
      const draft = await writeDraft(client, workspace, "One", "Two");
      await publishTo(client, draft.postId, channel);
      const written: ReturnType<typeof part>[] = [];
      for (const text of ["One", "Two"]) {
        await vi.waitFor(() => expect(writes.waiting).not.toBeNull(), patience);
        const key = writes.waiting ?? "";
        // The write of the part is on its way, and the workspace has the
        // key that it is written under already, with the parts before it.
        expect(JSON.parse(await progress())).toEqual({
          parts: written.map(({ published }) => published),
          done: false,
          waitSeconds: 0,
          state: { did, rkey: key, refs: written.map(({ ref }) => ref) },
        });
        writes.waiting = null;
        writes.passed.add(key);
        // Written under that key.
        await vi.waitFor(() => expect(part(text).rkey).toBe(key), patience);
        written.push(part(text));
      }
      expect(await ended(client, draft.postId)).toMatchObject({
        status: "sent",
      });
      // What the workspace keeps of the delivery: record keys and hashes,
      // and nothing besides.
      const kept = await progress();
      expect(JSON.parse(kept)).toEqual({
        parts: written.map(({ published }) => published),
        done: true,
        waitSeconds: 0,
        state: { did, rkey: null, refs: written.map(({ ref }) => ref) },
      });
      for (const { token } of test.network.world.tokens("bluesky")) {
        expect(kept).not.toContain(token);
      }
    } finally {
      writes.holding = false;
    }
  });
});

describe("a first part that landed on Bluesky unseen", () => {
  const createRecord = `https://${realBlueskyPds}/xrpc/com.atproto.repo.createRecord`;

  /**
   * A Bluesky that writes the first record that it is asked to write and
   * loses the answer, and is out of reach from then on, until the test
   * brings it back. `writes` counts the records that it wrote.
   */
  function losingTheFirstWrite() {
    const network = { state: "up" as "up" | "down", writes: 0 };
    const intercept =
      (reach: Fetch): Fetch =>
      async (input, init) => {
        if (network.state === "down") {
          throw new TypeError("The network is down");
        }
        const request = new Request(input, init);
        const writes =
          request.method === "POST" && request.url === createRecord;
        const response = await reach(request);
        // Only a write that the PDS carried out: it refuses the first
        // request of every step once, for a nonce.
        if (writes && response.ok && ++network.writes === 1) {
          network.state = "down";
          throw new TypeError("The answer was lost");
        }
        return response;
      };
    return { network, intercept };
  }

  it("is found when the delivery is tried again after another has gone to the account", async () => {
    const { network, intercept } = losingTheFirstWrite();
    const context = await started({ interceptNetwork: intercept });
    const { test, browser, workspaces } = context;
    const workspace = workspaces.live;
    const { channel = "" } = await connectBlueskyLive(test, browser, workspace);
    const client = new SyncClient();
    await client.connect(browser, workspace);
    const texts = () =>
      feed(test.network.world, ["bluesky"])
        .map(({ post }) => post.text)
        .sort();
    const progressOf = async (targetId: string) =>
      (await storedProgress(workspace)).find(({ id }) => id === targetId)
        ?.progress ?? "";

    const draft = await writeDraft(client, workspace, "Lost", "Its reply");
    const [targetId = ""] = await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);
    // The first part is on the network, and pigy does not know: it gave
    // up on a server that it could not reach any more.
    expect(targetOf(client, targetId).status).toBe("error");
    expect(publishedOf(client, targetId, draft)).toEqual([]);
    expect(texts()).toEqual(["Lost"]);
    // What finds it: the key that it was written under, recorded before.
    const [lost] = feed(test.network.world, ["bluesky"]);
    const key = (lost?.post as PostRecord | undefined)?.rkey;
    expect(key).toBeTruthy();
    expect(JSON.parse(await progressOf(targetId))).toMatchObject({
      parts: [],
      state: { rkey: key },
    });

    // Another post goes to the account meanwhile, all the way: it does
    // not wait for the failed one. On Mastodon that is the end of what
    // the failed one recorded, because a later attempt would look through
    // what the account has posted since. Bluesky's adapter looks under
    // the key and nowhere else, so the key has to stay.
    network.state = "up";
    // The other delivery begins later than the first, if only by a
    // moment. The clock of the test stands still otherwise, and a record
    // key is the time with ten random bits: once in a thousand runs the
    // two deliveries would choose the same, and the second would find the
    // record of the first under its own key.
    test.advance(1);
    const other = await writeDraft(client, workspace, "Other");
    await publishTo(client, other.postId, channel);
    expect(await ended(client, other.postId)).toMatchObject({ status: "sent" });
    expect(JSON.parse(await progressOf(targetId))).toMatchObject({
      state: { rkey: key },
    });

    await retry(client, targetId);
    expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

    // The second attempt found the part under its key and wrote only the
    // reply: "Lost" is on the network once. Had it begun anew, it would
    // have chosen another key, found nothing there, and written it again.
    expect(texts()).toEqual(["Its reply", "Lost", "Other"]);
    expect(network.writes).toBe(3);
    expect(publishedOf(client, targetId, draft)[0]).toBe(lost?.post.id);
  });
});

describe("a delivery to Bluesky that is taken up again", () => {
  const createRecord = `https://${realBlueskyPds}/xrpc/com.atproto.repo.createRecord`;

  // The workflow does not tell the workspace that a delivery to Bluesky is
  // about to send, which is where a delivery to Mastodon finds out that it
  // has been ended. What keeps one to Bluesky from sending for a channel
  // that is gone is the step itself, which asks the workspace for the
  // access of the channel before it asks the network for anything.
  it("sends nothing when its channel is disconnected before its first request", async () => {
    // A Bluesky that is out of reach until the test brings it back, and
    // that counts the records that it is asked to write.
    const network = { down: true, writes: 0 };
    const context = await started({
      interceptNetwork:
        (reach: Fetch): Fetch =>
        async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "POST" && request.url === createRecord) {
            network.writes++;
          }
          if (network.down) throw new TypeError("The network is down");
          return reach(request);
        },
    });
    const { test, browser, workspaces } = context;
    const workspace = workspaces.live;
    network.down = false;
    const { channel = "" } = await connectBlueskyLive(test, browser, workspace);
    const client = new SyncClient();
    await client.connect(browser, workspace);

    // The first attempt chooses the key of its record, records it, and
    // gives up on a server that it cannot reach.
    network.down = true;
    const draft = await writeDraft(client, workspace, "Never sent");
    const [targetId = ""] = await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);
    expect(targetOf(client, targetId).status).toBe("error");
    const progress = (await storedProgress(workspace)).find(
      ({ id }) => id === targetId,
    )?.progress;
    expect(JSON.parse(progress ?? "null")).toMatchObject({
      parts: [],
      state: { rkey: expect.any(String) },
    });
    expect(feed(test.network.world, ["bluesky"])).toEqual([]);
    network.down = false;
    network.writes = 0;

    // The channel is disconnected in the moment after the second attempt
    // has been told what to publish, which is the end of its checks: the
    // workspace answers the workflow and removes the channel in one go.
    // A test cannot be sure to get in between otherwise: nothing is asked
    // of the network there, so nothing can be held.
    const delivery = WorkspaceStore.prototype.delivery;
    let disconnectedAt: number | undefined;
    const asked = vi
      .spyOn(WorkspaceStore.prototype, "delivery")
      .mockImplementation(function (this: WorkspaceStore, run) {
        const told = delivery.call(this, run);
        if (told && run.targetId === targetId && run.attempt === 2) {
          disconnectedAt = test.clock.time.getTime();
          expect(this.disconnectChannel(channel, disconnectedAt)).toMatchObject(
            { ok: true },
          );
        }
        return told;
      });
    onTestFinished(() => asked.mockRestore());
    await retry(client, targetId);
    await vi.waitFor(() => expect(disconnectedAt).toBeDefined(), patience);
    // To the end of the run: it has nothing more to do after that.
    const events = await eventsOf(workspace, targetId);

    // The attempt had a key to write under and a text to write, and its
    // first step would have written it. It asked for the access of the
    // channel first, and stopped there, without a word: the disconnect has
    // ended the delivery already.
    expect(network.writes).toBe(0);
    expect(feed(test.network.world, ["bluesky"])).toEqual([]);
    expect(events.at(-1)?.type).toBe("workflow_completed");
    // Its steps: the checks and the step that would have sent, and no
    // end of its own. The step did not fail for want of credentials,
    // which would have been a failure to report: it found the channel
    // gone, and that is the check that the guarantee rests on.
    expect(
      events.flatMap((event) =>
        event.type === "step_started" && "stepName" in event
          ? [event.stepName]
          : [],
      ),
    ).toEqual(["prepare-1", "publish-1-1"]);
    const after = new SyncClient();
    await after.connect(browser, workspace);
    after.disconnect();
    expect(targetOf(after, targetId)).toMatchObject({
      status: "error",
      attempt: 2,
    });
    expect(after.table("channel")).toEqual([]);
  });
});
