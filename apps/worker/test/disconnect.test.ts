import { runInDurableObject } from "cloudflare:test";
import {
  disconnectResponseSchema,
  errorResponseSchema,
  type Fetch,
} from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  channelsOf,
  connectInSandbox,
  connectLive,
  disconnect,
  disconnected,
  type SandboxToken,
  storedAccess,
  worldEntries,
} from "./channels.ts";
import {
  adminEmail,
  expectErrors,
  expectWarnings,
  invite,
  setup,
  signedIn,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import { newId, objectOf, SyncClient, workspaceIds } from "./sync-client.ts";

const memberEmail = "member@example.com";

/** A signed-in admin and their workspaces. */
async function start(options: Parameters<typeof setup>[0] = {}) {
  const test = setup(options);
  const browser = await signedIn(test, { email: adminEmail });
  return { test, browser, workspaces: await workspaceIds(browser) };
}

/** `start()`, with a channel in the sandbox of the admin. */
async function connected() {
  const context = await start();
  const { channel } = await connectInSandbox(
    context.browser,
    context.workspaces.sandbox,
  );
  if (!channel) throw new Error("The account was not connected");
  return { ...context, channel };
}

/**
 * The tokens that the Mastodon server of the tests has given out for its
 * account.
 */
function accountTokens({ network }: Pick<TestSetup, "network">) {
  return network.world
    .tokens("mastodon")
    .filter(({ accountId }) => accountId !== null);
}

/** Which of those tokens are revoked, the ones that are good first. */
function revokedTokens(test: Pick<TestSetup, "network">): boolean[] {
  return accountTokens(test)
    .map(({ revoked }) => revoked)
    .sort();
}

/** Answers in place of the network when it is asked to take a token back. */
const failingRevocation = (network: Fetch): Fetch => {
  return async (input, init) =>
    urlOf(input).endsWith("/oauth/revoke")
      ? new Response("Service unavailable", { status: 503 })
      : network(input, init);
};

/**
 * The server of the tests, with a gate at its revocations. Once the gate
 * is armed, the next revocation stops there until `release` is called:
 * on its way to the server, or, with `answered`, on the way back, when
 * the server has taken the token back and pigy does not know yet.
 * `reached` settles when the request has got that far.
 */
function gatedRevocation(where: "on the way" | "answered") {
  let armed = false;
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
      if (!armed || !urlOf(input).endsWith("/oauth/revoke")) {
        return network(input, init);
      }
      armed = false;
      const answer = where === "answered" && (await network(input, init));
      reach();
      await released;
      return answer || network(input, init);
    };
  };
  return {
    interceptNetwork,
    arm() {
      armed = true;
    },
    reached,
    release: () => release(),
  };
}

it("removes the channel and gives its access back to the network", async () => {
  const { browser, workspaces, channel } = await connected();
  const client = new SyncClient();
  await client.connect(browser, workspaces.sandbox);

  const revoked = await disconnected(browser, workspaces.sandbox, channel);

  expect(revoked).toBe(true);
  // The clients that are connected hear of it at once.
  await client.patch();
  expect(client.table("channel")).toEqual([]);
  // The credentials went with the row.
  expect(await storedAccess(workspaces.sandbox)).toEqual([]);
  // The token that pigy had for the account is worth nothing any more. The
  // other token of the world is the one that pigy registered itself with.
  const tokens = await worldEntries<SandboxToken>(
    workspaces.sandbox,
    "token/mastodon/",
  );
  expect(tokens.filter(({ accountId }) => accountId !== null)).toMatchObject([
    { revoked: true },
  ]);
});

it("gives back the access of a real account through the fetch of the app", async () => {
  const { test, browser, workspaces } = await start();
  const { channel = "" } = await connectLive(test, browser, workspaces.live);

  const revoked = await disconnected(browser, workspaces.live, channel);

  expect(revoked).toBe(true);
  expect(await channelsOf(browser, workspaces.live)).toEqual([]);
  expect(
    test.network.world
      .tokens("mastodon")
      .filter(({ accountId }) => accountId !== null),
  ).toMatchObject([{ revoked: true }]);
});

