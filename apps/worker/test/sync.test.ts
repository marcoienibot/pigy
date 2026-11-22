import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  maxPartTextLength,
  mutators,
  pingMessageText,
  syncCloseCodes,
  syncLimits,
  syncProtocolVersion,
  syncSchemaVersion,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { expect, it, onTestFinished, vi } from "vitest";
import migrations from "../src/workspace/migrations/migrations.js";
import {
  maxRejectionsKept,
  socketLifetimeMs,
} from "../src/workspace/object.ts";
import {
  changeLogWindow,
  handBackLifetimeMs,
  isDatabaseFailure,
  keyLifetimeMs,
  maxRefusalMessageLength,
  WorkspaceStore,
} from "../src/workspace/store.ts";
import {
  channelAccess,
  connectChannel,
  disconnectChannel,
  mutateWorkspace,
} from "../src/workspace/workspaces.ts";
import { adminEmail, expectErrors, setup, signedIn } from "./helpers.ts";
import {
  identityOf,
  newId,
  objectOf,
  SyncClient,
  workspaceIds,
} from "./sync-client.ts";

/** A signed-in admin and the ID of their live workspace. */
async function start() {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const { live } = await workspaceIds(browser);
  return { test, browser, workspace: live };
}

/** `start()`, and a client that is connected to the workspace. */
async function connected() {
  const context = await start();
  const client = new SyncClient();
  await client.connect(context.browser, context.workspace);
  return { ...context, client };
}

/** Creates a post through `client` and returns the IDs of it and its part. */
async function createPost(client: SyncClient, text: string) {
  const ids = { postId: newId(), partId: newId() };
  client.mutate("post.create", { id: ids.postId, partId: ids.partId, text });
  await client.patch();
  return ids;
}

it("answers the first hello of a client with a snapshot", async () => {
  const { browser, workspace, client: author } = await connected();
  const { postId, partId } = await createPost(author, "Hello");

  const client = new SyncClient();
  const snapshot = await client.connect(browser, workspace);

  // From null: nothing that the client has counts.
  expect(snapshot).toMatchObject({ from: null, to: 1, lastMutationId: 0 });
  const createdAt = Date.parse("2026-11-14T10:00:00Z");
  expect(client.copy).toEqual({
    post: [
      {
        id: postId,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
        mode: null,
        dueAt: null,
        queuePosition: null,
        heldAt: null,
        trashedAt: null,
      },
    ],
    post_part: [
      { id: partId, postId, targetId: null, position: 0, text: "Hello" },
    ],
    channel: [],
    post_target: [],
    target_part_result: [],
    notification: [],
    schedule_slot: [],
    settings: [],
    media: [],
    part_media: [],
  });
});

it("answers the hello of a client in an empty workspace with an empty snapshot", async () => {
  const { browser, workspace } = await start();
  const client = new SyncClient();

  const snapshot = await client.connect(browser, workspace);

  // The client needs an answer to know that it is up to date.
  expect(snapshot).toEqual({
    from: null,
    to: 0,
    changes: [],
    lastMutationId: 0,
    rejected: [],
    messages: 1,
  });
});

it("confirms a mutation in the message that carries its changes", async () => {
  const { client } = await connected();
  const postId = newId();
  const partId = newId();

  client.mutate("post.create", { id: postId, partId, text: "Hello" });
  const patch = await client.patch();

  // One message with both, so that the client can drop its own version of
  // the change and show the server's without anything in between.
  expect(patch).toMatchObject({
    from: 0,
    to: 1,
    lastMutationId: 1,
    messages: 1,
  });
  expect(patch.changes.map(({ table }) => table).sort()).toEqual([
    "post",
    "post_part",
  ]);
  expect(client.unread).toBe(0);
});

it("applies the mutations of a message in order", async () => {
  const { client } = await connected();
  const postId = newId();
  const partId = newId();

  client.send({
    type: "mutate",
    mutations: [
      client.mutation("post.create", { id: postId, partId, text: "One" }),
      client.mutation("part.setText", { id: partId, text: "Two" }),
      client.mutation("part.setText", { id: partId, text: "Three" }),
    ],
  });
  const patch = await client.patch();

  // Each mutation is a change of its own with its own sequence number. The
  // patch takes the client past all three and has each row once, as it is
  // at the end.
  expect(patch).toMatchObject({ from: 0, to: 3, lastMutationId: 3 });
  expect(patch.changes).toHaveLength(2);
  expect(client.table("post_part")[0]?.text).toBe("Three");
});

it("runs every mutation at a later time than the one before it", async () => {
  const { test, workspace, client } = await connected();
  const start = test.clock.time.getTime();
  /** Creates `count` posts in one message, and returns their IDs. */
  const create = (count: number) => {
    const ids = Array.from({ length: count }, () => newId());
    client.send({
      type: "mutate",
      mutations: ids.map((id) =>
        client.mutation("post.create", { id, partId: newId(), text: "" }),
      ),
    });
    return ids;
  };
  const createdAt = (id: string) =>
    client.table("post").find((post) => post.id === id)?.createdAt;

  // Two drafts that were made offline arrive in one message. The clock does
  // not move while the message is handled, and they still get two times:
  // sorted by time, they stay in the order in which they were made.
  const [first = "", second = ""] = create(2);
  await client.patch();
  expect(createdAt(first)).toBe(start);
  expect(createdAt(second)).toBe(start + 1);

  // A message that arrives in the same millisecond goes on from there.
  const [third = ""] = create(1);
  await client.patch();
  expect(createdAt(third)).toBe(start + 2);

  // The time is stored: an object that starts again does not begin at the
  // clock, which here has not moved, and not when the clock has gone back.
  await evictDurableObject(objectOf(workspace));
  test.advance(-60_000);
  const [fourth = ""] = create(1);
  await client.patch();
  expect(createdAt(fourth)).toBe(start + 3);

  // Once the clock is ahead again, the time is the clock's.
  test.advance(120_000);
  const [fifth = ""] = create(1);
  await client.patch();
  expect(createdAt(fifth)).toBe(start + 60_000);
});

it("runs the first mutation after an upgrade later than the ones before it, on a clock that is behind them", async () => {
  const { test, browser, workspace } = await start();
  const identity = await identityOf(test, workspace);
  const postId = newId();
  const partId = newId();
  // The machine that ran the workspace before had a clock that was an
  // hour ahead of the one that runs it now.
  const edited = test.clock.time.getTime() + 60 * 60 * 1000;
  await runInDurableObject(objectOf(workspace), async (_, state) => {
    // The database as a Worker left it that did not store the time of the
    // last mutation: with the migrations that there were then, up to the
    // one for the channels, and a draft that somebody edited.
    await state.storage.deleteAll();
    await migrate(drizzle(state.storage), {
      ...migrations,
      journal: {
        ...migrations.journal,
        entries: migrations.journal.entries.filter(({ idx }) => idx <= 2),
      },
    });
    const { sql } = state.storage;
    sql.exec(
      "insert into workspace (id, owner_id, environment, seq, log_floor) values (?, ?, ?, 0, 0)",
      identity.id,
      identity.ownerId,
      identity.environment,
    );
    sql.exec(
      "insert into post (id, status, created_at, updated_at) values (?, 'draft', ?, ?)",
      postId,
      edited - 1000,
      edited,
    );
    sql.exec(
      "insert into post_part (id, post_id, position, text) values (?, ?, 0, 'Before')",
      partId,
      postId,
    );
  });
  // The Worker of today starts the object, which brings its database up
  // to date.
  await evictDurableObject(objectOf(workspace));
  const client = new SyncClient();
  await client.connect(browser, workspace);
  expect(client.table("post")).toMatchObject([
    { id: postId, updatedAt: edited },
  ]);

  client.mutate("part.setText", { id: partId, text: "After" });
  await client.patch();

  // The edit of today is later than the one before it, although the
  // clock says otherwise: a list that is sorted by `updatedAt` does not
  // put the draft back behind what was edited before it.
  expect(client.table("post_part")[0]?.text).toBe("After");
  expect(client.table("post")[0]?.updatedAt).toBe(edited + 1);
});

