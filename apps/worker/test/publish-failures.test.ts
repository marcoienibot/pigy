import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Json, type Provider, ProviderError } from "@pigy/providers";
import { feed } from "@pigy/simulators/world";
import { expect, it, onTestFinished, vi } from "vitest";
import { openCredentials } from "../src/channels/credentials.ts";
import { providerOf } from "../src/network/providers.ts";
import { lostTrackMessage } from "../src/publish/delivery.ts";
import { createVault } from "../src/vault.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { renewChannelAccess } from "../src/workspace/workspaces.ts";
import { channelsOf, storedAccess } from "./channels.ts";
import { deployment } from "./clock.ts";
import {
  credentialKey,
  credentialKeys,
  expectErrors,
  expectWarnings,
  logged,
  realMastodonDomain,
} from "./helpers.ts";
import {
  connectAccount,
  ended,
  follow,
  inPlaceOfPosting,
  postStatus,
  publishedOf,
  publishTo,
  retry,
  runIdOf,
  started,
  targetOf,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import { identityOf, objectOf, SyncClient } from "./sync-client.ts";

/**
 * A live workspace with one connected account, a client that follows it,
 * and a draft that is ready to go out.
 */
async function ready(
  options: Parameters<typeof started>[0] = {},
  ...texts: [string, ...string[]]
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, ...texts);
  const texted = () => feed(test.network.world).map(({ post }) => post.text);
  return {
    ...context,
    workspace: workspaces.live,
    channel,
    client,
    draft,
    texted,
  };
}

/** Publishes the draft of `ready()` and returns its target once it has ended. */
async function delivered({
  client,
  draft,
  channel,
}: Pick<Awaited<ReturnType<typeof ready>>, "client" | "draft" | "channel">) {
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  return targetOf(client, targetId);
}

it("waits out a rate limit for as long as the network says, and then publishes", async () => {
  const context = await ready({}, "Patience");
  const { test, workflows, texted } = context;
  // The server answers the next request to post with 429, and says when
  // it will take requests again: in five minutes.
  test.network.mastodon.arm({ kind: "rate-limit", operation: "publish" });

  const target = await delivered(context);

  expect(target).toMatchObject({ status: "sent", attempt: 1, error: null });
  expect(texted()).toEqual(["Patience"]);
  // The try that was refused is a step of its own, and says what the
  // network said: what the workflow did next follows from it on a replay.
  const [run] = await workflows.get();
  expect(await run?.waitForStepResult({ name: "publish-2" })).toEqual({
    failure: {
      kind: "retry",
      message: `${realMastodonDomain} is limiting how often pigy may ask.`,
      waitSeconds: 300,
    },
  });
  // It waited that long, and then ran the step again as a step of its own.
  expect(await waitsOf(context.workspace, target.id)).toEqual({
    "publish-2-wait-1": 300,
  });
  expect(
    await run?.waitForStepResult({ name: "publish-2-try-2" }),
  ).toMatchObject({ value: { done: true } });
});

it("publishes a part once when its answer is lost and the step is run again", async () => {
  const context = await ready({}, "Once", "And its reply");
  const { test, client, draft, texted } = context;
  // The server posts the first part and its answer never arrives: the app
  // cannot tell whether the part is there.
  test.network.mastodon.arm({ kind: "lost-response", operation: "publish" });

  const target = await delivered(context);

  // The step waited, a minute, which is longer than a request can take,
  // and was run again. It looked before it posted, and found its part.
  expect(target).toMatchObject({ status: "sent", attempt: 1 });
  expect(await waitsOf(context.workspace, target.id)).toEqual({
    "publish-2-wait-1": 60,
  });
  expect(texted()).toEqual(["Once", "And its reply"]);
  // The reply went under the part that the first run had posted.
  const posts = feed(test.network.world).map(({ post }) => post);
  expect(posts[1]?.replyToId).toBe(posts[0]?.id);
  expect(publishedOf(client, target.id, draft)).toEqual(
    posts.map(({ id }) => id),
  );
});