it("removes a channel whose access the network does not take back", async () => {
  const { test, browser, workspaces } = await start({
    interceptNetwork: failingRevocation,
  });
  const warnings = expectWarnings();
  const { channel = "" } = await connectLive(test, browser, workspaces.live);

  const revoked = await disconnected(browser, workspaces.live, channel);

  // The answer says that the access may still stand, for the page to tell
  // the person. The channel is gone all the same: one that could only be
  // removed while its network answers could stay for ever.
  expect(revoked).toBe(false);
  expect(await channelsOf(browser, workspaces.live)).toEqual([]);
  expect(await storedAccess(workspaces.live)).toEqual([]);
  expect(warnings).toHaveBeenCalledExactlyOnceWith(
    "The access of a channel was not given back: mastodon.test is having trouble (HTTP 503).",
  );
  // The network was asked, and still has the token.
  expect(test.network.requests).toContain(
    "POST https://mastodon.test/oauth/revoke",
  );
  expect(
    test.network.world
      .tokens("mastodon")
      .filter(({ accountId }) => accountId !== null),
  ).toMatchObject([{ revoked: false }]);
});

it("gives the access back when nobody waits for the answer", async () => {
  const revocation = gatedRevocation("on the way");
  const { test, browser, workspaces } = await start(revocation);
  const { channel = "" } = await connectLive(test, browser, workspaces.live);
  revocation.arm();

  // Somebody who clicks and closes the tab: the channel is removed, the
  // request to take the token back is on its way, and nobody reads the
  // answer.
  const unread = disconnect(browser, workspaces.live, channel);
  await revocation.reached;
  expect(await storedAccess(workspaces.live)).toEqual([]);
  // The runtime ends what is left of such a request, except the work that
  // it was asked to keep going. So that work has to be there by now, and
  // it is all that this test waits for.
  const kept = [...test.keptAlive];
  expect(kept).toHaveLength(1);
  revocation.release();
  await Promise.all(kept);

  // It was the revocation, to its end: the token is worth nothing.
  expect(accountTokens(test)).toMatchObject([{ revoked: true }]);
  // Somebody who does wait is still told.
  const response = await unread;
  expect(disconnectResponseSchema.parse(await response.json())).toEqual({
    revoked: true,
  });
});

it.each([
  // What a database that was restored, or changed by hand, can hold.
  ["cannot be read", "'1.AAAAAAAAAAAAAAAA.AAAA'"],
  ["are not there", "null"],
])("removes a channel whose credentials %s", async (_name, value) => {
  const { browser, workspaces, channel } = await connected();
  expectWarnings();
  await runInDurableObject(objectOf(workspaces.sandbox), (_, state) => {
    state.storage.sql.exec(`update channel set credentials = ${value}`);
  });

  const revoked = await disconnected(browser, workspaces.sandbox, channel);

  expect(revoked).toBe(false);
  expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
});

it("answers a second disconnect of the same channel with not found", async () => {
  const { browser, workspaces, channel } = await connected();
  await disconnected(browser, workspaces.sandbox, channel);

  // Two tabs can disconnect the same channel.
  const response = await disconnect(browser, workspaces.sandbox, channel);

  expect(response.status).toBe(404);
  expect(errorResponseSchema.parse(await response.json())).toEqual({
    error: "NotFoundError",
    message: "There is no such channel",
  });
});

it.each([
  ["a channel that does not exist", newId()],
  ["an ID that is not one", "1"],
  // SQL in place of an ID, as text in the path.
  ["an ID that is not one", "x' or '1'='1"],
])("answers the disconnect of %s with not found", async (_name, id) => {
  const { browser, workspaces } = await connected();

  const response = await disconnect(
    browser,
    workspaces.sandbox,
    encodeURIComponent(id),
  );

  expect(response.status).toBe(404);
  expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
});

it("leaves the channels of other people alone", async () => {
  const { test, browser, workspaces, channel } = await connected();
  await invite(test, memberEmail);
  const member = await signedIn(test, { email: memberEmail });
  const ofMember = await workspaceIds(member);

  // The channel of the admin, asked for in the admin's workspace and in
  // the member's own.
  const foreign = await disconnect(member, workspaces.sandbox, channel);
  const own = await disconnect(member, ofMember.sandbox, channel);

  // The same answer as for a workspace that does not exist.
  expect(foreign.status).toBe(404);
  expect(errorResponseSchema.parse(await foreign.json()).message).toBe(
    "There is no such workspace",
  );
  expect(own.status).toBe(404);
  expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
});

