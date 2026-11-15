import { env } from "cloudflare:workers";
import { errorResponseSchema, syncCloseCodes } from "@pigy/core";
import { expect, it } from "vitest";
import { maxSockets, socketLifetimeMs } from "../src/workspace/object.ts";
import {
  connectWorkspace,
  mutateWorkspace,
} from "../src/workspace/workspaces.ts";
import { adminEmail, invite, setup, signedIn } from "./helpers.ts";
import { identityOf, newId, SyncClient, workspaceIds } from "./sync-client.ts";

const memberEmail = "member@example.com";
const dayMs = 24 * 60 * 60 * 1000;

/** The admin and a member, both signed in, and their workspaces. */
async function start() {
  const test = setup();
  await invite(test, memberEmail);
  const admin = await signedIn(test, { email: adminEmail });
  const member = await signedIn(test, { email: memberEmail });
  return {
    test,
    admin,
    member,
    ofAdmin: await workspaceIds(admin),
    ofMember: await workspaceIds(member),
  };
}

function newPost(text: string) {
  return { id: newId(), partId: newId(), text };
}

it("refuses a socket without a session", async () => {
  const { test, ofAdmin } = await start();

  const response = await test.browser().webSocket(`/sync/${ofAdmin.live}`);

  expect(response.status).toBe(401);
  expect(response.webSocket).toBeNull();
});

it.each([
  ["no Origin", null],
  ["the Origin of another site", "https://evil.example"],
  // What a sandboxed frame sends.
  ["an opaque Origin", "null"],
  ["the Origin of pigy over plain HTTP", "http://pigy.test"],
  ["the Origin of a subdomain", "https://sync.pigy.test"],
])("refuses a socket with %s", async (_name, origin) => {
  const { admin, ofAdmin } = await start();

  // With the session of the admin: the cookie is exactly what a browser
  // adds to a handshake that another site starts.
  const response = await admin.webSocket(`/sync/${ofAdmin.live}`, {
    Origin: origin,
  });

  expect(response.status).toBe(403);
  expect(response.webSocket).toBeNull();
  expect(errorResponseSchema.parse(await response.json()).error).toBe(
    "UnauthorizedError",
  );
});

it("refuses a request that is not a WebSocket handshake", async () => {
  const { admin, ofAdmin } = await start();

  const response = await admin.fetch(`/sync/${ofAdmin.live}`);

  expect(response.status).toBe(426);
});

it("answers for the workspace of somebody else as for one that does not exist", async () => {
  const { member, ofAdmin } = await start();

  const foreign = await member.webSocket(`/sync/${ofAdmin.live}`);
  const unknown = await member.webSocket(`/sync/${crypto.randomUUID()}`);

  expect(foreign.status).toBe(404);
  expect(foreign.webSocket).toBeNull();
  // The same answer, so that nobody learns which IDs exist.
  expect(unknown.status).toBe(404);
  expect(await foreign.json()).toEqual(await unknown.json());
});

it("keeps the workspaces of two people apart", async () => {
  const { admin, member, ofAdmin, ofMember } = await start();
  const ofAdminClient = new SyncClient();
  await ofAdminClient.connect(admin, ofAdmin.live);
  const ofMemberClient = new SyncClient();
  await ofMemberClient.connect(member, ofMember.live);

  ofAdminClient.mutate("post.create", newPost("The admin's"));
  await ofAdminClient.patch();
  ofMemberClient.mutate("post.create", newPost("The member's"));
  const patch = await ofMemberClient.patch();

  // The first thing the member receives is their own change, at the start
  // of their own sequence: the admin's change went to the admin alone.
  expect(patch).toMatchObject({ from: 0, to: 1 });
  expect(ofMemberClient.table("post_part").map(({ text }) => text)).toEqual([
    "The member's",
  ]);
  expect(ofAdminClient.table("post_part").map(({ text }) => text)).toEqual([
    "The admin's",
  ]);
  expect(ofAdminClient.unread).toBe(0);
});