it("says nothing in the inbox, after an upgrade, of a post whose other account was disconnected before the upgrade", async () => {
  const { test, browser, workspace } = await start();
  const identity = await identityOf(test, workspace);
  const [postId, partId, endedId, underWayId] = [
    newId(),
    newId(),
    newId(),
    newId(),
  ];
  const at = test.clock.time.getTime();
  await runInDurableObject(objectOf(workspace), async (_, state) => {
    // The database as the Worker before the inbox left it, in the middle
    // of a post to two accounts: the person has disconnected one of them,
    // which ended its delivery with the words of `channel.disconnect`,
    // and the other delivery is under way. A target did not say then
    // that a disconnect had ended it.
    await state.storage.deleteAll();
    await migrate(drizzle(state.storage), {
      ...migrations,
      journal: {
        ...migrations.journal,
        entries: migrations.journal.entries.filter(({ idx }) => idx <= 11),
      },
    });
    const { sql } = state.storage;
    sql.exec(
      "insert into workspace (id, owner_id, environment, seq, log_floor) values (?, ?, ?, 0, 0)",
      identity.id,
      identity.ownerId,
      identity.environment,
    );
    sql.exec(
      "insert into post (id, status, created_at, updated_at) values (?, 'sending', ?, ?)",
      postId,
      at,
      at,
    );
    sql.exec(
      "insert into post_part (id, post_id, position, text) values (?, ?, 0, 'To two accounts')",
      partId,
      postId,
    );
    sql.exec(
      "insert into post_target (id, post_id, channel_id, status, attempt, error, queued_at) values (?, ?, ?, 'error', 1, 'The account was disconnected before the post was sent.', ?)",
      endedId,
      postId,
      newId(),
      at,
    );
    sql.exec(
      "insert into post_target (id, post_id, channel_id, status, attempt, queued_at) values (?, ?, ?, 'sending', 1, ?)",
      underWayId,
      postId,
      newId(),
      at,
    );
  });
  // The Worker of today starts the object, which brings its database up
  // to date, and the delivery that was under way arrives.
  await evictDurableObject(objectOf(workspace));
  expect(
    await mutateWorkspace(env.WORKSPACE, identity, "target.end", {
      id: underWayId,
      attempt: 1,
      status: "sent",
    }),
  ).toEqual({ ok: true });

  const client = new SyncClient();
  await client.connect(browser, workspace);
  // The post has not arrived everywhere, so it is in `error`, because of
  // what the person did themselves, which the upgrade has to have marked:
  // an unmarked target is a delivery that failed, of which the inbox
  // tells.
  expect(client.table("post")).toMatchObject([{ id: postId, status: "error" }]);
  expect(
    Object.fromEntries(
      client
        .table("post_target")
        .map(({ id, disconnected }) => [id, disconnected]),
    ),
  ).toEqual({ [endedId]: true, [underWayId]: false });
  expect(client.table("notification")).toEqual([]);
});

it("brings two clients to the same state after they changed the same row at once", async () => {
  const { browser, workspace, client: first } = await connected();
  const { partId } = await createPost(first, "Draft");
  const second = new SyncClient();
  await second.connect(browser, workspace);

  // Neither has seen the change of the other when it sends its own.
  first.mutate("part.setText", { id: partId, text: "From the first" });
  second.mutate("part.setText", { id: partId, text: "From the second" });
  // Each receives both changes, in the order the server applied them.
  await first.patch();
  await first.patch();
  await second.patch();
  await second.patch();

  expect(first.copy).toEqual(second.copy);
  // And that state is the server's: what a client that was not there gets.
  const third = new SyncClient();
  await third.connect(browser, workspace);
  expect(third.copy).toEqual(first.copy);
  // The last write wins, whichever it was.
  expect(["From the first", "From the second"]).toContain(
    first.table("post_part")[0]?.text,
  );
  expect(first.cursor).toBe(3);
});

it("sends a client that connects again only what it missed", async () => {
  const { test, browser, workspace, client: author } = await connected();
  const untouched = await createPost(author, "Untouched");
  const edited = await createPost(author, "To be edited");
  const deleted = await createPost(author, "To be deleted");
  const client = new SyncClient();
  await client.connect(browser, workspace);
  client.disconnect();

  test.advance(1000);
  author.mutate("part.setText", { id: edited.partId, text: "Edited" });
  await author.patch();
  author.mutate("post.delete", { id: deleted.postId });
  await author.patch();
  const created = await createPost(author, "Created meanwhile");

  const delta = await client.connect(browser, workspace);

  // From the cursor of the client: what it has stays.
  expect(delta).toMatchObject({ from: 3, to: 6 });
  const changed = (table: string, op: string) =>
    delta.changes
      .filter((change) => change.table === table && change.op === op)
      .map((change) => (change.op === "put" ? change.row.id : change.id))
      .sort();
  expect(changed("post", "put")).toEqual(
    [edited.postId, created.postId].sort(),
  );
  expect(changed("post_part", "put")).toEqual(
    [edited.partId, created.partId].sort(),
  );
  expect(changed("post", "delete")).toEqual([deleted.postId]);
  expect(changed("post_part", "delete")).toEqual([deleted.partId]);
  // With the delta on top of what it had, the client is where the author is.
  expect(client.copy).toEqual(author.copy);
  expect(client.table("post").map(({ id }) => id)).toContain(untouched.postId);
});

it("tells a client that missed nothing that it is up to date", async () => {
  const { browser, workspace, client } = await connected();
  await createPost(client, "Hello");
  client.disconnect();

  const delta = await client.connect(browser, workspace);

  expect(delta).toMatchObject({
    from: 1,
    to: 1,
    changes: [],
    lastMutationId: 1,
  });
});

it("sends a snapshot to a client that is too far behind for the change log", async () => {
  const { browser, workspace, client: author } = await connected();
  const { partId } = await createPost(author, "0");
  // Two clients, one change apart. After as many more changes as the log
  // holds, it reaches back to the cursor of the second and no further.
  const behind = new SyncClient();
  await behind.connect(browser, workspace);
  behind.disconnect();
  author.mutate("part.setText", { id: partId, text: "1" });
  await author.patch();
  const justInTime = new SyncClient();
  await justInTime.connect(browser, workspace);
  justInTime.disconnect();

  for (let sent = 0; sent < changeLogWindow; ) {
    const mutations = [];
    for (let i = 0; i < syncLimits.mutationsPerMessage; i++, sent++) {
      mutations.push(
        author.mutation("part.setText", { id: partId, text: `${sent + 2}` }),
      );
    }
    author.send({ type: "mutate", mutations });
    await author.patch();
  }

  const delta = await justInTime.connect(browser, workspace);
  const snapshot = await behind.connect(browser, workspace);

  expect(delta.from).toBe(2);
  expect(snapshot.from).toBeNull();
  // Either way the client ends up with what the server has.
  expect(justInTime.copy).toEqual(author.copy);
  expect(behind.copy).toEqual(author.copy);
  expect(behind.cursor).toBe(changeLogWindow + 2);
  // The log is cut off where it no longer serves anybody.
  const logged = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql
      .exec<{ rows: number; oldest: number }>(
        "select count(*) as rows, min(seq) as oldest from change_log",
      )
      .one(),
  );
  expect(logged).toEqual({ rows: 2 * changeLogWindow, oldest: 3 });
});

it("sends a snapshot to a client whose cursor is ahead of the workspace", async () => {
  const { browser, workspace, client: author } = await connected();
  await createPost(author, "Hello");
  // A cursor that this workspace never handed out, as after its data was
  // restored to an earlier state. There is nothing to compute a delta from.
  const client = new SyncClient();
  client.cursor = 7;

  const snapshot = await client.connect(browser, workspace);

  expect(snapshot).toMatchObject({ from: null, to: 1 });
  expect(client.copy).toEqual(author.copy);
});

