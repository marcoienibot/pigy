import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { haltedMessage, syncCloseCodes } from "@pigy/core";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  allowedEmails,
  workspaces as workspaceTable,
} from "../src/db/schema.ts";
import { connectBlueskyLive, connectThreadsLive } from "./channels.ts";
import {
  adminEmail,
  type Browser,
  breakDatabase,
  entriesOf,
  expectWarnings,
  invite,
  locationOf,
  me,
  overtake,
  signedIn,
  signIn,
  type TestSetup,
} from "./helpers.ts";
import {
  ended,
  gate,
  patience,
  publishTo,
  retry,
  started,
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
 * The workspaces of a person who has lost their access to pigy are
 * frozen, where their sessions end and their API keys are revoked: no
 * access is renewed and no scheduled post is taken up, until they sign in
 * again. `endAccessOf` of src/auth/session.ts, and `frozenAt` of
 * the store of a workspace.
 */

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;

const member = { email: "member@example.com", sub: "1001" };
const threadsRefresh = "GET https://graph.threads.net/refresh_access_token";
const threadsPublish = "POST https://graph.threads.net/v1.0/me/threads_publish";
const blueskyToken = "POST https://bsky.social/oauth/token";

/** How often the app has made `request` of a network, whatever its query. */
const asked = ({ network }: TestSetup, request: string) =>
  network.requests.filter((made) => made.replace(/\?.*$/, "") === request)
    .length;

/** Since when D1 says that a workspace is frozen. */
const frozenInD1 = async (test: TestSetup, workspaceId: string) => {
  const [row] = await test.db
    .select({ frozenAt: workspaceTable.frozenAt })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId));
  return row?.frozenAt?.getTime() ?? null;
};

/** Since when the object of a workspace holds itself for frozen. */
const frozenInObject = (workspaceId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ frozen_at: number | null }>("select frozen_at from workspace")
      .one(),
  ).then(({ frozen_at }) => frozen_at);

/** Freezes a workspace in D1 alone: the word of it to its object is lost. */
const freezeInD1 = (test: TestSetup, workspaceId: string) =>
  test.db
    .update(workspaceTable)
    .set({ frozenAt: test.clock.time })
    .where(eq(workspaceTable.id, workspaceId));

/** A target of a workspace, as its object has it. */
const targetIn = (workspaceId: string, targetId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ status: string; error: string | null }>(
        "select status, error from post_target where id = ?",
        targetId,
      )
      .one(),
  );

/** A post of a workspace, as its object has it. */
const postIn = (workspaceId: string, postId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ status: string; held_at: number | null }>(
        "select status, held_at from post where id = ?",
        postId,
      )
      .one(),
  );

/** The notifications of a workspace, as its object has them. */
const inboxOf = (workspaceId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ id: string; kind: string }>("select id, kind from notification")
      .toArray(),
  );

/** Has the object of a workspace look after it now, as its alarm does. */
const look = async (workspaceId: string) => {
  expect(await runDurableObjectAlarm(objectOf(workspaceId))).toBe(true);
};

/** In how many milliseconds the object of a workspace looks next, or null. */
const nextLookIn = async (workspaceId: string) => {
  const alarm = await runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.getAlarm(),
  );
  return alarm === null ? null : alarm - Date.now();
};

/**
 * A member who is invited, with a Threads account connected to their live
 * workspace, whose access the timer renews a week after it was issued,
 * and a post scheduled for two days from now.
 */
async function memberWithChannel(options: Parameters<typeof started>[0] = {}) {
  const context = await started(options);
  const { test } = context;
  await invite(test, member.email);
  const browser = await signedIn(test, member);
  const workspaces = await workspaceIds(browser);
  const outcome = await connectThreadsLive(test, browser, workspaces.live);
  expect(outcome.connect).toBe("connected");
  await Promise.all(test.keptAlive);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const [channel] = client.table("channel");
  if (!channel) throw new Error("The workspace has no channel");
  const draft = await writeDraft(client, workspaces.live, "Later");
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: newId(),
        postId: draft.postId,
        channelId: channel.id,
      }),
      client.mutation("post.schedule", {
        id: draft.postId,
        dueAt: test.clock.time.getTime() + 2 * day,
      }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);
  return {
    ...context,
    member: browser,
    memberWorkspaces: workspaces,
    client,
    channelId: channel.id,
    postId: draft.postId,
  };
}