it("keeps the live and the sandbox workspace of one person apart", async () => {
  const { admin, ofAdmin } = await start();
  const live = new SyncClient();
  await live.connect(admin, ofAdmin.live);
  const sandbox = new SyncClient();
  await sandbox.connect(admin, ofAdmin.sandbox);

  live.mutate("post.create", newPost("For real"));
  await live.patch();
  sandbox.mutate("post.create", newPost("Just trying"));
  const patch = await sandbox.patch();

  expect(patch).toMatchObject({ from: 0, to: 1 });
  expect(sandbox.table("post_part").map(({ text }) => text)).toEqual([
    "Just trying",
  ]);
  expect(live.table("post_part").map(({ text }) => text)).toEqual(["For real"]);
  // Also for a client that starts from nothing.
  const fresh = new SyncClient();
  await fresh.connect(admin, ofAdmin.sandbox);
  expect(fresh.copy).toEqual(sandbox.copy);
});

it("lets nothing in the request of a client choose the workspace", async () => {
  const { test, admin, member, ofAdmin, ofMember } = await start();
  const ofAdminClient = new SyncClient();
  await ofAdminClient.connect(admin, ofAdmin.live);
  ofAdminClient.mutate("post.create", newPost("The admin's"));
  await ofAdminClient.patch();
  const { id, ownerId, environment } = await identityOf(test, ofAdmin.live);

  // The Worker names the workspace to the object in the query of a request.
  // The member puts the admin's workspace into the query of their own.
  const query = new URLSearchParams({ id, ownerId, environment });
  const client = new SyncClient();
  const snapshot = await client.connect(member, `${ofMember.live}?${query}`);

  // The object never sees the request of a client: the Worker makes a new
  // one. The member gets their own workspace, which is empty.
  expect(snapshot).toMatchObject({ from: null, to: 0, changes: [] });
});

it("has the object of a workspace refuse to serve another", async () => {
  const { test, admin, ofAdmin, ofMember } = await start();
  const client = new SyncClient();
  await client.connect(admin, ofAdmin.live);
  const own = await identityOf(test, ofAdmin.live);
  const other = await identityOf(test, ofMember.live);
  const object = env.WORKSPACE.getByName(own.id);

  // What a mistake in the Worker would look like: the object of the admin's
  // workspace is reached on behalf of somebody else, or as another
  // workspace. It remembers which workspace it holds.
  for (const identity of [
    { ...own, ownerId: other.ownerId },
    { ...own, id: other.id },
    { ...own, environment: "sandbox" as const },
  ]) {
    const outcome = await object.mutate(
      identity,
      "post.create",
      newPost("Not mine"),
    );
    expect(outcome).toBeUndefined();
  }
  const asOther = { ...own, ownerId: other.ownerId };
  // The same on the way that a socket takes.
  const response = await connectWorkspace(env.WORKSPACE, asOther);
  expect(response.status).toBe(403);
  expect(response.webSocket).toBeNull();
  // Worker code does not get past it unnoticed.
  await expect(
    mutateWorkspace(env.WORKSPACE, asOther, "post.create", newPost("Not mine")),
  ).rejects.toThrow("holds another workspace");

  // Nothing came of it, and the owner is served as before.
  expect(
    await mutateWorkspace(env.WORKSPACE, own, "post.create", newPost("Mine")),
  ).toEqual({ ok: true });
  await client.patch();
  expect(client.table("post_part").map(({ text }) => text)).toEqual(["Mine"]);
});