it("applies a mutation once, however often it is sent", async () => {
  const { browser, workspace, client } = await connected();
  const postId = newId();
  const partId = newId();
  const create = client.mutation("post.create", {
    id: postId,
    partId,
    text: "Hello",
  });
  client.send({ type: "mutate", mutations: [create] });
  await client.patch();

  // The answer got lost, as far as the client knows. It connects again and
  // sends the mutation once more, together with one that is new.
  client.disconnect();
  const hello = await client.connect(browser, workspace);
  const edit = client.mutation("part.setText", { id: partId, text: "Edited" });
  client.send({ type: "mutate", mutations: [create, edit] });
  const patch = await client.patch();

  // The hello says what was processed, so the client could have known.
  expect(hello.lastMutationId).toBe(1);
  // Run a second time, the creation would have been rejected: the post
  // exists. It was skipped instead, and only the edit happened.
  expect(patch).toMatchObject({
    from: 1,
    to: 2,
    lastMutationId: 2,
    rejected: [],
  });
  expect(client.table("post_part")[0]?.text).toBe("Edited");
});

it("answers a message of mutations that were all processed before", async () => {
  const { client } = await connected();
  const { postId } = await createPost(client, "Hello");

  client.send({
    type: "mutate",
    mutations: [{ id: 1, name: "post.delete", args: { id: postId } }],
  });
  const patch = await client.patch();

  // Another mutation under an ID that was used: it is not run. The client
  // still gets its answer, with nothing in it.
  expect(patch).toMatchObject({
    from: 1,
    to: 1,
    changes: [],
    lastMutationId: 1,
  });
  expect(client.table("post")).toHaveLength(1);
});

it("refuses mutations when one before them is missing", async () => {
  const { browser, workspace, client } = await connected();
  const postId = newId();
  const partId = newId();
  const first = client.mutation("post.create", {
    id: postId,
    partId,
    text: "",
  });
  const second = client.mutation("part.setText", { id: partId, text: "Hi" });

  // The second without the first.
  client.send({ type: "mutate", mutations: [second] });

  expect(await client.next()).toMatchObject({
    type: "error",
    code: "mutation_gap",
  });
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
  // Nothing was processed, so the client can send both after it has
  // connected again.
  const hello = await client.connect(browser, workspace);
  expect(hello).toMatchObject({ to: 0, lastMutationId: 0 });
  client.send({ type: "mutate", mutations: [first, second] });
  expect(await client.patch()).toMatchObject({
    lastMutationId: 2,
    rejected: [],
  });
  expect(client.table("post_part")[0]?.text).toBe("Hi");
});

it("reports a mutation that was rejected and counts it as processed", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  const first = { id: newId(), partId: newId(), text: "First" };
  const third = { id: newId(), partId: newId(), text: "Third" };
  const mutations = [
    client.mutation("post.create", first),
    // There is no such part.
    client.mutation("part.setText", { id: newId(), text: "Nowhere" }),
    client.mutation("post.create", third),
  ];

  client.send({ type: "mutate", mutations });
  const patch = await client.patch();

  // The mutation in the middle did nothing, and did not stop the third.
  expect(patch).toMatchObject({ from: 0, to: 2, lastMutationId: 3 });
  expect(patch.rejected).toEqual([
    {
      id: 2,
      code: "not_found",
      message: "This part is gone: it was removed, or its post was deleted",
    },
  ]);
  expect(client.table("post").map(({ id }) => id)).toEqual(
    [first.id, third.id].sort(),
  );
  // Sent again, it is skipped like any mutation that was processed.
  client.send({ type: "mutate", mutations });
  expect(await client.patch()).toMatchObject({ changes: [], rejected: [] });
  // The other client gets the changes, and nothing about mutations that
  // are not its own.
  expect(await other.patch()).toMatchObject({
    from: 0,
    to: 2,
    lastMutationId: 0,
    rejected: [],
  });
  expect(other.copy).toEqual(client.copy);
});

it("answers mutations that were all rejected, and tells nobody else", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);

  client.send({
    type: "mutate",
    mutations: [
      { id: client.nextMutationId++, name: "post.archive", args: {} },
      {
        id: client.nextMutationId++,
        name: "post.create",
        args: { id: "not-an-id" },
      },
    ],
  });
  const patch = await client.patch();

  // A mutation that the server cannot even read is rejected like one that a
  // mutator refuses. If it were not counted as processed, the client would
  // send it again for ever, and nothing after it would get through.
  expect(patch).toMatchObject({
    from: 0,
    to: 0,
    changes: [],
    lastMutationId: 2,
  });
  expect(patch.rejected.map(({ id, code }) => [id, code])).toEqual([
    [1, "unknown_mutation"],
    [2, "invalid_arguments"],
  ]);
  // Nothing changed, so the other client hears nothing: the next thing it
  // receives is the next change.
  await createPost(client, "Hello");
  expect(await other.patch()).toMatchObject({ from: 0, to: 1 });
});

it("tells a client of a rejection when the answer that carried it was lost", async () => {
  const { browser, workspace, client: phone } = await connected();
  const { postId, partId } = await createPost(phone, "Draft");
  const laptop = new SyncClient();
  await laptop.connect(browser, workspace);
  laptop.disconnect();
  // While the laptop is offline, the post is deleted on the phone.
  phone.mutate("post.delete", { id: postId });
  await phone.patch();

  // Back online, the laptop sends the edit that it made in the meantime.
  await laptop.connect(browser, workspace);
  const edit = laptop.mutate("part.setText", { id: partId, text: "Offline" });
  // The answer has left the server, so the mutation is processed. The
  // client does not apply it and drops the socket: to the client, the
  // answer never arrived.
  await laptop.next();
  laptop.disconnect();
  const hello = await laptop.connect(browser, workspace);

  // The rows could not tell the client what happened: an edit that was
  // accepted before the post was deleted leaves the same behind. Without
  // the reason, the edit would be gone and the user would not be told.
  expect(hello).toMatchObject({ from: 2, to: 2, lastMutationId: edit.id });
  expect(hello.rejected).toEqual([
    {
      id: edit.id,
      code: "not_found",
      message: "This part is gone: it was removed, or its post was deleted",
    },
  ]);
  // Now the client has seen it, and says so in its next hello. It is not
  // told again: `SyncClient` would fail on a rejection that comes twice.
  laptop.disconnect();
  expect(await laptop.connect(browser, workspace)).toMatchObject({
    lastMutationId: edit.id,
    rejected: [],
  });
});

it("keeps a rejection until a hello says that its client has seen it", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  /** The IDs of the mutations whose rejection the server keeps for a client. */
  const kept = ({ clientId }: SyncClient) =>
    runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.sql
        .exec(
          "select mutation_id from rejection where client_id = ? order by mutation_id",
          clientId,
        )
        .toArray()
        .map((row) => row.mutation_id),
    );
  const nowhere = { id: newId(), text: "Nowhere" };

  // Two rejections for the client. It sees the answer to the first and not
  // the one to the second. The other client does not see its answer either.
  client.mutate("part.setText", nowhere);
  await client.patch();
  client.mutate("part.setText", nowhere);
  await client.next();
  other.mutate("part.setText", nowhere);
  await other.next();
  // The server cannot know which answers arrived, so it has kept them all.
  expect(await kept(client)).toEqual([1, 2]);

  // The hello says that the client has seen the first.
  client.disconnect();
  const hello = await client.connect(browser, workspace);

  expect(hello.rejected.map(({ id }) => id)).toEqual([2]);
  expect(await kept(client)).toEqual([2]);
  // And the next one, that it has seen the second.
  client.disconnect();
  expect((await client.connect(browser, workspace)).rejected).toEqual([]);
  expect(await kept(client)).toEqual([]);
  // The mutations of two clients have the same IDs. What one client has
  // seen says nothing about the other, which has yet to hear of its own.
  expect(await kept(other)).toEqual([1]);
});