it.each([
  ["no Origin", null],
  ["the Origin of another site", "https://evil.example"],
])("disconnects nothing for a request with %s", async (_name, origin) => {
  const { browser, workspaces, channel } = await connected();

  // With the session of the admin: the cookie is what a browser adds to a
  // request that another site makes.
  const response = await browser.fetch(
    `/api/workspaces/${workspaces.sandbox}/channels/${channel}`,
    { method: "DELETE", headers: { Origin: origin } },
  );

  expect(response.status).toBe(403);
  expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
});

it("disconnects nothing for somebody who is not signed in", async () => {
  const { test, browser, workspaces, channel } = await connected();

  const response = await disconnect(
    test.browser(),
    workspaces.sandbox,
    channel,
  );

  expect(response.status).toBe(401);
  expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
});

it("leaves the channel with its access when the workspace fails to remove it", async () => {
  const { test, browser, workspaces } = await start();
  const { channel = "" } = await connectLive(test, browser, workspaces.live);
  const errors = expectErrors();
  // The database of the workspace refuses the deletion.
  await runInDurableObject(objectOf(workspaces.live), (_, state) => {
    state.storage.sql.exec(
      `create trigger keep before delete on channel
       begin select raise(abort, 'kept'); end`,
    );
  });

  const response = await disconnect(browser, workspaces.live, channel);

  // An error, not a success that leaves the channel in the list.
  expect(response.status).toBe(500);
  expect(errors).toHaveBeenCalled();
  expect(await channelsOf(browser, workspaces.live)).toMatchObject([
    { id: channel, status: "connected" },
  ]);
  // The channel that stays is one that works: the network was not asked to
  // take anything back, and the token is as good as before.
  expect(test.network.requests).not.toContain(
    "POST https://mastodon.test/oauth/revoke",
  );
  expect(accountTokens(test)).toMatchObject([{ revoked: false }]);
});

describe("an account that is connected again while it is disconnected", () => {
  it("keeps the new channel and its access, and gives back the one it had", async () => {
    const revocation = gatedRevocation("answered");
    const { test, browser, workspaces } = await start(revocation);
    const first = await connectLive(test, browser, workspaces.live);
    revocation.arm();

    const disconnecting = disconnected(
      browser,
      workspaces.live,
      first.channel ?? "",
    );
    await revocation.reached;
    // Meanwhile, in another tab. The server has no token for the account
    // any more, so this connection gets a new one.
    const second = await connectLive(test, browser, workspaces.live);
    revocation.release();

    expect(await disconnecting).toBe(true);
    // The channel of the second connection is not the one that was
    // removed, and the disconnect has left it alone.
    expect(second.channel).not.toBe(first.channel);
    expect(await channelsOf(browser, workspaces.live)).toMatchObject([
      { id: second.channel, status: "connected" },
    ]);
    expect(revokedTokens(test)).toEqual([false, true]);
    // The token that is still good is the one of that channel: pigy has
    // not lost track of an access that it was given. Disconnecting the
    // channel gives it back.
    expect(
      await disconnected(browser, workspaces.live, second.channel ?? ""),
    ).toBe(true);
    expect(revokedTokens(test)).toEqual([true, true]);
  });

  it("cannot tell when Mastodon gives the new connection the token that is being given back", async () => {
    const revocation = gatedRevocation("on the way");
    const { test, browser, workspaces } = await start(revocation);
    const first = await connectLive(test, browser, workspaces.live);
    revocation.arm();

    const disconnecting = disconnected(
      browser,
      workspaces.live,
      first.channel ?? "",
    );
    await revocation.reached;
    // The server still has the token of the account, and gives it to this
    // connection as well.
    const second = await connectLive(test, browser, workspaces.live);
    revocation.release();

    // The case that the route says it does not cover. The channel of the
    // second connection is left alone, and says that it is connected, with
    // the one token that the account ever had, which is gone. It turns out
    // to need connecting again when it is next used.
    expect(await disconnecting).toBe(true);
    expect(await channelsOf(browser, workspaces.live)).toMatchObject([
      { id: second.channel, status: "connected" },
    ]);
    expect(revokedTokens(test)).toEqual([true]);
  });
});