/** Removes `email` from the allowlist as the admin does, and waits for it. */
async function remove(test: TestSetup, admin: Browser, email: string) {
  const response = await admin.fetch(`/api/admin/allowed-emails/${email}`, {
    method: "DELETE",
  });
  expect(response.status).toBe(204);
  // The objects are told through `waitUntil`, after the answer.
  await Promise.all(test.keptAlive);
}

it("freezes the workspaces of a person who is removed: the timer renews no access and takes up no scheduled post", async () => {
  const {
    test,
    browser,
    member: removed,
    memberWorkspaces,
    postId,
  } = await memberWithChannel();
  const removedAt = test.clock.time.getTime();

  await remove(test, browser, member.email);

  expect(await me(removed)).toBeNull();
  for (const id of [memberWorkspaces.live, memberWorkspaces.sandbox]) {
    expect(await frozenInD1(test, id)).toBe(removedAt);
    expect(await frozenInObject(id)).toBe(removedAt);
  }

  // The time of the post and of the renewal come, and the alarm runs, as
  // the one that was set for the post before the freeze does.
  test.advance(week);
  await look(memberWorkspaces.live);

  expect(asked(test, threadsRefresh)).toBe(0);
  expect(asked(test, threadsPublish)).toBe(0);
  expect(await postIn(memberWorkspaces.live, postId)).toEqual({
    status: "scheduled",
    held_at: null,
  });
  // The alarm does not come back for either: what is left for it is the
  // reminder of the inbox, a week before the access of 60 days ends, which
  // nothing renews now. Without the freeze it would come back in a minute
  // for the post that it did not take up, and every minute after that.
  expect(await nextLookIn(memberWorkspaces.live)).toBeGreaterThan(40 * day);
});

it("thaws them when the person signs in again, not when they are invited again, and holds the post that came due meanwhile and says so in the inbox", async () => {
  const { test, browser, memberWorkspaces, postId } = await memberWithChannel();
  await remove(test, browser, member.email);
  // Past the time of the post, and past the time to renew the access.
  test.advance(week + day);

  // An invitation says nothing about who has the address by now: the
  // account that was stored with it may have lost it.
  const invited = await browser.fetch("/api/admin/allowed-emails", {
    method: "POST",
    json: { email: member.email, role: "member" },
  });
  expect(invited.status).toBe(204);
  expect(await frozenInD1(test, memberWorkspaces.live)).not.toBeNull();

  const back = await signedIn(test, member);
  await Promise.all(test.keptAlive);
  expect(await frozenInD1(test, memberWorkspaces.live)).toBeNull();
  expect(await frozenInObject(memberWorkspaces.live)).toBeNull();
  // The object has its alarm for what it left undone, at once.
  expect(await nextLookIn(memberWorkspaces.live)).toBeLessThan(60 * 1000);

  await look(memberWorkspaces.live);

  // Days late, which is more than the hour that a post may be late: it
  // is held, as a post is that the server found late, and the person is
  // told in the inbox. Nothing went out.
  expect(await postIn(memberWorkspaces.live, postId)).toMatchObject({
    status: "scheduled",
    held_at: test.clock.time.getTime(),
  });
  expect(await inboxOf(memberWorkspaces.live)).toContainEqual({
    id: postId,
    kind: "post_held",
  });
  expect(asked(test, threadsPublish)).toBe(0);
  // The access is renewed: it was due, and it is still good.
  expect(asked(test, threadsRefresh)).toBe(1);
  // And the person can use their workspace again.
  const client = new SyncClient();
  await client.connect(back, memberWorkspaces.live);
  expect(client.table("post")).toContainEqual(
    expect.objectContaining({ id: postId, status: "scheduled" }),
  );
});

it("leaves the workspaces frozen when the address is removed while a sign-in is on its way, after it found the address invited", async () => {
  const { test, browser } = await started();
  await invite(test, member.email);
  const { live, sandbox } = await workspaceIds(await signedIn(test, member));

  // The sign-in looks at the allowlist first and finds the address there.
  // The admin removes it before the sign-in stores the account, which is
  // the statement after that one, and so before it thaws anything.
  const removal = overtake(
    (sql) => sql.startsWith('insert into "user"'),
    () => remove(test, browser, member.email),
  );
  const late = test.browser();
  expect(locationOf(await signIn(test, late, member))).toBe("/");
  expect(removal()).toBeDefined();
  await Promise.all(test.keptAlive);

  // The thaw found no invitation: the removal stands. Thawed, the
  // workspaces of somebody who is not invited would renew and publish,
  // and nothing would freeze them again.
  for (const id of [live, sandbox]) {
    expect(await frozenInD1(test, id)).not.toBeNull();
    expect(await frozenInObject(id)).not.toBeNull();
  }
  // The session that the sign-in made lets nobody in either.
  expect(await me(late)).toBeNull();
});