it("takes no more mutations from a client that has too many rejections waiting", async () => {
  const { browser, workspace, client } = await connected();
  // As many rejections as the object keeps for one client. The client sees
  // each answer, but the server only learns that from a hello.
  for (
    let sent = 0;
    sent < maxRejectionsKept;
    sent += syncLimits.mutationsPerMessage
  ) {
    client.send({
      type: "mutate",
      mutations: Array.from({ length: syncLimits.mutationsPerMessage }, () =>
        client.mutation("part.setText", { id: newId(), text: "Nowhere" }),
      ),
    });
    await client.patch();
  }
  const create = client.mutation("post.create", {
    id: newId(),
    partId: newId(),
    text: "One more",
  });

  client.send({ type: "mutate", mutations: [create] });

  // The client is made to say hello again, with the code that has it do so
  // at once. The mutation was not run, so nothing is lost.
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.reconnect });
  expect(await client.connect(browser, workspace)).toMatchObject({
    to: 0,
    lastMutationId: maxRejectionsKept,
    rejected: [],
  });
  // That hello said that the client has seen the rejections. They are
  // forgotten, and the server takes mutations from the client again.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql.exec("select count(*) as rows from rejection").one(),
  );
  expect(stored).toEqual({ rows: 0 });
  client.send({ type: "mutate", mutations: [create] });
  expect(await client.patch()).toMatchObject({
    to: 1,
    lastMutationId: maxRejectionsKept + 1,
    rejected: [],
  });
});

it("cuts short a reason that quotes what the client sent", async () => {
  const { client } = await connected();
  // The reason names the argument that the mutator does not take, and the
  // server keeps reasons. So a client must not decide how long one is.
  const argument = "x".repeat(10 * maxRefusalMessageLength);

  client.send({
    type: "mutate",
    mutations: [
      {
        id: client.nextMutationId++,
        name: "post.delete",
        args: { id: newId(), [argument]: true },
      },
    ],
  });
  const patch = await client.patch();

  expect(patch.rejected).toHaveLength(1);
  expect(patch.rejected[0]?.code).toBe("invalid_arguments");
  // Cut, not replaced: the start of the argument's name is still in it.
  expect(patch.rejected[0]?.message).toContain("xxx");
  expect(patch.rejected[0]?.message).toHaveLength(maxRefusalMessageLength);
});

it("closes the older socket of a client that opens another", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  const older = client.closed;

  // A second socket for the same local copy while the first is open: what
  // a tab does that shares a stored copy with another tab, and a client
  // that has given up on a socket that the server still holds.
  await client.connect(browser, workspace);

  expect(await older).toMatchObject({ code: syncCloseCodes.replaced });
  // The newer socket works, and the socket of another client was left
  // alone: it still gets the changes.
  await createPost(client, "Hello");
  expect(await other.patch()).toMatchObject({ from: 0, to: 1 });
});

it("keeps the socket that a client opened last when the hello of an older one arrives late", async () => {
  const { browser, workspace } = await start();
  // A client on a bad connection: the hello on its first socket is held up
  // on the way, so it gives the socket up and opens another, on which the
  // hello gets through.
  const older = new SyncClient();
  await older.open(browser, workspace);
  const newer = new SyncClient();
  await newer.connect(browser, workspace);

  // Only now the first hello arrives, with the same client ID, on a socket
  // that is still open as far as the server can tell.
  older.hello({ clientId: newer.clientId });

  // The socket that was opened first is the one that goes, although its
  // hello came last. It gets no answer: the client is not listening there.
  expect(await older.closed).toMatchObject({ code: syncCloseCodes.replaced });
  expect(older.received).toEqual([]);
  // Had the server gone by the order of the hellos, it would have closed
  // the newer socket, and the client would be left without any.
  await createPost(newer, "Hello");
  expect(newer.table("post")).toHaveLength(1);
});

it("sends a change that the Worker makes to the clients that are connected", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);
  const postId = newId();
  const partId = newId();

  const outcome = await mutateWorkspace(
    env.WORKSPACE,
    identity,
    "post.create",
    {
      id: postId,
      partId,
      text: "From the API",
    },
  );
  const patch = await client.patch();

  expect(outcome).toEqual({ ok: true });
  // Not a mutation of this client: what it has had processed is unchanged.
  expect(patch).toMatchObject({
    from: 0,
    to: 1,
    lastMutationId: 0,
    rejected: [],
  });
  expect(client.table("post_part")).toEqual([
    { id: partId, postId, targetId: null, position: 0, text: "From the API" },
  ]);
});

it("tells the Worker why a mutation of its own was rejected", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);

  const outcome = await mutateWorkspace(
    env.WORKSPACE,
    identity,
    "part.setText",
    {
      id: newId(),
      text: "Nowhere",
    },
  );

  expect(outcome).toEqual({
    ok: false,
    code: "not_found",
    message: "This part is gone: it was removed, or its post was deleted",
  });
  // The clients hear nothing of it: the next thing this one receives is
  // the next change.
  await createPost(client, "Hello");
  expect(client.cursor).toBe(1);
});

it("carries a change of the Worker's out once when it comes with a key", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);
  const { partId } = await createPost(client, "Hello");
  const write = (text: string, key?: string) =>
    mutateWorkspace(
      env.WORKSPACE,
      identity,
      "part.setText",
      { id: partId, text },
      key,
    );
  const text = () => client.table("post_part")[0]?.text;

  expect(await write("First", "step-1")).toEqual({ ok: true });
  await client.patch();
  expect(await write("Other", "step-2")).toEqual({ ok: true });
  await client.patch();

  // The caller did not get the answer to the first call and makes it
  // again. Run a second time, the mutator would put back what the call
  // after it has replaced. It is answered as it was, and changes nothing.
  expect(await write("First", "step-1")).toEqual({ ok: true });
  // Nothing was sent for the repeat: the next patch is that of the next
  // change, and it follows the one before without a gap.
  expect(await write("Last")).toEqual({ ok: true });
  expect(await client.patch()).toMatchObject({ from: 3, to: 4 });
  expect(text()).toBe("Last");
});

it("answers a call with a key the same way every time, also when it was refused", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);
  const postId = newId();
  const partId = newId();
  const edit = () =>
    mutateWorkspace(
      env.WORKSPACE,
      identity,
      "part.setText",
      { id: partId, text: "Edited" },
      "edit",
    );
  const refused = {
    ok: false,
    code: "not_found",
    message: "This part is gone: it was removed, or its post was deleted",
  };

  expect(await edit()).toEqual(refused);
  // The post exists by the time the call is repeated. It was refused, and
  // stays refused: the caller acted on that answer, or will.
  client.mutate("post.create", { id: postId, partId, text: "Hello" });
  await client.patch();
  expect(await edit()).toEqual(refused);
  expect(client.table("post_part")[0]?.text).toBe("Hello");
});

it("forgets the key of a call that failed, and old keys in time", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);
  const { partId } = await createPost(client, "Hello");
  const write = (text: string, key: string) =>
    mutateWorkspace(
      env.WORKSPACE,
      identity,
      "part.setText",
      { id: partId, text },
      key,
    );
  const keys = () =>
    runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.sql
        .exec<{ key: string }>("select key from keyed_call order by key")
        .toArray()
        .map(({ key }) => key),
    );

  // The database fails under the mutator, as in the test of a full
  // database below: the call has not happened. If its key were kept, the
  // repeat would be answered and never carried out.
  const full = await runInDurableObject(objectOf(workspace), (_, state) => {
    const { sql } = state.storage;
    const exec = sql.exec.bind(sql);
    return vi.spyOn(sql, "exec").mockImplementation((query, ...bindings) => {
      if (query.includes('"post_part"') && bindings.includes("First")) {
        throw new Error("database or disk is full: SQLITE_FULL");
      }
      return exec(query, ...bindings);
    });
  });
  onTestFinished(() => full.mockRestore());
  await expect(write("First", "a")).rejects.toThrow();
  full.mockRestore();
  expect(await keys()).toEqual([]);
  expect(await write("First", "a")).toEqual({ ok: true });
  expect(await client.patch()).toMatchObject({ from: 1, to: 2 });

  // A key is kept for as long as anybody may repeat its call, and no
  // longer: the table must not grow for ever. It goes when a later call
  // comes with a key.
  test.advance(keyLifetimeMs - 1000);
  expect(await write("Second", "b")).toEqual({ ok: true });
  expect(await keys()).toEqual(["a", "b"]);
  test.advance(2000);
  expect(await write("Third", "c")).toEqual({ ok: true });
  expect(await keys()).toEqual(["b", "c"]);
});

