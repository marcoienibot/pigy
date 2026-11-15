import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  maxPartTextLength,
  pingMessageText,
  syncCloseCodes,
  syncLimits,
  syncProtocolVersion,
  syncSchemaVersion,
} from "@pigy/core";
import { expect, it, onTestFinished, vi } from "vitest";
import { socketLifetimeMs } from "../src/workspace/object.ts";
import { changeLogWindow } from "../src/workspace/store.ts";
import { mutateWorkspace } from "../src/workspace/workspaces.ts";
import { adminEmail, setup, signedIn } from "./helpers.ts";
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

/** Keeps what the object logs out of the test output and returns it. */
function expectErrors() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  return error;
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
    post: [{ id: postId, status: "draft", createdAt, updatedAt: createdAt }],
    post_part: [{ id: partId, postId, position: 0, text: "Hello" }],
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
    { id: 2, code: "not_found", message: "This post no longer exists" },
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
      { id: client.nextMutationId++, name: "post.publish", args: {} },
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
    { id: partId, postId, position: 0, text: "From the API" },
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
    message: "This post no longer exists",
  });
  // The clients hear nothing of it: the next thing this one receives is
  // the next change.
  await createPost(client, "Hello");
  expect(client.cursor).toBe(1);
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
  // A mutator that fails for a reason of the server's own: the database
  // refuses what it writes. No mutator does that today, so a trigger does.
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
  expect(String(logged.mock.calls[0]?.[1])).toContain("secret detail");
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
  expect(await client.closed).toMatchObject({ code: 1011 });
  expect(logged).toHaveBeenCalled();
  // What the mutator wrote is undone, and the mutation does not count as
  // processed, so a client that sends it again is not ignored.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) => ({
    posts: state.storage.sql.exec("select id from post").toArray(),
    clients: state.storage.sql.exec("select * from client_mutation").toArray(),
  }));
  expect(stored).toEqual({ posts: [], clients: [] });
});