it("gives up on a network that stays out of reach, after waiting longer every time", async () => {
  let down = false;
  const context = await ready(
    {
      interceptNetwork: (network) => (input, init) => {
        // What `fetch` does when a host cannot be reached.
        if (down) throw new TypeError("The network is down");
        return network(input, init);
      },
    },
    "Into the void",
  );
  down = true;

  const target = await delivered(context);

  expect(target).toMatchObject({
    status: "error",
    attempt: 1,
    // What the adapter said, and that the step was not run once only.
    error: `${realMastodonDomain} could not be reached. pigy has tried 6 times.`,
  });
  // The first step of the delivery never got through. Its waits double
  // from a minute, and there is an end to them: half an hour in all.
  expect(await waitsOf(context.workspace, target.id)).toEqual({
    "publish-1-wait-1": 60,
    "publish-1-wait-2": 120,
    "publish-1-wait-3": 240,
    "publish-1-wait-4": 480,
    "publish-1-wait-5": 960,
  });
  expect(context.texted()).toEqual([]);
  // A network that is down is no reason to connect the account again.
  expect(
    (await channelsOf(context.browser, context.workspace))[0]?.status,
  ).toBe("connected");
});

it("does not wait for a network that names a time far away", async () => {
  let limited = false;
  const context = await ready(
    {
      interceptNetwork: inPlaceOfPosting(
        () => limited,
        async () =>
          Response.json(
            { error: "Too many requests" },
            // Three hours from now, by the clock of the test.
            {
              status: 429,
              headers: { "X-RateLimit-Reset": "2026-11-14T13:00:00.000000Z" },
            },
          ),
      ),
    },
    "Too much",
  );
  limited = true;

  const target = await delivered(context);

  // The delivery would hold its account up for hours. It fails at once,
  // for the person to try again when they see fit.
  expect(target).toMatchObject({
    status: "error",
    error: `${realMastodonDomain} is limiting how often pigy may ask.`,
  });
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
});

it("fails a target with what the network says when it refuses a post", async () => {
  let refusing = false;
  const context = await ready(
    {
      interceptNetwork: inPlaceOfPosting(
        () => refusing,
        async (_network, _input, init) =>
          Response.json(
            {
              // A server that repeats the request in its answer, token
              // and all.
              error: `Validation failed: Text is not welcome here (${new Headers(init?.headers).get("Authorization")})`,
            },
            { status: 422 },
          ),
      ),
    },
    "Unwelcome",
  );
  const { test, client } = context;
  const [{ token = "" } = {}] = test.network.world.tokens("mastodon");
  const errors = expectErrors();
  const warnings = expectWarnings();
  refusing = true;

  const target = await delivered(context);

  // Trying again would fail again, so nothing was tried again.
  expect(target).toMatchObject({
    status: "error",
    error: `${realMastodonDomain} refused the request: Validation failed: Text is not welcome here (Bearer [removed])`,
  });
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
  // The token that the server repeated got nowhere: not into the row, not
  // into any message to the client, and not into a log.
  expect(token).not.toBe("");
  expect(client.received.join("\n")).not.toContain(token);
  expect(logged([...errors.mock.calls, ...warnings.mock.calls])).not.toContain(
    token,
  );
});