it.each([
  ["text that is not JSON", "hello"],
  ["JSON that is not an object", "[]"],
  [
    "a message of a type that the protocol does not have",
    '{"type":"subscribe"}',
  ],
  ["a message without a type", "{}"],
  ["a binary frame", new ArrayBuffer(8)],
  [
    "a hello with a field that the protocol does not have",
    JSON.stringify({
      type: "hello",
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
      clientId: "01932c07-0000-7000-8000-000000000001",
      cursor: null,
      lastMutationId: 0,
      userId: "somebody-else",
    }),
  ],
  [
    "mutations before a hello",
    '{"type":"mutate","mutations":[{"id":1,"name":"post.delete","args":{}}]}',
  ],
])("closes a socket that sends %s", async (_name, frame) => {
  const { browser, workspace } = await start();
  const client = new SyncClient();
  await client.open(browser, workspace);

  client.sendFrame(frame);

  expect(await client.next()).toMatchObject({
    type: "error",
    code: "invalid_message",
  });
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
  // The workspace is none the worse for it.
  const next = new SyncClient();
  expect(await next.connect(browser, workspace)).toMatchObject({ to: 0 });
});

it("closes a socket that says hello twice", async () => {
  const { client } = await connected();

  client.hello();

  expect(await client.next()).toMatchObject({
    type: "error",
    code: "invalid_message",
  });
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
});

it("takes a message of the greatest length and refuses a longer one", async () => {
  const { browser, workspace } = await start();
  // A hello, padded with spaces, which JSON allows after a value.
  const hello = JSON.stringify({
    type: "hello",
    protocolVersion: syncProtocolVersion,
    schemaVersion: syncSchemaVersion,
    clientId: newId(),
    cursor: null,
    lastMutationId: 0,
  });
  const longest = hello.padEnd(syncLimits.clientMessageLength);
  const fits = new SyncClient();
  await fits.open(browser, workspace);
  const tooLong = new SyncClient();
  await tooLong.open(browser, workspace);

  fits.sendFrame(longest);
  tooLong.sendFrame(`${longest} `);

  expect(await fits.patch()).toMatchObject({ from: null });
  expect(await tooLong.next()).toMatchObject({
    type: "error",
    code: "message_too_large",
  });
  expect(await tooLong.closed).toMatchObject({ code: syncCloseCodes.error });
});

it.each([
  [
    "a later version of the protocol",
    { protocolVersion: syncProtocolVersion + 1 },
  ],
  [
    "an earlier version of the schema",
    { schemaVersion: syncSchemaVersion - 1 },
  ],
  [
    // A hello that this version of the protocol cannot read. It has to get
    // the same answer, not "invalid message".
    "a later version of the protocol, with a hello of another shape",
    {
      protocolVersion: syncProtocolVersion + 1,
      clientId: undefined,
      cursor: undefined,
      client: { id: "tab-1", cursors: {} },
    },
  ],
])(
  "tells a client that speaks %s which versions the server speaks",
  async (_name, fields) => {
    const { browser, workspace } = await start();
    const client = new SyncClient();
    await client.open(browser, workspace);

    client.hello(fields);

    // With the versions of the server, the client can tell whether it is the
    // one that has to update.
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "version_mismatch",
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
    });
    expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
  },
);

it("answers a ping, however it is spelled", async () => {
  const { client } = await connected();

  // Spelled like this, the runtime answers and the object stays asleep.
  client.sendFrame(pingMessageText);
  expect(await client.next()).toEqual({ type: "pong" });
  // Spelled any other way, the object answers.
  client.sendFrame('{ "type": "ping" }');
  expect(await client.next()).toEqual({ type: "pong" });
});

it("sends a large patch in several messages", async () => {
  const { browser, workspace, client: author } = await connected();
  // More text than one message of the server may hold.
  const text = "a".repeat(maxPartTextLength);
  const posts = Math.ceil(syncLimits.patchChangesLength / text.length) + 1;
  for (let i = 0; i < posts; i++) await createPost(author, text);

  const client = new SyncClient();
  const snapshot = await client.connect(browser, workspace);

  expect(snapshot.messages).toBeGreaterThan(1);
  for (const message of client.received) {
    // The limit is on the changes. The rest of a message is a few numbers.
    expect(message.length).toBeLessThan(syncLimits.patchChangesLength + 200);
  }
  // The client applied the messages as one patch, and has everything.
  expect(client.copy).toEqual(author.copy);
  expect(client.table("post")).toHaveLength(posts);
});

it("sends only the synced columns of the synced tables", async () => {
  const { browser, workspace, client: author } = await connected();
  const { postId, partId } = await createPost(author, "Hello");
  // What a later phase will do: a column next to the synced ones that
  // holds something no client may see.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    state.storage.sql.exec("alter table post add column credentials text");
    state.storage.sql.exec("update post set credentials = 'top-secret'");
  });

  // The three ways a row leaves the object: in a snapshot, in what a
  // client missed, and in a change as it happens.
  const fresh = new SyncClient();
  await fresh.connect(browser, workspace);
  author.mutate("part.setText", { id: partId, text: "Edited" });
  await author.patch();
  await fresh.patch();
  fresh.disconnect();
  author.mutate("part.setText", { id: partId, text: "Edited again" });
  await author.patch();
  await fresh.connect(browser, workspace);

  const messages = [...author.received, ...fresh.received];
  // Each of the three had the row of the post in it. The clients would
  // have failed on a field that the protocol does not have, and here is
  // the proof that the value went nowhere.
  expect(messages.filter((text) => text.includes(postId)).length).toBe(6);
  expect(messages.join("\n")).not.toContain("top-secret");
  expect(messages.join("\n")).not.toContain("credentials");
  // The column is still there, and writing the synced ones left it alone.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql.exec("select credentials from post").one(),
  );
  expect(stored).toEqual({ credentials: "top-secret" });
  // The tables of the object's own bookkeeping have rows by now. None of
  // them is in a snapshot.
  const snapshot = await new SyncClient().connect(browser, workspace);
  expect(new Set(snapshot.changes.map(({ table }) => table))).toEqual(
    new Set(["post", "post_part"]),
  );
});

/** An account as the Worker hands it to a workspace when it is connected. */
function connectedAccount(fields: { name?: string } = {}) {
  return {
    id: newId(),
    network: "mastodon" as const,
    accountId: "1@mastodon.example",
    handle: "@ada@mastodon.example",
    name: "Ada Lovelace",
    avatarUrl: null,
    profileUrl: "https://mastodon.example/@ada",
    expiresAt: null,
    limits: null,
    ...fields,
  };
}