it("finds the freeze in D1 when the word of it was lost, before it renews an access", async () => {
  const { test, memberWorkspaces } = await memberWithChannel();
  const removedAt = test.clock.time;
  // What the admin route writes, without the word to the object, which
  // the runtime can fail to deliver.
  await test.db
    .update(workspaceTable)
    .set({ frozenAt: removedAt })
    .where(eq(workspaceTable.id, memberWorkspaces.live));
  expect(await frozenInObject(memberWorkspaces.live)).toBeNull();

  test.advance(week);
  await look(memberWorkspaces.live);

  expect(asked(test, threadsRefresh)).toBe(0);
  expect(await frozenInObject(memberWorkspaces.live)).toBe(removedAt.getTime());
});

it("finds the thaw in D1 when the word of it was lost, when its owner opens it", async () => {
  const { member: browser, memberWorkspaces } = await memberWithChannel();
  const live = memberWorkspaces.live;
  // A workspace that its object holds for frozen while D1 does not: the
  // word of the thaw at a sign-in was lost.
  await runInDurableObject(objectOf(live), (_, state) => {
    state.storage.sql.exec("update workspace set frozen_at = 1");
  });

  const client = new SyncClient();
  await client.connect(browser, live);

  // The object read D1 before it opened the socket.
  expect(await frozenInObject(live)).toBeNull();
});

it("goes on as it was when D1 cannot be read, and says so", async () => {
  const { test, memberWorkspaces } = await memberWithChannel();
  const warnings = expectWarnings();
  // The question of the object, and nothing else.
  breakDatabase(
    (sql) => sql.startsWith("select") && sql.includes('"frozen_at"'),
  );

  test.advance(week);
  await look(memberWorkspaces.live);

  // Not frozen, so the access was renewed as it would have been.
  expect(asked(test, threadsRefresh)).toBe(1);
  expect(entriesOf(warnings)).toContainEqual(
    expect.objectContaining({
      level: "warn",
      kind: "access",
      workspaceId: memberWorkspaces.live,
    }),
  );
});

it("closes the sockets of a workspace that is frozen", async () => {
  const { test, browser, client } = await memberWithChannel();

  await remove(test, browser, member.email);

  // The client connects again, and is turned away there: its session
  // ended with the invitation. Without this the socket would be served
  // for minutes more.
  expect(await client.closed).toMatchObject({
    code: syncCloseCodes.reconnect,
  });
});

it("lets a delivery that is under way at the freeze go to its end, and ends the ones that wait their turn, which the person tries again once they are back", async () => {
  const held = gate((request) => request.startsWith(threadsPublish));
  const { test, browser, client, channelId, memberWorkspaces } =
    await memberWithChannel({ interceptNetwork: held.intercept });
  const live = memberWorkspaces.live;
  held.close();
  const first = await writeDraft(client, "", "Now");
  const [underWay = ""] = await publishTo(client, first.postId, channelId);
  await held.reached();
  // A second post to the same account waits its turn behind the first.
  const second = await writeDraft(client, "", "Next");
  const [waiting = ""] = await publishTo(client, second.postId, channelId);

  await remove(test, browser, member.email);
  // Ended at the freeze, before the first has: nothing goes out for
  // somebody who is no longer let in, also not what they asked for
  // before. Without that it would go out once the first has ended, and
  // so would hundreds of posts behind it.
  expect(await targetIn(live, waiting)).toEqual({
    status: "error",
    error: haltedMessage,
  });
  held.open();

  // The socket of the client was closed with the freeze, and the person
  // cannot open another: the test looks into the object instead.
  await expect
    .poll(() => targetIn(live, underWay), patience)
    .toMatchObject({ status: "sent" });
  expect(asked(test, threadsPublish)).toBe(1);
  // It ended badly by itself, which the inbox tells of as of every post
  // that failed.
  expect(await inboxOf(live)).toContainEqual({
    id: second.postId,
    kind: "post_failed",
  });

  // The person is invited again, signs in, and tries it again.
  await invite(test, member.email);
  const back = await signedIn(test, member);
  await Promise.all(test.keptAlive);
  const again = new SyncClient();
  await again.connect(back, live);
  await retry(again, waiting);
  await ended(again, second.postId);
  expect(await targetIn(live, waiting)).toMatchObject({ status: "sent" });
  expect(asked(test, threadsPublish)).toBe(2);
});