it("marks the channel when the network no longer takes its access, and sends nothing to it until it is connected again", async () => {
  const context = await ready({}, "Locked out");
  const { test, browser, workspace, channel, client, texted } = context;
  // Somebody has taken the access back at the network.
  test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });

  const target = await delivered(context);

  const reconnect = `${realMastodonDomain} no longer accepts the access that pigy was given to this account.`;
  expect(target).toMatchObject({ status: "error", error: reconnect });
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
  // The client learns of both in one change: the target that failed, and
  // the channel that has to be connected again.
  expect(client.table("channel")).toMatchObject([
    { id: channel, status: "needs_reconnect" },
  ]);

  // The next post to the account fails without a request to the network:
  // it would be refused the same way.
  const asked = test.network.requests.length;
  const next = await writeDraft(client, workspace, "Still locked out");
  const [nextTarget = ""] = await publishTo(client, next.postId, channel);
  await ended(client, next.postId);
  expect(targetOf(client, nextTarget)).toMatchObject({
    status: "error",
    error: "This account has to be connected again before pigy can post to it.",
  });
  expect(test.network.requests).toHaveLength(asked);

  // Connected again, the account has the channel it had, and what failed
  // can be tried again.
  expect(await connectAccount(test, browser, workspace)).toBe(channel);
  await client.patch();
  await retry(client, target.id);
  expect(await ended(client, context.draft.postId)).toMatchObject({
    status: "sent",
  });
  expect(targetOf(client, target.id)).toMatchObject({
    status: "sent",
    attempt: 2,
    error: null,
  });
  expect(texted()).toEqual(["Locked out"]);
});

/** Puts `wrap` between the publishing workflow and its adapters. */
function withAdapter(wrap: (provider: Provider) => Provider) {
  deployment.providerOf = (...args) => {
    const connection = providerOf(...args);
    return connection && { ...connection, provider: wrap(connection.provider) };
  };
}

it("asks a person to look when a network leaves open whether it has published", async () => {
  const context = await ready({}, "Maybe");
  const look =
    "The network did not say whether the post is there. Look at the account before you try again.";
  let asked = 0;
  // An adapter of a network on which pigy can neither look nor repeat a
  // request safely, as LinkedIn will be. Mastodon's never says this.
  withAdapter((provider) => ({
    ...provider,
    async publishStep(request) {
      const progress = await provider.publishStep(request);
      // The request to post went out, and no clear answer came back.
      if (progress.parts.length > 0 && asked++ === 0) {
        throw new ProviderError("uncertain", look);
      }
      return progress;
    },
  }));

  const target = await delivered(context);

  // The workflow does not run the step again by itself: on such a network
  // that would be a second post.
  expect(target).toMatchObject({
    status: "uncertain",
    attempt: 1,
    error: look,
  });
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
  expect(context.client.table("post")[0]?.status).toBe("error");
  // The account is fine.
  expect(context.client.table("channel")[0]?.status).toBe("connected");

  // The person has looked, and asks for another try. It goes on from what
  // was recorded.
  await retry(context.client, target.id);
  await ended(context.client, context.draft.postId);
  expect(targetOf(context.client, target.id)).toMatchObject({
    status: "sent",
    attempt: 2,
  });
});

it("takes a step that fails in a way of pigy's own for one whose outcome nobody knows", async () => {
  let broken = false;
  const context = await ready(
    {
      interceptNetwork: inPlaceOfPosting(
        () => broken,
        async (network, input, init) => {
          // The request arrives, and what stands behind `fetch` fails
          // afterwards in a way that is no failure of a network.
          await network(input, init);
          throw new RangeError("A bug behind fetch");
        },
      ),
    },
    "Half done",
  );
  const errors = expectErrors();
  broken = true;

  const target = await delivered(context);

  // No kind is read into it: not tried again as if the network had been
  // busy, and not failed as if nothing had been sent. The part is on the
  // network, and the target says that somebody has to look.
  expect(target).toMatchObject({
    status: "uncertain",
    attempt: 1,
    error: lostTrackMessage,
  });
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
  expect(context.texted()).toEqual(["Half done"]);
  expect(publishedOf(context.client, target.id, context.draft)).toEqual([]);
  // It is in the log, as the error that it was.
  expect(errors).toHaveBeenCalledWith(
    "A step of a delivery failed",
    expect.objectContaining({ message: "A bug behind fetch" }),
  );

  // Tried again, the step looks before it posts, and finds the part.
  await retry(context.client, target.id);
  await ended(context.client, context.draft.postId);
  expect(targetOf(context.client, target.id).status).toBe("sent");
  expect(context.texted()).toEqual(["Half done"]);
});