it("never sends what a workspace keeps of a channel besides its row", async () => {
  const { test, browser, workspace, client: early } = await connected();
  const identity = await identityOf(test, workspace);
  // What the Worker stores with a channel: the credentials, sealed, and
  // when to refresh them. Texts that nothing else in a workspace has.
  const first = { credentials: "sealed-credentials-one", refreshAt: 1234567 };
  const second = { credentials: "sealed-credentials-two", refreshAt: 7654321 };

  // The three ways a row leaves the object: in a change as it happens, in
  // what a client missed, and in a snapshot.
  const stored = await connectChannel(
    env.WORKSPACE,
    identity,
    connectedAccount(),
    first,
  );
  await early.patch();
  early.disconnect();
  // The account is connected again while the client is away: the access is
  // replaced, and the row changes with it.
  await connectChannel(
    env.WORKSPACE,
    identity,
    connectedAccount({ name: "Ada" }),
    second,
  );
  await early.connect(browser, workspace);
  const fresh = new SyncClient();
  await fresh.connect(browser, workspace);

  if (!stored.ok) throw new Error(stored.message);
  // All three carried the channel.
  const messages = [...early.received, ...fresh.received];
  expect(
    messages.filter((text) => text.includes(stored.channelId)),
  ).toHaveLength(3);
  expect(fresh.table("channel")).toMatchObject([
    { id: stored.channelId, name: "Ada", status: "connected" },
  ]);
  // None carried the access, in whole or in part, or so much as the name
  // of a column that holds it.
  const sent = messages.join("\n");
  for (const secret of [
    "sealed-credentials",
    "1234567",
    "7654321",
    "credentials",
    "refresh",
  ]) {
    expect(sent).not.toContain(secret);
  }
  // It is there, and it is the one of the second connection: the Worker
  // gets it back, and nobody else has a way to ask.
  expect(
    await channelAccess(env.WORKSPACE, identity, stored.channelId),
  ).toEqual({
    network: "mastodon",
    accountId: "1@mastodon.example",
    credentials: "sealed-credentials-two",
    // Which connection the access is of: the time that the row has.
    connectedAt: fresh.table("channel")[0]?.connectedAt,
  });

  // A channel that goes takes its access along.
  await mutateWorkspace(env.WORKSPACE, identity, "channel.disconnect", {
    id: stored.channelId,
  });
  await fresh.patch();
  expect(fresh.table("channel")).toEqual([]);
  expect(
    await channelAccess(env.WORKSPACE, identity, stored.channelId),
  ).toBeNull();
  const left = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql.exec("select * from channel").toArray(),
  );
  expect(left).toEqual([]);
});

/**
 * A workspace whose account was connected a second time, by a call with a
 * key that asked for the access that it replaced, as the callback of a
 * network asks where every connection has an access of its own.
 */
async function reconnected() {
  const context = await connected();
  const identity = await identityOf(context.test, context.workspace);
  // The sealed credentials of the two connections. Texts that nothing else
  // in a workspace has.
  const first = { credentials: "sealed-credentials-one", refreshAt: null };
  const second = { credentials: "sealed-credentials-two", refreshAt: null };
  const stored = await connectChannel(
    env.WORKSPACE,
    identity,
    connectedAccount(),
    first,
  );
  if (!stored.ok) throw new Error(stored.message);
  const account = connectedAccount({ name: "Ada" });
  /** The second connection, and every repeat of it. */
  const reconnect = () =>
    connectChannel(env.WORKSPACE, identity, account, second, {
      key: "reconnect",
      handBack: true,
    });
  const answer = await reconnect();
  /** Every row of every table of the workspace, as one text. */
  const database = () =>
    runInDurableObject(objectOf(context.workspace), (_, state) => {
      const { sql } = state.storage;
      const tables = sql
        .exec<{ name: string }>(
          // Without the tables of the runtime, which nobody may read.
          "select name from sqlite_master where type = 'table' and name not like '\\_cf\\_%' escape '\\'",
        )
        .toArray();
      return JSON.stringify(
        tables.map(({ name }) => sql.exec(`select * from "${name}"`).toArray()),
      );
    });
  return {
    ...context,
    identity,
    channelId: stored.channelId,
    first,
    reconnect,
    answer,
    database,
  };
}

/** What a call that replaced the access of `reconnected()` is handed. */
const handedBack = {
  network: "mastodon",
  accountId: "1@mastodon.example",
  credentials: "sealed-credentials-one",
};

it("hands a repeat the access that the call replaced, and keeps it for minutes only", async () => {
  const { test, identity, channelId, reconnect, answer, database } =
    await reconnected();
  expect(answer).toMatchObject({ ok: true, channelId, replaced: handedBack });

  // The caller lost the answer and asks again, a moment before the time
  // is up. The channel holds the second access by now, so only what the
  // workspace kept of the call can answer with the first.
  test.advance(handBackLifetimeMs - 1000);
  expect(await reconnect()).toEqual(answer);
  // So it is in the database, and the search below can find it.
  expect(await database()).toContain("sealed-credentials-one");

  // The time is up, and the workspace is used in a way that has nothing
  // to do with the call: another account is connected, without a key.
  test.advance(2000);
  await connectChannel(
    env.WORKSPACE,
    identity,
    { ...connectedAccount(), accountId: "2@mastodon.example" },
    { credentials: "sealed-credentials-other", refreshAt: null },
  );
  const left = await database();
  expect(left).not.toContain("sealed-credentials-one");
  // Only that went: the channel has its access.
  expect(left).toContain("sealed-credentials-two");

  // The call is still one that has happened. A repeat is answered, without
  // the access, and does not store the channel again: run a second time,
  // the call would find the second access in the channel and hand that
  // back as replaced, to be ended at the network.
  expect(await reconnect()).toEqual({ ok: true, channelId, replaced: null });
  expect(await database()).toContain("sealed-credentials-two");
});

it("forgets the access that a call replaced with the first change of a client after its time", async () => {
  const { test, browser, workspace, client, reconnect, database } =
    await reconnected();
  client.disconnect();

  // Nobody connects or disconnects anything, and no call comes with a
  // key: the person writes a draft, some minutes later. On a socket of
  // its own: one does not last that long.
  test.advance(handBackLifetimeMs + 1000);
  const later = new SyncClient();
  await later.connect(browser, workspace);
  // Reading the workspace is not what does it.
  expect(await database()).toContain("sealed-credentials-one");
  await createPost(later, "Hello");

  expect(await database()).not.toContain("sealed-credentials-one");
  expect(await reconnect()).toMatchObject({ ok: true, replaced: null });
});

it("keeps nothing of an account whose channel is disconnected right after it was connected again", async () => {
  const { identity, channelId, answer, database } = await reconnected();
  expect(answer).toMatchObject({ replaced: handedBack });

  // No time has passed: the access that was replaced is within its time.
  // The disconnect hands out the second access, to be given back, and that
  // has to be all that the workspace held: whoever is told that a network
  // kept an access is also told that pigy holds nothing of it.
  expect(
    await disconnectChannel(env.WORKSPACE, identity, channelId),
  ).toMatchObject({
    ok: true,
    access: { credentials: "sealed-credentials-two" },
  });
  expect(await database()).not.toContain("sealed-credentials");
});

it("never sends the access that a connection replaced, which the workspace keeps for a repeat", async () => {
  const {
    browser,
    workspace,
    client: early,
    reconnect,
    answer,
    database,
  } = await reconnected();
  // The secret is there to be sent: the call was handed it, and the
  // workspace keeps it.
  expect(answer).toMatchObject({ replaced: handedBack });
  expect(await database()).toContain("sealed-credentials-one");

  // The ways out of the object, as for the access of a channel: the
  // changes as they happen, here the two connections, and a snapshot,
  // taken after a repeat of the call was answered from what is kept.
  await early.patch();
  await early.patch();
  expect(await reconnect()).toEqual(answer);
  const fresh = new SyncClient();
  await fresh.connect(browser, workspace);

  const messages = [...early.received, ...fresh.received];
  // They carried the channel of the second connection.
  expect(fresh.table("channel")).toMatchObject([{ name: "Ada" }]);
  expect(early.table("channel")).toMatchObject([{ name: "Ada" }]);
  const sent = messages.join("\n");
  // And nothing of either access, of the table that keeps the call, or of
  // what the call was answered with.
  for (const secret of [
    "sealed-credentials",
    "credentials",
    "replaced",
    "keyed_call",
    "reconnect",
  ]) {
    expect(sent).not.toContain(secret);
  }
});