it("begins no delivery that waits and takes up no post that has come due when a delivery reports after a freeze that the object was not told of", async () => {
  const held = gate((request) => request.startsWith(threadsPublish));
  const { test, client, channelId, memberWorkspaces } = await memberWithChannel(
    { interceptNetwork: held.intercept },
  );
  const live = memberWorkspaces.live;
  const later = await writeDraft(client, "", "In a minute");
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: newId(),
        postId: later.postId,
        channelId,
      }),
      client.mutation("post.schedule", {
        id: later.postId,
        dueAt: test.clock.time.getTime() + minute,
      }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);
  held.close();
  const draft = await writeDraft(client, "", "Now");
  const [underWay = ""] = await publishTo(client, draft.postId, channelId);
  await held.reached();

  await freezeInD1(test, live);
  // The post comes due, on time, while the delivery waits for its
  // network.
  test.advance(2 * minute);
  held.open();

  // The delivery reports what it published, and ends: each report is a
  // mutation, which takes up the posts that are due, and the object asks
  // D1 first. Without that, the post would go out a moment later.
  await expect
    .poll(() => targetIn(live, underWay), patience)
    .toMatchObject({ status: "sent" });
  expect(await postIn(live, later.postId)).toEqual({
    status: "scheduled",
    held_at: null,
  });
  expect(await frozenInObject(live)).not.toBeNull();
  await look(live);
  expect(await postIn(live, later.postId)).toEqual({
    status: "scheduled",
    held_at: null,
  });
  expect(asked(test, threadsPublish)).toBe(1);
});

it("renews no further access once the workspace is frozen in the middle of renewing, also where the object was not told", async () => {
  const held = gate(
    (request) => request.startsWith(threadsRefresh) || request === blueskyToken,
  );
  const {
    test,
    member: browser,
    memberWorkspaces,
  } = await memberWithChannel({ interceptNetwork: held.intercept });
  const live = memberWorkspaces.live;
  expect((await connectBlueskyLive(test, browser, live)).connect).toBe(
    "connected",
  );
  await Promise.all(test.keptAlive);
  // Both accesses are due, a week after they were issued.
  test.advance(week + day);
  // A refresh of Bluesky can take two requests, for a nonce: what counts
  // is which networks were asked.
  const before = [threadsRefresh, blueskyToken].map((request) =>
    asked(test, request),
  );
  held.close();

  const alarm = look(live);
  // The first renewal waits for its network, and the access of the
  // person ends meanwhile.
  await held.reached();
  await freezeInD1(test, live);
  held.open();
  await alarm;

  // The one that was under way went to its end. The other was not begun:
  // the object read D1 before it.
  const renewed = [threadsRefresh, blueskyToken].filter(
    (request, index) => asked(test, request) > (before[index] ?? 0),
  );
  expect(renewed).toHaveLength(1);
  expect(await frozenInObject(live)).not.toBeNull();
});

it("opens no socket for a session that was found good before the workspace was frozen", async () => {
  const { test, member: browser, memberWorkspaces } = await memberWithChannel();
  const live = memberWorkspaces.live;
  // The access ends after the Worker has found the session good, and the
  // object has closed its sockets before this one is there: the session
  // is still in D1 here, which is how the Worker lets the handshake pass.
  await freezeInD1(test, live);

  const response = await browser.webSocket(`/sync/${live}`);

  // The object read D1 before it opened a socket.
  expect(response.status).toBe(403);
  expect(await frozenInObject(live)).not.toBeNull();
});

it("refuses every change of a client while it holds the workspace for frozen", async () => {
  const { client, channelId, memberWorkspaces } = await memberWithChannel();
  const draft = await writeDraft(client, "", "Now");
  // A socket that is open all the same: the object closes every socket
  // where it finds the workspace frozen, so the test freezes it alone.
  await runInDurableObject(objectOf(memberWorkspaces.live), (_, state) => {
    state.storage.sql.exec("update workspace set frozen_at = 1");
  });

  const add = client.mutation("target.add", {
    id: newId(),
    postId: draft.postId,
    channelId,
  });
  const publish = client.mutation("post.publish", { id: draft.postId });
  client.send({ type: "mutate", mutations: [add, publish] });
  const { rejected } = await client.patch();

  expect(rejected).toEqual([
    { id: add.id, code: "frozen", message: expect.any(String) },
    { id: publish.id, code: "frozen", message: expect.any(String) },
  ]);
});