/**
 * An adapter of a network whose access runs out, in place of Mastodon's,
 * which never asks for a refresh. Its credentials are Mastodon's with a
 * generation, and the network takes those of `network.generation` only.
 * What a channel holds from its connection counts as generation 0.
 */
function refreshing(network: { generation: number; refreshes: number }) {
  type Aged = { generation: number; inner: Json };
  const aged = (credentials: Json): Aged =>
    credentials !== null &&
    typeof credentials === "object" &&
    "generation" in credentials
      ? (credentials as Aged)
      : { generation: 0, inner: credentials };
  const current = (credentials: Json): Json => {
    const { generation, inner } = aged(credentials);
    if (generation !== network.generation) {
      throw new ProviderError("refresh", "The access token has run out.");
    }
    return inner;
  };
  return (provider: Provider): Provider => ({
    ...provider,
    limits: (credentials) => provider.limits(current(credentials)),
    publishStep: (request) =>
      provider.publishStep({
        ...request,
        credentials: current(request.credentials),
      }),
    async refresh(credentials) {
      network.refreshes++;
      return {
        credentials: { generation: 1, inner: aged(credentials).inner },
        refreshAt: new Date("2026-11-20T00:00:00Z"),
        expiresAt: new Date("2026-12-24T00:00:00Z"),
      };
    },
  });
}

/** The credentials that a channel holds, opened with the keys of the tests. */
async function heldBy(context: Awaited<ReturnType<typeof ready>>) {
  const vault = createVault(credentialKeys);
  if (typeof vault === "string") throw new Error(vault);
  const identity = await identityOf(context.test, context.workspace);
  const [channel] = await channelsOf(context.browser, context.workspace);
  const [access] = await storedAccess(context.workspace);
  if (!channel || !access) throw new Error("The workspace has no channel");
  return {
    identity,
    sealed: access.credentials,
    vault,
    channel,
    credentials: await openCredentials(
      vault,
      identity,
      channel,
      access.credentials,
    ),
  };
}

it("renews credentials that the network refuses before their time, and runs the step again", async () => {
  const context = await ready({}, "Refreshed");
  const network = { generation: 1, refreshes: 0 };
  withAdapter(refreshing(network));
  const before = await heldBy(context);

  const target = await delivered(context);

  // One refresh, in the step that was refused, and no wait: the network
  // had not taken the request.
  expect(target).toMatchObject({ status: "sent", attempt: 1 });
  expect(network.refreshes).toBe(1);
  expect(await waitsOf(context.workspace, target.id)).toEqual({});
  expect(context.texted()).toEqual(["Refreshed"]);
  // The channel holds the new credentials, sealed, and says when the
  // access ends now.
  const after = await heldBy(context);
  expect(after.credentials).toEqual({
    generation: 1,
    inner: before.credentials,
  });
  expect(after.sealed).not.toBe(before.sealed);
  expect(after.channel).toMatchObject({
    status: "connected",
    expiresAt: Date.parse("2026-12-24T00:00:00Z"),
  });

  // The next post goes out with them, and nothing is refreshed.
  const next = await writeDraft(context.client, context.workspace, "Again");
  const [nextTarget = ""] = await publishTo(
    context.client,
    next.postId,
    context.channel,
  );
  await ended(context.client, next.postId);
  expect(targetOf(context.client, nextTarget).status).toBe("sent");
  expect(network.refreshes).toBe(1);
});