it("refuses the mutations of a client that only the server runs", async () => {
  const { test, workspace, client } = await connected();
  const identity = await identityOf(test, workspace);
  const stored = await connectChannel(
    env.WORKSPACE,
    identity,
    connectedAccount(),
    { credentials: "sealed", refreshAt: null },
  );
  await client.patch();
  if (!stored.ok) throw new Error(stored.message);

  // A client that makes up a channel of its own, and one that drops a
  // channel without the Worker giving its access back.
  const made = client.mutate("channel.connect", {
    ...connectedAccount(),
    accountId: "2@mastodon.example",
  });
  const dropped = client.mutate("channel.disconnect", {
    id: stored.channelId,
  });

  expect(await client.patch()).toMatchObject({
    changes: [],
    rejected: [{ id: made.id, code: "not_allowed" }],
  });
  expect(await client.patch()).toMatchObject({
    changes: [],
    rejected: [{ id: dropped.id, code: "not_allowed" }],
  });
  expect(client.table("channel").map(({ id }) => id)).toEqual([
    stored.channelId,
  ]);
});

it("tells the Worker when a workspace does not store a channel", async () => {
  const { test, workspace } = await start();
  const identity = await identityOf(test, workspace);
  expectErrors();

  // An account whose ID is longer than a channel holds: what a network
  // could send, which the mutator refuses.
  const outcome = await connectChannel(
    env.WORKSPACE,
    identity,
    { ...connectedAccount(), accountId: "1".repeat(301) },
    { credentials: "sealed", refreshAt: null },
  );

  expect(outcome).toMatchObject({ ok: false, code: "invalid_arguments" });
  // Nothing is kept of it, the access least of all.
  const left = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql.exec("select * from channel").toArray(),
  );
  expect(left).toEqual([]);
});

it("carries on after the object was evicted from memory", async () => {
  const { test, browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  const { partId } = await createPost(client, "Before");
  await other.patch();

  // What the runtime does to an object with idle sockets: the object is
  // gone from memory and the sockets stay open.
  await evictDurableObject(objectOf(workspace));
  test.advance(1000);
  const edit = client.mutate("part.setText", { id: partId, text: "After" });
  const patch = await client.patch();

  // The object still knows who is on which socket, what each has, and
  // which mutations it has processed: no hello was needed.
  expect(patch).toMatchObject({
    from: 1,
    to: 2,
    lastMutationId: 2,
    rejected: [],
  });
  expect(await other.patch()).toMatchObject({
    from: 1,
    to: 2,
    lastMutationId: 0,
  });
  expect(other.copy).toEqual(client.copy);
  expect(client.table("post_part")[0]?.text).toBe("After");

  // Evicted again, it still skips a mutation that it processed before.
  await evictDurableObject(objectOf(workspace));
  client.send({ type: "mutate", mutations: [edit] });
  expect(await client.patch()).toMatchObject({ from: 2, to: 2, changes: [] });
});

it("still closes a socket at the end of its life after the object was evicted", async () => {
  const { test, workspace, client } = await connected();

  await evictDurableObject(objectOf(workspace));
  test.advance(socketLifetimeMs);
  client.mutate("post.create", { id: newId(), partId: newId(), text: "Late" });

  expect(await client.closed).toMatchObject({ code: syncCloseCodes.reconnect });
});

it("turns away a socket that was opened before the server changed versions", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  // A deploy can replace the code of an object while its sockets stay
  // open. The versions are constants, so the test changes what the sockets
  // remember instead: as if they were opened under the version before.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    for (const socket of state.getWebSockets()) {
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        schemaVersion: syncSchemaVersion - 1,
      });
    }
  });

  // One of them sends a mutation, written for the mutators it knows.
  client.mutate("post.create", { id: newId(), partId: newId(), text: "Old" });

  expect(await client.next()).toMatchObject({
    type: "error",
    code: "version_mismatch",
    schemaVersion: syncSchemaVersion,
  });
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
  // It was not run. And the other is not sent rows that it may not
  // understand: it is turned away when the next change would go to it.
  const fresh = new SyncClient();
  expect(await fresh.connect(browser, workspace)).toMatchObject({ to: 0 });
  await createPost(fresh, "New");
  expect(await other.next()).toMatchObject({
    type: "error",
    code: "version_mismatch",
  });
  expect(other.unread).toBe(0);
});

it("ignores what arrives on a socket after it was closed for an error", async () => {
  const { browser, workspace, client } = await connected();

  // Both are on their way before the server has answered the first.
  client.sendFrame("not JSON");
  client.mutate("post.create", { id: newId(), partId: newId(), text: "Late" });

  expect(await client.next()).toMatchObject({ code: "invalid_message" });
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.error });
  // The client was told to start over, and does so from where the server
  // says it is: the mutation was not run behind its back.
  const hello = await client.connect(browser, workspace);
  expect(hello).toMatchObject({ to: 0, lastMutationId: 0 });
});

it("counts a mutation that fails on the server as processed, and keeps the reason to itself", async () => {
  const { workspace, client } = await connected();
  const logged = expectErrors();
  // A mutator with a bug: it writes a row that breaks a rule of the
  // database. No mutator does that today, so a trigger makes up a rule.
  // SQLite reports what a trigger raises as the violation of a constraint.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    state.storage.sql.exec(
      `create trigger refuse_long_text before insert on post_part
       when length(new.text) > 5
       begin select raise(abort, 'secret detail'); end`,
    );
  });
  const short = { id: newId(), partId: newId(), text: "Short" };

  client.send({
    type: "mutate",
    mutations: [
      client.mutation("post.create", {
        id: newId(),
        partId: newId(),
        text: "Too long",
      }),
      client.mutation("post.create", short),
    ],
  });
  const patch = await client.patch();

  // Sent again, it would fail again, and nothing after it would ever get
  // through. So it is done with, and the mutation after it ran.
  expect(patch.lastMutationId).toBe(2);
  expect(patch.rejected).toEqual([
    { id: 1, code: "internal_error", message: "Something went wrong" },
  ]);
  // The post of the failed mutation was written before its part was
  // refused. It is gone again.
  expect(client.table("post").map(({ id }) => id)).toEqual([short.id]);
  // What went wrong is for the logs, not for the client.
  expect(client.received.join("\n")).not.toContain("secret detail");
  expect(String(logged.mock.calls[0]?.[0])).toContain("secret detail");
});

it.each([
  [
    "it hands the database something that is not a row",
    async () => {
      // Fails in the code that stores rows, before the database is asked.
      const bug = vi
        .spyOn(mutators["post.create"], "apply")
        .mockImplementationOnce((tx) => tx.put("post", undefined as never));
      onTestFinished(() => bug.mockRestore());
    },
  ],
  [
    "it writes a value that the database cannot hold",
    async (workspace: string) => {
      // No mutator writes one today, so a trigger makes the value: a blob
      // larger than SQLite takes. SQLite reports it with a result code of
      // its own, which is not a violated constraint.
      await runInDurableObject(objectOf(workspace), (_, state) => {
        state.storage.sql.exec(
          `create trigger too_big before insert on post_part
           when new.text = 'Bug'
           begin select zeroblob(3000000000); end`,
        );
      });
    },
  ],
])(
  "rejects for good the mutation of a mutator with a bug: %s",
  async (_name, plant) => {
    const { workspace, client } = await connected();
    const logged = expectErrors();
    await plant(workspace);
    const fine = { id: newId(), partId: newId(), text: "Fine" };

    client.send({
      type: "mutate",
      mutations: [
        client.mutation("post.create", {
          id: newId(),
          partId: newId(),
          text: "Bug",
        }),
        client.mutation("post.create", fine),
      ],
    });
    const patch = await client.patch();

    // Not a failure of the database, which would close the socket and have
    // the client send both again, with the same end, for ever. The first
    // is done with, and the one after it gets through.
    expect(patch.lastMutationId).toBe(2);
    expect(patch.rejected).toEqual([
      { id: 1, code: "internal_error", message: "Something went wrong" },
    ]);
    expect(client.table("post").map(({ id }) => id)).toEqual([fine.id]);
    expect(logged).toHaveBeenCalled();
  },
);