it("goes by the read of D1 that began last, whichever answers last", async () => {
  const { test, memberWorkspaces } = await memberWithChannel();
  const live = memberWorkspaces.live;
  const workspace = await identityOf(test, live);
  await freezeInD1(test, live);
  await objectOf(live).reviewFreeze(workspace);
  expect(await frozenInObject(live)).not.toBeNull();

  // A read finds the workspace frozen, and its answer is slow. Meanwhile
  // the person signs in again, which thaws the workspace in D1, and the
  // Worker has the object read again, which finds it thawed.
  overtake(
    (sql) => sql.startsWith("select") && sql.includes('"frozen_at"'),
    async () => {
      await test.db
        .update(workspaceTable)
        .set({ frozenAt: null })
        .where(eq(workspaceTable.id, live));
      expect(await objectOf(live).reviewFreeze(workspace)).toBe(false);
    },
    { late: true },
  );
  const slow = await objectOf(live).reviewFreeze(workspace);

  // The older answer came last, and the object did not go by it.
  expect(slow).toBe(false);
  expect(await frozenInObject(live)).toBeNull();
});

it("freezes the workspaces of an account that Google reports with another address, and of one whose address another account has taken over", async () => {
  const { test } = await started();
  await invite(test, member.email);
  const renamed = await signedIn(test, member);
  const renamedWorkspaces = await workspaceIds(renamed);
  await invite(test, "other@example.com");
  const taken = await signedIn(test, {
    email: "other@example.com",
    sub: "3003",
  });
  const takenWorkspaces = await workspaceIds(taken);

  // The first account is stored with an address that it no longer has:
  // its sign-in is refused, and its keys would be revoked.
  const refused = await signIn(test, test.browser(), {
    email: "renamed@example.com",
    sub: member.sub,
  });
  expect(locationOf(refused)).toBe("/invite-only");
  // The address of the second is given to somebody new, who signs in.
  await signedIn(test, { email: "other@example.com", sub: "4004" });
  await Promise.all(test.keptAlive);

  for (const id of [
    renamedWorkspaces.live,
    renamedWorkspaces.sandbox,
    takenWorkspaces.live,
    takenWorkspaces.sandbox,
  ]) {
    expect(await frozenInD1(test, id)).not.toBeNull();
    expect(await frozenInObject(id)).not.toBeNull();
  }
});

it("freezes the workspaces of an account whose address Google no longer has verified, at a sign-in that is refused for it", async () => {
  const { test } = await started();
  await invite(test, member.email);
  const { live, sandbox } = await workspaceIds(await signedIn(test, member));

  const refused = await signIn(test, test.browser(), {
    ...member,
    verified: false,
  });
  expect(locationOf(refused)).toBe("/sign-in?error=email_not_verified");
  await Promise.all(test.keptAlive);

  // An address that is not verified proves nothing of who signs in, and
  // the account's access ends: its keys are revoked, and its workspaces
  // are frozen with them.
  for (const id of [live, sandbox]) {
    expect(await frozenInD1(test, id)).not.toBeNull();
    expect(await frozenInObject(id)).not.toBeNull();
  }
});

it("freezes the workspaces of the accounts that are stored with an address that Google verifies for somebody else, also when the sign-in of that somebody is refused", async () => {
  const { test } = await started();
  await invite(test, member.email);
  const { live } = await workspaceIds(await signedIn(test, member));
  // The address is no longer invited, and has gone to another Google
  // account meanwhile.
  await test.db
    .delete(allowedEmails)
    .where(eq(allowedEmails.email, member.email));

  const refused = await signIn(test, test.browser(), {
    email: member.email,
    sub: "5005",
  });
  expect(locationOf(refused)).toBe("/invite-only");
  await Promise.all(test.keptAlive);

  // Google has said that the address is the other account's: the one
  // that is stored with it has lost it, and its access ends here.
  expect(await frozenInD1(test, live)).not.toBeNull();
  expect(await frozenInObject(live)).not.toBeNull();
});

it("does not freeze an account that is only not let in, with the address that it has, as its keys are not revoked", async () => {
  const { test } = await started({
    env: { ADMIN_EMAILS: `${adminEmail},second@example.com` },
  });
  const account = { email: "second@example.com", sub: "1001" };
  const second = await signedIn(test, account);
  const { live } = await workspaceIds(second);

  test.redeploy({ ADMIN_EMAILS: adminEmail });
  expect(locationOf(await signIn(test, test.browser(), account))).toBe(
    "/invite-only",
  );
  await Promise.all(test.keptAlive);

  // Nothing of its identity is lost: its keys work again when it is let
  // in again, and so does its workspace, which a key reaches.
  expect(await frozenInD1(test, live)).toBeNull();
});