it("goes on with renewed credentials that it could not store", async () => {
  const context = await ready({}, "Not lost");
  const network = { generation: 1, refreshes: 0 };
  withAdapter(refreshing(network));
  const before = await heldBy(context);
  const errors = expectErrors();
  // The network has renewed the credentials, and the workspace fails when
  // it is handed them.
  const failing = vi
    .spyOn(WorkspaceStore.prototype, "renewChannelAccess")
    .mockImplementationOnce(() => {
      throw new Error("The object was reset");
    });
  onTestFinished(() => failing.mockRestore());

  const target = await delivered(context);

  // Had the step ended there, it would have been run again with the
  // credentials that the refresh started from, which on some networks are
  // worth nothing by then. The post went out with the new ones instead.
  expect(target).toMatchObject({ status: "sent", attempt: 1 });
  expect(context.texted()).toEqual(["Not lost"]);
  expect(errors).toHaveBeenCalledWith(
    "The renewed credentials of a channel were not stored",
    expect.anything(),
  );
  // The next step asked the workspace for the credentials again, found the
  // old ones and renewed them once more, which this network allows. The
  // channel holds new ones in the end.
  expect(network.refreshes).toBe(2);
  expect((await heldBy(context)).credentials).toEqual({
    generation: 1,
    inner: before.credentials,
  });
});

it("asks for a new connection when the network refuses the renewed credentials too", async () => {
  const context = await ready({}, "No way in");
  // The network takes generation 2, and a refresh returns generation 1.
  const network = { generation: 2, refreshes: 0 };
  withAdapter(refreshing(network));

  const target = await delivered(context);

  // One refresh and no second: this must not go round in circles.
  expect(network.refreshes).toBe(1);
  expect(target).toMatchObject({
    status: "error",
    error: "The access token has run out.",
  });
  expect(context.client.table("channel")[0]?.status).toBe("needs_reconnect");
  expect(context.texted()).toEqual([]);
});

it("asks for a new connection when the network will not renew", async () => {
  const context = await ready({}, "Expired");
  const network = { generation: 1, refreshes: 0 };
  withAdapter((provider) => ({
    ...refreshing(network)(provider),
    refresh: async () => {
      throw new ProviderError(
        "reconnect",
        "The network no longer renews this access.",
      );
    },
  }));

  const target = await delivered(context);

  expect(target).toMatchObject({
    status: "error",
    error: "The network no longer renews this access.",
  });
  expect(context.client.table("channel")[0]?.status).toBe("needs_reconnect");
});

it("does not refresh credentials that another refresh has replaced meanwhile", async () => {
  const context = await ready({}, "Raced");
  const network = { generation: 1, refreshes: 0 };
  const before = await heldBy(context);
  let replaced = false;
  withAdapter((provider) => {
    const adapter = refreshing(network)(provider);
    return {
      ...adapter,
      async limits(credentials) {
        // While the first request with the old credentials is on its way,
        // something else renews them and stores the new ones. On some
        // networks a second refresh that starts from the old ones would
        // lock the account out.
        if (!replaced) {
          replaced = true;
          const renewed = await renewChannelAccess(
            env.WORKSPACE,
            before.identity,
            context.channel,
            before.sealed ?? "",
            {
              credentials: await before.vault.seal(
                [
                  "channel",
                  context.workspace,
                  "mastodon",
                  before.channel.accountId,
                ],
                { generation: 1, inner: before.credentials },
              ),
              refreshAt: null,
              expiresAt: null,
            },
          );
          expect(renewed).toBe(true);
        }
        return adapter.limits(credentials);
      },
    };
  });
  // A day has passed, so the delivery asks for the limits first: that is
  // the request that is refused.
  context.test.advance(24 * 60 * 60 * 1000);
  await context.client.connect(context.browser, context.workspace);

  const target = await delivered(context);

  // The step went on with the credentials that it found stored.
  expect(target).toMatchObject({ status: "sent", attempt: 1 });
  expect(network.refreshes).toBe(0);
  expect(context.texted()).toEqual(["Raced"]);
});

it("fails a target, and asks for a new connection, when the credentials of its channel no longer open", async () => {
  const context = await ready({}, "Sealed away");
  const warnings = expectWarnings();
  // The key that sealed the credentials was dropped from the deployment
  // too early.
  context.test.redeploy({ CREDENTIAL_KEYS: `2:${credentialKey(2)}` });

  const target = await delivered(context);

  expect(target).toMatchObject({
    status: "error",
    error:
      "pigy can no longer read the access that it was given to this account. Connect the account again.",
  });
  expect(context.client.table("channel")[0]?.status).toBe("needs_reconnect");
  // The log says why, without anything of the credentials.
  expect(warnings).toHaveBeenCalledWith(
    "The credentials of a channel did not open: There is no key of version 1",
  );
  expect(context.texted()).toEqual([]);
});