it("closes the socket of somebody who signed out, at the end of its life", async () => {
  const { test, admin, ofAdmin } = await start();
  const client = new SyncClient();
  await client.connect(admin, ofAdmin.live);
  const signOut = await admin.fetch("/api/auth/sign-out", { method: "POST" });
  expect(signOut.status).toBe(204);

  // The session is only checked when a socket is opened. Until the socket
  // has reached the end of its life, it works as before.
  test.advance(socketLifetimeMs - 1);
  client.mutate("post.create", newPost("Just in time"));
  expect(await client.patch()).toMatchObject({ lastMutationId: 1 });

  test.advance(1);
  // Two, the second on its way before the server has closed the socket.
  client.mutate("post.create", newPost("Too late"));
  client.mutate("post.create", newPost("Later still"));

  expect(await client.closed).toMatchObject({ code: syncCloseCodes.reconnect });
  // The client does what the code tells it to, and learns that it is
  // signed out.
  const again = await admin.webSocket(`/sync/${ofAdmin.live}`);
  expect(again.status).toBe(401);
  // The mutations that came too late were not run.
  const signedInAgain = await signedIn(test, { email: adminEmail });
  const fresh = new SyncClient();
  await fresh.connect(signedInAgain, ofAdmin.live);
  expect(fresh.table("post_part").map(({ text }) => text)).toEqual([
    "Just in time",
  ]);
});

it("stops sending changes to somebody who lost their invitation, at the end of the socket's life", async () => {
  const { test, admin, member, ofMember } = await start();
  const client = new SyncClient();
  await client.connect(member, ofMember.live);
  const identity = await identityOf(test, ofMember.live);
  const removed = await admin.fetch(
    `/api/admin/allowed-emails/${encodeURIComponent(memberEmail)}`,
    { method: "DELETE" },
  );
  expect(removed.status).toBe(204);

  test.advance(socketLifetimeMs);
  // A change that does not come from the member, as when a scheduled post
  // goes out.
  await mutateWorkspace(
    env.WORKSPACE,
    identity,
    "post.create",
    newPost("Sent"),
  );

  // The socket is closed instead of being sent the change.
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.reconnect });
  expect(client.unread).toBe(0);
  const again = await member.webSocket(`/sync/${ofMember.live}`);
  expect(again.status).toBe(401);
});

it("lets somebody who is still signed in carry on after the end of a socket's life", async () => {
  const { test, admin, ofAdmin } = await start();
  const client = new SyncClient();
  await client.connect(admin, ofAdmin.live);
  test.advance(socketLifetimeMs);

  const create = client.mutate("post.create", newPost("Hello"));
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.reconnect });
  // Connecting again is all it takes. The mutation was not processed, the
  // hello says so, and the client sends it again.
  const hello = await client.connect(admin, ofAdmin.live);
  expect(hello).toMatchObject({ from: 0, to: 0, lastMutationId: 0 });
  client.send({ type: "mutate", mutations: [create] });

  expect(await client.patch()).toMatchObject({ to: 1, lastMutationId: 1 });
  expect(client.table("post")).toHaveLength(1);
});

it("renews the session cookie on a handshake that renewed the session", async () => {
  const { test, admin, ofAdmin } = await start();
  // Long enough for the next request to move the expiry of the session.
  test.advance(2 * dayMs);

  const response = await admin.webSocket(`/sync/${ofAdmin.live}`);

  // An installed app may make no other request for weeks. If the cookie
  // were not renewed here, it would run out before the session does.
  expect(response.status).toBe(101);
  expect(admin.lastSetCookies).toHaveLength(1);
  expect(admin.lastSetCookies[0]).toMatch(
    /^__Host-pigy_session=.*Max-Age=2592000/,
  );
});

it("limits how many sockets a workspace has open", async () => {
  const { test, admin, ofAdmin } = await start();
  const clients = [];
  for (let i = 0; i < maxSockets; i++) {
    const client = new SyncClient();
    await client.open(admin, ofAdmin.live);
    clients.push(client);
  }

  const response = await admin.webSocket(`/sync/${ofAdmin.live}`);

  expect(response.status).toBe(429);
  expect(errorResponseSchema.parse(await response.json()).error).toBe(
    "LimitReachedError",
  );
  // Sockets that are past the end of their life make room: they are closed
  // when somebody else needs their place.
  test.advance(socketLifetimeMs);
  const next = new SyncClient();
  expect(await next.connect(admin, ofAdmin.live)).toMatchObject({ to: 0 });
  for (const client of clients) {
    expect(await client.closed).toMatchObject({
      code: syncCloseCodes.reconnect,
    });
  }
});
