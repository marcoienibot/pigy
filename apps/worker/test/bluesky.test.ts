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
import { describe, expect, it, vi } from "vitest";
import { developmentBlueskyClientKeys } from "../src/development-keys.ts";
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
  realBlueskyHandle,
  realBlueskyPds,
  setup,
  signedIn,
} from "./helpers.ts";
import {
  ended,
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