it("fails a target in a deployment that has lost its keys", async () => {
  const context = await ready({}, "Keyless");
  const errors = expectErrors();
  context.test.redeploy({ CREDENTIAL_KEYS: undefined });

  const target = await delivered(context);

  // Nothing is wrong with the account: the operator has to set the keys.
  expect(target).toMatchObject({
    status: "error",
    error:
      "This pigy cannot read the access to its accounts: its keys are missing.",
  });
  expect(context.client.table("channel")[0]?.status).toBe("connected");
  expect(String(errors.mock.calls[0]?.[0])).toContain(
    "CREDENTIAL_KEYS is not set",
  );
});

it("runs a step again when the workspace could not be asked what it needs", async () => {
  const context = await ready({}, "Second time lucky");
  const { test, workflows, texted } = context;
  expectErrors();
  // The object of the workspace fails once when the workflow asks it for
  // the credentials of the channel: a deploy has reset it, say. That is
  // before the adapter is called, so nothing has been sent.
  const failing = vi
    .spyOn(WorkspaceStore.prototype, "channelAccess")
    .mockImplementationOnce(() => {
      throw new Error("The object was reset");
    });
  onTestFinished(() => failing.mockRestore());
  // The platform runs the step again after a minute, and a test does not
  // wait for that.
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });

  const target = await delivered(context);

  // Not a failure of the delivery, and not one that anybody has to look
  // into at the account: the step had done nothing yet.
  expect(target).toMatchObject({ status: "sent", attempt: 1, error: null });
  expect(texted()).toEqual(["Second time lucky"]);
  expect(
    test.network.requests.filter((request) => request === postStatus),
  ).toHaveLength(1);
});

it("ends a delivery whose workflow stopped without a word, so that the next one can go", async () => {
  const context = await ready({}, "Dropped");
  const { workflows, workspace, client, channel } = context;
  const errors = expectErrors();
  // The workflow publishes, and then fails for good where it tells the
  // workspace how it ended: the one step that nothing else makes up for.
  await workflows.modifyAll(async (modifier) => {
    await modifier.mockStepError({ name: "end" }, new Error("Stopped"));
    await modifier.disableRetryDelays();
  });
  const [targetId = ""] = await publishTo(
    client,
    context.draft.postId,
    channel,
  );
  // The part is published and recorded, and that is the last that anybody
  // hears of the delivery.
  await follow(
    client,
    () => publishedOf(client, targetId, context.draft).length === 1,
  );
  const [run] = await workflows.get();
  await run?.waitForStatus("errored");
  // A second post waits behind the first, which is still `sending`.
  const next = await writeDraft(client, workspace, "Behind it");
  const [nextTarget = ""] = await publishTo(client, next.postId, channel);
  expect(client.unread).toBe(0);
  expect(targetOf(client, targetId).status).toBe("sending");
  expect(targetOf(client, nextTarget).status).toBe("queued");

  // The object looks after its deliveries every minute while one is under
  // way. The test does not wait for that.
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);

  // Nobody knows how far the first got, which is what its target says. It
  // had published, as it happens: its part is recorded.
  await ended(client, context.draft.postId);
  expect(targetOf(client, targetId)).toMatchObject({
    status: "uncertain",
    error: lostTrackMessage,
  });
  expect(publishedOf(client, targetId, context.draft)).toHaveLength(1);
  expect(errors).toHaveBeenCalledWith(
    `The workflow of the delivery ${await runIdOf(workspace, targetId)} ended without a word`,
  );
  // The account is free again: the second post is on its way.
  await follow(client, () => targetOf(client, nextTarget).status === "sending");
});