it.each([
  ["database or disk is full: SQLITE_FULL", true],
  ["disk I/O error: SQLITE_IOERR (extended: SQLITE_IOERR_WRITE)", true],
  // About what was written, so the same again next time.
  ["string or blob too big: SQLITE_TOOBIG", false],
  [
    "NOT NULL constraint failed: post_part.text: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)",
    false,
  ],
  // What a trigger raises ends with the code of a constraint, whatever its
  // message says: text that a row carries cannot pass for a failure.
  [
    "database or disk is full: SQLITE_FULL: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
    false,
  ],
  // Thrown before the database was asked: no result code at all.
  ["Cannot read properties of undefined (reading 'id')", false],
])("tells whether the database failed by itself: %s", (message, failed) => {
  expect(isDatabaseFailure(new Error(message))).toBe(failed);
});

it("processes nothing of a message when the database fails under a mutator", async () => {
  const { browser, workspace, client } = await connected();
  const logged = expectErrors();
  // A database that fails for a reason of its own: it is full. Nothing is
  // wrong with the mutation, and later it would work. A test cannot fill
  // the database, so the write of one row fails the way SQLite reports it.
  const full = await runInDurableObject(objectOf(workspace), (_, state) => {
    const { sql } = state.storage;
    const exec = sql.exec.bind(sql);
    return vi.spyOn(sql, "exec").mockImplementation((query, ...bindings) => {
      if (query.includes('"post_part"') && bindings.includes("Second")) {
        throw new Error("database or disk is full: SQLITE_FULL");
      }
      return exec(query, ...bindings);
    });
  });
  onTestFinished(() => full.mockRestore());
  const mutations = [
    // Rejected, for good reason: there is no such part.
    client.mutation("part.setText", { id: newId(), text: "Nowhere" }),
    client.mutation("post.create", {
      id: newId(),
      partId: newId(),
      text: "First",
    }),
    client.mutation("post.create", {
      id: newId(),
      partId: newId(),
      text: "Second",
    }),
  ];

  client.send({ type: "mutate", mutations });

  // Not a rejection, which would be final and lose the third mutation for
  // a reason that passes. The client is told to try again.
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.failure });
  expect(logged).toHaveBeenCalled();
  // Nothing of the message is processed, also not the mutations before the
  // one that failed: neither what the second wrote is there, nor a word
  // about the first being rejected.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) => ({
    posts: state.storage.sql.exec("select id from post").toArray(),
    clients: state.storage.sql.exec("select * from client_mutation").toArray(),
    rejections: state.storage.sql.exec("select * from rejection").toArray(),
  }));
  expect(stored).toEqual({ posts: [], clients: [], rejections: [] });

  // The failure passes, and the client sends the same mutations again.
  full.mockRestore();
  expect(await client.connect(browser, workspace)).toMatchObject({
    to: 0,
    lastMutationId: 0,
  });
  client.send({ type: "mutate", mutations });
  const patch = await client.patch();

  expect(patch).toMatchObject({ to: 2, lastMutationId: 3 });
  expect(patch.rejected.map(({ id }) => id)).toEqual([1]);
  expect(
    client
      .table("post_part")
      .map(({ text }) => text)
      .sort(),
  ).toEqual(["First", "Second"]);
});

it("processes nothing of a message when it cannot keep its books", async () => {
  const { workspace, client } = await connected();
  const logged = expectErrors();
  // The object writes down which rows a mutation changed after the mutator
  // has run. Without the table for it, that fails.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    state.storage.sql.exec("drop table change_log");
  });

  client.mutate("post.create", { id: newId(), partId: newId(), text: "Lost" });

  // The client gets no answer to wait for: it is told to start over.
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.failure });
  expect(logged).toHaveBeenCalled();
  // What the mutator wrote is undone, and the mutation does not count as
  // processed, so a client that sends it again is not ignored.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) => ({
    posts: state.storage.sql.exec("select id from post").toArray(),
    clients: state.storage.sql.exec("select * from client_mutation").toArray(),
  }));
  expect(stored).toEqual({ posts: [], clients: [] });
});

it("closes every socket when it cannot work out what a mutation changed after it is committed", async () => {
  const { browser, workspace, client } = await connected();
  const other = new SyncClient();
  await other.connect(browser, workspace);
  const logged = expectErrors();
  // The fault: for once, the object cannot read what has changed. The next
  // time it asks is for the patch of the mutation below, which it does
  // when the mutation is committed.
  const fault = vi
    .spyOn(WorkspaceStore.prototype, "changesSince")
    .mockImplementationOnce(() => {
      throw new Error("The database cannot be read");
    });
  onTestFinished(() => fault.mockRestore());
  const create = client.mutation("post.create", {
    id: newId(),
    partId: newId(),
    text: "Committed",
  });

  client.send({ type: "mutate", mutations: [create] });

  // Also the client that sent nothing. Left open without the change, it
  // would go on getting pongs and have no reason to ask for anything.
  expect(await client.closed).toMatchObject({ code: syncCloseCodes.failure });
  expect(await other.closed).toMatchObject({ code: syncCloseCodes.failure });
  expect(logged).toHaveBeenCalled();
  // Both get the change from their cursors when they connect again.
  expect(await other.connect(browser, workspace)).toMatchObject({
    from: 0,
    to: 1,
  });
  expect(await client.connect(browser, workspace)).toMatchObject({
    from: 0,
    to: 1,
    lastMutationId: create.id,
  });
  // A client that did not look at that answer sends the mutation again,
  // because it cannot know that it was processed. It is skipped.
  client.send({ type: "mutate", mutations: [create] });
  expect(await client.patch()).toMatchObject({
    from: 1,
    to: 1,
    changes: [],
    rejected: [],
  });
  expect(other.copy).toEqual(client.copy);
  expect(client.table("post")).toHaveLength(1);
});

it("sends a change to the other sockets when it cannot send it to one", async () => {
  const { browser, workspace } = await start();
  const clients = [new SyncClient(), new SyncClient(), new SyncClient()];
  for (const client of clients) await client.connect(browser, workspace);
  // The order in which the object goes through its sockets. The fault is
  // with the first of them: if it stopped the object there, the two after
  // it would get nothing.
  const order = await runInDurableObject(objectOf(workspace), (_, state) =>
    state
      .getWebSockets()
      .map((socket): string => socket.deserializeAttachment().clientId),
  );
  const [unlucky, author, reader] = order.map((id) =>
    clients.find((client) => client.clientId === id),
  );
  if (!unlucky || !author || !reader) throw new Error("A socket is missing");
  const logged = expectErrors();
  // The fault: what the object reads to make the patch of one client fails.
  const lastMutationId = WorkspaceStore.prototype.lastMutationId;
  const fault = vi
    .spyOn(WorkspaceStore.prototype, "lastMutationId")
    .mockImplementation(function (this: WorkspaceStore, clientId) {
      if (clientId === unlucky.clientId) {
        throw new Error("The database cannot be read");
      }
      return lastMutationId.call(this, clientId);
    });
  onTestFinished(() => fault.mockRestore());

  await createPost(author, "Hello");

  expect(await reader.patch()).toMatchObject({ from: 0, to: 1 });
  // The one that was left out is not left open: it connects again and gets
  // the change from its cursor.
  expect(await unlucky.closed).toMatchObject({ code: syncCloseCodes.failure });
  expect(logged).toHaveBeenCalled();
  fault.mockRestore();
  expect(await unlucky.connect(browser, workspace)).toMatchObject({
    from: 0,
    to: 1,
  });
  expect(unlucky.copy).toEqual(author.copy);
});
