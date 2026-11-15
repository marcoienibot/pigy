import { runInDurableObject } from "cloudflare:test";
import { errorResponseSchema, type Fetch } from "@pigy/core";
import { expect, it } from "vitest";
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

/** Answers in place of the network when it is asked to take a token back. */
const failingRevocation = (network: Fetch): Fetch => {
  return async (input, init) =>
    urlOf(input).endsWith("/oauth/revoke")
      ? new Response("Service unavailable", { status: 503 })
      : network(input, init);
};

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

it("keeps the channel when the workspace fails to remove it", async () => {
  const { browser, workspaces, channel } = await connected();
  const errors = expectErrors();
  // The database of the workspace refuses the deletion.
  await runInDurableObject(objectOf(workspaces.sandbox), (_, state) => {
    state.storage.sql.exec(
      `create trigger keep before delete on channel
       begin select raise(abort, 'kept'); end`,
    );
  });

  const response = await disconnect(browser, workspaces.sandbox, channel);

  // An error, not a success that leaves the channel in the list.
  expect(response.status).toBe(500);
  expect(errors).toHaveBeenCalled();
  expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
});
