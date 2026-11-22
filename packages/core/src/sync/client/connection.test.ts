import { expect, it } from "vitest";
import {
  browser,
  draft,
  newId,
  patch,
  settle,
} from "../../../test/sync-browser.ts";
import {
  pingMessageText,
  pongMessageText,
  syncCloseCodes,
  syncLimits,
  syncProtocolVersion,
  syncSchemaVersion,
} from "../protocol.ts";
import { unscheduled } from "../tables.ts";
import { syncTimings } from "./connection.ts";
import { appendMutations, type Head, type Step } from "./copy.ts";
import type { SyncStore } from "./store.ts";

/** The texts of the parts that `store` shows, in no particular order. */
function texts(store: SyncStore): string[] {
  return [...store.getView().post_part.values()].map(({ text }) => text).sort();
}

/** An `error` message of a server that speaks the versions given. */
function error(code: string, versions = {}) {
  return {
    type: "error",
    code,
    message: "For developers",
    protocolVersion: syncProtocolVersion,
    schemaVersion: syncSchemaVersion,
    ...versions,
  };
}

/** A tab that holds the socket and has applied the answer to its hello. */
async function online(device = browser()) {
  const tab = await device.holder();
  await tab.socket.send(patch({ from: null, to: 0 }));
  expect(tab.store.getState().connection).toBe("online");
  return { device, ...tab };
}

/**
 * Holds back the next write to the storage of `device` until the function
 * that is returned is called. The writes that are made in the meantime are
 * not held: they pass it, as they pass a write that waits behind other
 * work of its tab.
 */
function holdNextWrite(device: ReturnType<typeof browser>): () => void {
  const { storage } = device;
  const { update } = storage;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  storage.update = (step, options) => {
    storage.update = update;
    return held.then(() => update(step, options));
  };
  return release;
}

/**
 * What a tab with the next version of the app does to the copy when it
 * opens it, as SYNC.md section 6 says: the rows go, and the copy is of the
 * new schema.
 */
function migrate(head: Head | undefined): Step<void> {
  if (!head) throw new Error("The copy exists");
  return {
    write: {
      meta: {
        ...head.meta,
        cursor: null,
        schemaVersion: syncSchemaVersion + 1,
        version: head.meta.version + 1,
      },
      rows: { clear: true, changes: [] },
    },
    result: undefined,
  };
}

it("says hello as a client that has nothing, then as one that knows where it is", async () => {
  const device = browser();
  const first = await device.holder();
  const { clientId } = first.store.head.meta;

  expect(first.socket.sent).toEqual([
    {
      type: "hello",
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
      clientId,
      cursor: null,
      lastMutationId: 0,
    },
  ]);
  expect(first.store.getState().connection).toBe("connecting");

  // The server has a draft, and has processed two mutations of this client.
  first.store.mutate("post.delete", { id: newId() });
  first.store.mutate("post.delete", { id: newId() });
  await settle();
  await first.socket.send(
    patch({
      from: null,
      to: 7,
      changes: draft("Hi").puts(),
      lastMutationId: 2,
    }),
  );
  expect(first.store.getState().connection).toBe("online");
  first.connection.stop();
  first.store.close();

  // After a restart, the copy is where the last patch left it.
  const second = await device.holder();
  expect(second.socket.sent).toEqual([
    {
      type: "hello",
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
      clientId,
      cursor: 7,
      lastMutationId: 2,
    },
  ]);
  expect(texts(second.store)).toEqual(["Hi"]);
});

it("sends the outbox once the hello is answered, and drops a mutation when a patch confirms it", async () => {
  const device = browser();
  const { store, socket } = await device.holder();
  const id = newId();
  const partId = newId();
  store.mutate("post.create", { id, partId, text: "Hello" });
  await settle();
  // Nothing before the answer to the hello: until then the client does not
  // know which of its mutations the server has.
  expect(socket.mutates).toEqual([]);

  await socket.send(patch({ from: null, to: 0 }));
  expect(socket.mutates).toEqual([
    [{ id: 1, name: "post.create", args: { id, partId, text: "Hello" } }],
  ]);
  expect(store.getState().pending).toBe(1);

  // A patch that is not about the mutation leaves it pending.
  const other = draft("From elsewhere");
  await socket.send(patch({ from: 0, to: 1, changes: other.puts() }));
  expect(store.getState().pending).toBe(1);
  expect(texts(store)).toEqual(["From elsewhere", "Hello"]);

  // The answer: the rows as the server made them, with the server's time,
  // and the news that mutation 1 is processed.
  await socket.send(
    patch({
      from: 1,
      to: 2,
      lastMutationId: 1,
      changes: [
        {
          op: "put",
          table: "post",
          row: {
            id,
            status: "draft",
            createdAt: 99,
            updatedAt: 99,
            ...unscheduled,
          },
        },
        {
          op: "put",
          table: "post_part",
          row: {
            id: partId,
            postId: id,
            targetId: null,
            position: 0,
            text: "Hello",
          },
        },
      ],
    }),
  );
  expect(store.getState().pending).toBe(0);
  expect(store.head.outbox).toEqual([]);
  expect(store.head.meta).toMatchObject({ cursor: 2, lastMutationId: 1 });
  // The server's row has replaced the one that the client made for display.
  expect(store.getView().post.get(id)?.createdAt).toBe(99);
});

it("goes back to the server's rows when a mutation is rejected, and says which", async () => {
  const { store, socket } = await online();
  const { post, part, puts } = draft("Server");
  await socket.send(patch({ from: 0, to: 1, changes: puts() }));

  store.mutate("part.setText", { id: part.id, text: "Mine" });
  await settle();
  expect(texts(store)).toEqual(["Mine"]);

  // The post was scheduled on another device in the meantime.
  await socket.send(
    patch({
      from: 1,
      to: 2,
      lastMutationId: 1,
      changes: [
        { op: "put", table: "post", row: { ...post, status: "scheduled" } },
      ],
      rejected: [
        { id: 1, code: "not_a_draft", message: "Only a draft can be edited" },
      ],
    }),
  );

  expect(texts(store)).toEqual(["Server"]);
  expect(store.getState().pending).toBe(0);
  expect(store.getRejections()).toEqual([
    {
      key: `${store.head.meta.clientId}/1`,
      name: "part.setText",
      args: { id: part.id, text: "Mine" },
      code: "not_a_draft",
      message: "Only a draft can be edited",
    },
  ]);
});

it("applies a patch of several messages as one step", async () => {
  const { store, socket } = await online();
  const one = draft("One");
  const two = draft("Two");

  await socket.send(patch({ from: 0, to: 4, changes: one.puts(), more: true }));
  // Half a patch is not a state that the server was ever in.
  expect(texts(store)).toEqual([]);
  expect(store.head.meta.cursor).toBe(0);

  await socket.send(patch({ from: 0, to: 4, changes: two.puts() }));
  expect(texts(store)).toEqual(["One", "Two"]);
  expect(store.head.meta.cursor).toBe(4);
});

it("replaces its rows with a snapshot", async () => {
  const { store, socket } = await online();
  await socket.send(patch({ from: 0, to: 1, changes: draft("Old").puts() }));

  // What a client gets that is too far behind for the change log, here in
  // answer to nothing, which the protocol does not forbid.
  await socket.send(
    patch({ from: null, to: 2000, changes: draft("New").puts() }),
  );

  expect(texts(store)).toEqual(["New"]);
  expect(store.head.meta.cursor).toBe(2000);
});

it("connects again when it has missed a patch", async () => {
  const { device, store, socket } = await online();
  await socket.send(patch({ from: 0, to: 1, changes: draft("One").puts() }));

  // The patch from 1 to 2 never arrived.
  await socket.send(patch({ from: 2, to: 3, changes: draft("Three").puts() }));

  expect(socket.closed).toBe(true);
  expect(texts(store)).toEqual(["One"]);
  // A new socket, at once, whose hello asks for what follows cursor 1.
  expect(device.sockets).toHaveLength(2);
  await device.socket.open();
  expect(device.socket.sent).toEqual([
    expect.objectContaining({ type: "hello", cursor: 1 }),
  ]);
});

it("sends its unconfirmed mutations again after a lost socket, under the same IDs", async () => {
  const { device, store, socket } = await online();
  const first = newId();
  store.mutate("post.delete", { id: first });
  await settle();
  expect(socket.mutates).toHaveLength(1);
  // The socket is lost before the answer. A mutation that is made while
  // there is no socket waits in the outbox.
  await socket.close(1006);
  const second = newId();
  store.mutate("post.delete", { id: second });
  await settle();
  expect(store.getState().connection).toBe("offline");

  await device.advance(syncTimings.retry[0]);
  await device.socket.open();
  // The server did get the first one: the answer to the hello says so.
  await device.socket.send(patch({ from: 0, to: 0, lastMutationId: 1 }));

  // Only the second is sent. Had the answer said 0, both would be.
  expect(device.socket.mutates).toEqual([
    [{ id: 2, name: "post.delete", args: { id: second } }],
  ]);
  expect(store.getState()).toMatchObject({ connection: "online", pending: 1 });
});

it("sends a mutation again that the server has not seen", async () => {
  const { device, store, socket } = await online();
  const id = newId();
  store.mutate("post.delete", { id });
  await settle();
  await socket.close(syncCloseCodes.failure);

  await device.advance(syncTimings.retry[0]);
  await device.socket.open();
  await device.socket.send(patch({ from: 0, to: 0, lastMutationId: 0 }));

  // The same mutation under the same ID: if the server did process it
  // after all, it skips it.
  expect(device.socket.mutates).toEqual(socket.mutates);
  expect(device.socket.mutates).toEqual([
    [{ id: 1, name: "post.delete", args: { id } }],
  ]);
});

it("has one mutate on its way at a time, and sends what was typed meanwhile as one mutation", async () => {
  const { store, socket } = await online();
  const { part, puts } = draft("");
  await socket.send(patch({ from: 0, to: 1, changes: puts() }));

  store.mutate("part.setText", { id: part.id, text: "H" });
  await settle();
  for (const text of ["He", "Hel", "Hell", "Hello"]) {
    store.mutate("part.setText", { id: part.id, text });
    await settle();
  }

  // The first is on its way, and may have reached the server. The others
  // wait, and have become one.
  expect(socket.mutates).toEqual([
    [{ id: 1, name: "part.setText", args: { id: part.id, text: "H" } }],
  ]);
  expect(store.head.outbox.map(({ id }) => id)).toEqual([1, 2]);
  expect(texts(store)).toEqual(["Hello"]);

  await socket.send(
    patch({ from: 1, to: 2, changes: puts("H"), lastMutationId: 1 }),
  );
  expect(socket.mutates[1]).toEqual([
    { id: 2, name: "part.setText", args: { id: part.id, text: "Hello" } },
  ]);
  // The server's "H" is under the text that is still pending.
  expect(texts(store)).toEqual(["Hello"]);
});

it("sends a long outbox in messages of at most 100 mutations", async () => {
  const device = browser();
  const { store, socket } = await device.holder();
  const count = syncLimits.mutationsPerMessage + 5;
  for (let index = 0; index < count; index += 1) {
    store.mutate("post.delete", { id: newId() });
  }
  await settle();

  await socket.send(patch({ from: null, to: 0 }));
  expect(socket.mutates.map((mutations) => mutations.length)).toEqual([
    syncLimits.mutationsPerMessage,
  ]);

  await socket.send(
    patch({ from: 0, to: 0, lastMutationId: syncLimits.mutationsPerMessage }),
  );
  expect(socket.mutates.map((mutations) => mutations.length)).toEqual([
    syncLimits.mutationsPerMessage,
    5,
  ]);
  expect(socket.mutates[1]?.[0]?.id).toBe(syncLimits.mutationsPerMessage + 1);
});

it("starts over when the server no longer knows the mutations that it confirmed", async () => {
  const { device, store, socket } = await online();
  const { clientId } = store.head.meta;
  store.mutate("post.delete", { id: newId() });
  await settle();
  await socket.send(patch({ from: 0, to: 0, lastMutationId: 1 }));
  await socket.close(1006);
  // Made while there is no socket: mutation 2.
  const id = newId();
  const partId = newId();
  store.mutate("post.create", { id, partId, text: "Kept" });
  await settle();

  // The server was restored to a state in which this client has sent
  // nothing. It expects mutation 1, which the client no longer has.
  await device.advance(syncTimings.retry[0]);
  const second = device.socket;
  await second.open();
  const restored = draft("Restored");
  await second.send(
    patch({ from: null, to: 3, changes: restored.puts(), lastMutationId: 0 }),
  );

  // It sends nothing on this socket: mutation 2 would be a gap, every time.
  expect(second.mutates).toEqual([]);
  expect(second.closed).toBe(true);
  // It connects again as a new client that has nothing.
  expect(device.sockets).toHaveLength(3);
  await device.socket.open();
  const [hello] = device.socket.sent;
  expect(hello).toMatchObject({ cursor: null, lastMutationId: 0 });
  expect(hello).not.toMatchObject({ clientId });
  expect(store.head.meta.clientId).not.toBe(clientId);

  // The mutation that was left is number 1 of the new client.
  await device.socket.send(
    patch({ from: null, to: 3, changes: restored.puts(), lastMutationId: 0 }),
  );
  expect(device.socket.mutates).toEqual([
    [{ id: 1, name: "post.create", args: { id, partId, text: "Kept" } }],
  ]);
  expect(texts(store)).toEqual(["Kept", "Restored"]);
});

it("connects again after the error mutation_gap, and lets the hello decide", async () => {
  const { device, store, socket } = await online();
  store.mutate("post.delete", { id: newId() });
  await settle();

  await socket.send(error("mutation_gap"));

  // At once, not after a pause: the answer to the hello is what says
  // whether the client can go on.
  expect(device.sockets).toHaveLength(2);
  await device.socket.open();
  await device.socket.send(patch({ from: 0, to: 0, lastMutationId: 0 }));
  // The server expects mutation 1 and the client has it, so it is sent.
  expect(device.socket.mutates.map((mutations) => mutations[0]?.id)).toEqual([
    1,
  ]);
  expect(store.getState().connection).toBe("online");
});

it("starts over when the server has processed a mutation that it never made", async () => {
  const device = browser();
  const { store, socket } = await device.holder();
  const { clientId } = store.head.meta;
  store.mutate("post.delete", { id: newId() });
  await settle();

  // The server has processed three mutations of this client ID, and this
  // copy has made one: another copy has used the ID, or this one has lost
  // what it knew.
  await socket.send(patch({ from: null, to: 5, lastMutationId: 3 }));

  expect(store.head.meta.clientId).not.toBe(clientId);
  // Its mutation 1 is not the one that the server ran under that ID, and
  // it will never run: the patch took it for confirmed.
  expect(store.head.outbox).toEqual([]);
  expect(store.getState().pending).toBe(0);
  expect(device.sockets).toHaveLength(2);
  await device.socket.open();
  expect(device.socket.sent[0]).toMatchObject({
    clientId: store.head.meta.clientId,
    cursor: null,
    lastMutationId: 0,
  });
});

it("does not connect again when another socket has taken its place", async () => {
  const { device, store, socket, running } = await online();
  let ended = false;
  void running.then(() => {
    ended = true;
  });

  await socket.close(syncCloseCodes.replaced);
  await device.advance(10 * 60_000);

  // No new socket, ever: it would close the one that replaced this one.
  expect(device.sockets).toHaveLength(1);
  expect(store.getState().connection).toBe("replaced");
  // The tab has given the socket up, for another tab to take.
  expect(ended).toBe(true);
});

it("connects again at once when a socket has reached the end of its life", async () => {
  const { device, store, socket } = await online();

  await socket.close(syncCloseCodes.reconnect);

  expect(device.sockets).toHaveLength(2);
  // A routine that happens every few minutes is not shown as a problem.
  expect(store.getState().connection).toBe("online");
  await device.socket.open();
  expect(device.socket.sent[0]).toMatchObject({ type: "hello", cursor: 0 });
});

it("pauses longer after every failure, and starts from the short pause after a success", async () => {
  const { device, store, socket } = await online();

  await socket.close(syncCloseCodes.failure);
  expect(store.getState().connection).toBe("offline");
  expect(device.sockets).toHaveLength(1);

  for (const [index, pause] of syncTimings.retry.entries()) {
    // Not a moment before the pause is over.
    await device.advance(pause - 1);
    expect(device.sockets).toHaveLength(index + 1);
    await device.advance(1);
    expect(device.sockets).toHaveLength(index + 2);
    await device.socket.open();
    await device.socket.close(syncCloseCodes.failure);
  }
  // The longest pause is used from then on.
  const longest = syncTimings.retry.at(-1) ?? 0;
  await device.advance(longest);
  const count = device.sockets.length;
  expect(count).toBe(syncTimings.retry.length + 2);

  // A socket that has lasted until its first ping is a success. An answer
  // to its hello alone is not: the next test says why.
  await device.socket.open();
  await device.socket.send(patch({ from: 0, to: 0 }));
  expect(store.getState().connection).toBe("online");
  await device.advance(syncTimings.pingEvery);
  await device.socket.close(syncCloseCodes.failure);
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(count + 1);
});

it("pauses longer every time the server fails on a mutation that is sent again", async () => {
  const { device, store, socket } = await online();
  store.mutate("post.delete", { id: newId() });
  await settle();
  expect(socket.mutates).toHaveLength(1);
  // The database of the workspace is full, which is the example of SYNC.md
  // for the code 1011: the server answers every hello, and fails on the
  // mutation every time it is sent.
  await socket.close(syncCloseCodes.failure);

  for (const pause of syncTimings.retry.slice(0, 4)) {
    const count = device.sockets.length;
    // Not a moment before the pause is over, which is longer than the one
    // before: the hello that was answered in between is no success.
    await device.advance(pause - 1);
    expect(device.sockets).toHaveLength(count);
    await device.advance(1);
    expect(device.sockets).toHaveLength(count + 1);
    await device.socket.open();
    await device.socket.send(patch({ from: 0, to: 0 }));
    expect(store.getState().connection).toBe("online");
    expect(device.socket.mutates).toHaveLength(1);
    await device.socket.close(syncCloseCodes.failure);
  }

  // The server is well again, and answers the mutation.
  await device.advance(syncTimings.retry[4]);
  await device.socket.open();
  await device.socket.send(patch({ from: 0, to: 0 }));
  await device.socket.send(patch({ from: 0, to: 1, lastMutationId: 1 }));
  expect(store.getState().pending).toBe(0);

  // That is a success: the failure after it is the first one again.
  await device.socket.close(syncCloseCodes.failure);
  const count = device.sockets.length;
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(count + 1);
});

it("asks why a handshake failed, and tells signed out from offline", async () => {
  const device = browser();
  const { store, connection } = await device.tab();
  let ended = false;
  void connection.run().then(() => {
    ended = true;
  });
  await settle();

  // No connection: the question gets no answer either.
  device.network.access = "unknown";
  await device.socket.close(1006);
  expect(device.network.accessChecks).toBe(1);
  expect(store.getState().connection).toBe("offline");
  expect(ended).toBe(false);

  // It tries again, and this time the server says that the session is over.
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(2);
  device.network.access = "signed-out";
  await device.socket.close(1006);

  expect(store.getState().connection).toBe("signed-out");
  expect(ended).toBe(true);
  await device.advance(10 * 60_000);
  expect(device.sockets).toHaveLength(2);
});

it("goes on trying when nobody says why a handshake failed", async () => {
  const device = browser();
  const { store, connection } = await device.tab();
  let ended = false;
  void connection.run().then(() => {
    ended = true;
  });
  await settle();

  // A network that is up and leads nowhere: it takes the question and
  // never answers it.
  device.network.access = "silent";
  await device.socket.close(1006);
  const [question] = device.network.unanswered;
  expect(question?.signal.aborted).toBe(false);
  expect(store.getState().connection).toBe("offline");

  // The client waits for so long and no longer. Then it is as if the
  // answer had been that nobody knows, and the pause begins.
  await device.advance(syncTimings.access - 1);
  expect(question?.signal.aborted).toBe(false);
  await device.advance(1);
  expect(question?.signal.aborted).toBe(true);
  expect(device.sockets).toHaveLength(1);
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(2);

  // The answer comes after all. It is about a handshake that the client
  // has given up on: the socket that it has now may be a good one.
  question?.answer("signed-out");
  await settle();
  expect(ended).toBe(false);
  await device.socket.open();
  await device.socket.send(patch({ from: null, to: 0 }));
  expect(store.getState().connection).toBe("online");
});

it("connects at once when the network is back while it waits to hear why a handshake failed", async () => {
  const device = browser();
  const { store, connection } = await device.tab();
  void connection.run();
  await settle();
  device.network.access = "silent";
  await device.socket.close(1006);
  expect(device.sockets).toHaveLength(1);

  connection.wake();
  await settle();

  // The next handshake is a better question than the one that is open,
  // which the client stops waiting for.
  expect(device.sockets).toHaveLength(2);
  expect(device.network.unanswered[0]?.signal.aborted).toBe(true);
  // What the new socket says is heard: the question that was open does not
  // hold it up.
  await device.socket.open();
  await device.socket.send(patch({ from: null, to: 0 }));
  expect(store.getState().connection).toBe("online");
});

it("gives up on a workspace that is not the user's", async () => {
  const device = browser();
  const { store, connection } = await device.tab();
  void connection.run();
  await settle();

  device.network.access = "no-access";
  await device.socket.close(1006);
  await device.advance(10 * 60_000);

  expect(store.getState().connection).toBe("no-access");
  expect(device.sockets).toHaveLength(1);
});

it("does not ask about access when a socket that was open is lost", async () => {
  const { device, socket } = await online();

  await socket.close(1006);

  // The handshake went through, so the session was good and the workspace
  // was the user's.
  expect(device.network.accessChecks).toBe(0);
});

it("stops when the server speaks a later version, and says that the app is outdated", async () => {
  const device = browser();
  const { store, socket } = await device.holder();

  await socket.send(
    error("version_mismatch", { schemaVersion: syncSchemaVersion + 1 }),
  );
  await socket.close(syncCloseCodes.error);
  await device.advance(10 * 60_000);

  expect(store.getState().outdated).toBe(true);
  // It does not connect before it has updated itself.
  expect(device.sockets).toHaveLength(1);
  expect(device.errors).toEqual([]);
});

it("reads the versions of an error that it cannot read otherwise", async () => {
  const device = browser();
  const { store, socket } = await device.holder();

  // A later protocol may word its errors differently. What a client of
  // this one needs from them is where the versions are.
  await socket.send({
    type: "error",
    code: "version_mismatch",
    protocolVersion: syncProtocolVersion + 1,
    schemaVersion: syncSchemaVersion,
    reason: { text: "A field that this version does not have" },
  });

  expect(store.getState().outdated).toBe(true);
});

it("tries again later when the server speaks an earlier version", async () => {
  const device = browser();
  const { store, socket } = await device.holder();

  // The server is in the middle of an update.
  await socket.send(
    error("version_mismatch", { protocolVersion: syncProtocolVersion - 1 }),
  );

  expect(store.getState()).toMatchObject({
    connection: "offline",
    outdated: false,
  });
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(2);
});

it("gives up a socket that sends what is not a message of the protocol", async () => {
  const { device, store, socket } = await online();

  await socket.send({ type: "patch", from: 0, to: 1, extra: true });

  expect(socket.closed).toBe(true);
  expect(store.getState().connection).toBe("offline");
  expect(store.head.meta.cursor).toBe(0);
  expect(device.errors).toHaveLength(1);
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(2);
});

it("gives up a socket that does not answer its hello", async () => {
  const device = browser();
  const { store, socket } = await device.holder();

  await device.advance(syncTimings.answer - 1);
  expect(socket.closed).toBe(false);
  await device.advance(1);

  expect(socket.closed).toBe(true);
  expect(store.getState().connection).toBe("offline");
});

it("gives up a socket that does not answer a mutate", async () => {
  const { device, store, socket } = await online();
  store.mutate("post.delete", { id: newId() });
  await settle();

  // A patch that is not the answer does not count as one.
  await device.advance(syncTimings.answer - 1);
  await socket.send(patch({ from: 0, to: 1, changes: draft("Other").puts() }));
  await device.advance(1);

  expect(socket.closed).toBe(true);
  expect(store.getState()).toMatchObject({ connection: "offline", pending: 1 });
});

it("pings a quiet socket and gives it up when no answer comes", async () => {
  const { device, store, socket } = await online();

  await device.advance(syncTimings.pingEvery);
  // Spelled exactly like this, the server answers it without waking the
  // workspace up.
  expect(socket.frames.at(-1)).toBe(pingMessageText);
  await socket.send(pongMessageText);
  // Answered: the socket stays, well past the time a pong may take.
  await device.advance(syncTimings.pong);
  expect(socket.closed).toBe(false);

  // The next ping gets no answer.
  await device.advance(syncTimings.pingEvery);
  expect(socket.closed).toBe(true);
  expect(store.getState().connection).toBe("offline");
});

it("connects at once when it is told that the network is back", async () => {
  const { device, socket, connection } = await online();
  await socket.close(1006);
  expect(device.sockets).toHaveLength(1);

  connection.wake();
  await settle();

  expect(device.sockets).toHaveLength(2);
  // The pause that was on is off: no second attempt when it would have
  // ended.
  await device.advance(syncTimings.retry[0]);
  expect(device.sockets).toHaveLength(2);
});

it("checks a socket that seems open when it is told that the network has changed", async () => {
  const { device, socket, connection } = await online();

  connection.wake();
  expect(socket.frames.at(-1)).toBe(pingMessageText);

  await device.advance(syncTimings.pong);
  expect(socket.closed).toBe(true);
});

it("connects at once when a tab without the socket says that the network has changed", async () => {
  const { device, socket } = await online();
  const other = await device.tab();
  await socket.close(1006);
  expect(device.sockets).toHaveLength(1);

  // The tab in front is the one that a person looks at, and that a
  // browser lets run. It has no socket to connect, so it asks the tab that
  // has, which may be in the background.
  other.store.wakeHolder();
  await settle();

  expect(device.sockets).toHaveLength(2);
});

it("finds a mutation that a tab has stored without telling anybody, and sends it", async () => {
  const { device, store, socket } = await online();
  const id = newId();
  // What a tab leaves behind that is closed right after a change: the
  // mutation is in the stored outbox, and the message to the other tabs
  // never left.
  await device.storage.update((head) => {
    if (!head) throw new Error("The copy exists");
    return appendMutations(head, [
      { name: "post.delete", args: { id }, at: 0 },
    ]);
  });
  await settle();
  expect(socket.mutates).toEqual([]);

  // Nobody writes after that, so no later message gives the missing one
  // away. The tab with the socket looks by itself, as often as it pings.
  await device.advance(syncTimings.pingEvery);

  expect(socket.mutates).toEqual([
    [{ id: 1, name: "post.delete", args: { id } }],
  ]);
  expect(store.getState().pending).toBe(1);
});

it("looks for what other tabs have stored when it is told that the network has changed", async () => {
  const { device, socket, connection } = await online();
  const id = newId();
  await device.storage.update((head) => {
    if (!head) throw new Error("The copy exists");
    return appendMutations(head, [
      { name: "post.delete", args: { id }, at: 0 },
    ]);
  });

  // Also what a tab does that comes to the front: its timers may not have
  // run for a while.
  connection.wake();
  await settle();

  expect(socket.mutates).toEqual([
    [{ id: 1, name: "post.delete", args: { id } }],
  ]);
});

it("writes nothing for a socket that it has given up, however late the storage gets to it", async () => {
  const device = browser();
  const one = await online(device);
  const firstClientId = one.store.head.meta.clientId;
  // The server has processed two mutations of this copy.
  one.store.mutate("post.delete", { id: newId() });
  one.store.mutate("post.delete", { id: newId() });
  await settle();
  await one.socket.send(patch({ from: 0, to: 0, lastMutationId: 2 }));
  const two = await device.tab();

  // A snapshot arrives in the first tab, and its write has to wait. Before
  // the storage gets to it, the tab gives the socket up.
  const release = holdNextWrite(device);
  await one.socket.send(
    patch({
      from: null,
      to: 9,
      changes: draft("Late").puts(),
      lastMutationId: 2,
    }),
  );
  one.connection.stop();

  // The second tab takes the socket over, with an edit of its own, which
  // is mutation 3 of the copy.
  const id = newId();
  const partId = newId();
  two.store.mutate("post.create", { id, partId, text: "Kept" });
  await settle();
  void two.connection.run();
  await settle();
  await device.socket.open();
  // It meets a server that was restored to a state in which this client
  // has sent nothing, so the copy starts over: the edit is mutation 1 of a
  // new client.
  await device.socket.send(patch({ from: null, to: 3, lastMutationId: 0 }));
  const { clientId } = two.store.head.meta;
  expect(clientId).not.toBe(firstClientId);
  expect(two.store.head.outbox.map((mutation) => mutation.id)).toEqual([1]);

  // Now the storage gets to the snapshot of the first tab. Written, it
  // would say that the server has processed two mutations of a client that
  // has made one. The copy would start over once more, this time without
  // the edit: it would be taken for one that the server has processed.
  release();
  await settle();

  expect((await device.storage.read())?.head).toMatchObject({
    meta: { clientId, cursor: null, lastMutationId: 0 },
    outbox: [{ id: 1, name: "post.create" }],
  });
  expect(texts(two.store)).toEqual(["Kept"]);
  // The edit reaches the server, on the socket of the copy that started
  // over.
  await device.socket.open();
  await device.socket.send(patch({ from: null, to: 3, lastMutationId: 0 }));
  expect(device.socket.mutates).toEqual([
    [{ id: 1, name: "post.create", args: { id, partId, text: "Kept" } }],
  ]);
  expect(device.errors).toEqual([]);
});

it("stops, and writes nothing, when a newer version of the app has taken the copy to its schema", async () => {
  const { device, store, socket, running } = await online();
  await socket.send(patch({ from: 0, to: 1, changes: draft("Old").puts() }));
  let ended = false;
  void running.then(() => {
    ended = true;
  });

  // A tab with the next version of the app opens the copy. This tab has
  // not heard of it: the message is on its way, or was never sent.
  await device.storage.update(migrate);
  // A snapshot of the old schema arrives on the socket that this tab
  // still holds.
  await socket.send(
    patch({ from: null, to: 7, changes: draft("Late").puts() }),
  );

  // Stored, it would leave rows of the old schema in a copy of the new
  // one, and a cursor that keeps the new version from asking for all rows.
  const stored = await device.storage.read();
  expect(stored?.rows).toEqual([]);
  expect(stored?.head.meta).toMatchObject({
    cursor: null,
    schemaVersion: syncSchemaVersion + 1,
  });
  // The tab says that it has to be loaded again, and gives the socket up
  // for a tab that can use it.
  expect(store.getState().outdated).toBe(true);
  expect(socket.closed).toBe(true);
  expect(ended).toBe(true);
  await device.advance(10 * 60_000);
  expect(device.sockets).toHaveLength(1);
  expect(device.errors).toEqual([]);
});

it("stops when another tab tells it of a write of a newer schema", async () => {
  const { device, store, socket, running } = await online();
  let ended = false;
  void running.then(() => {
    ended = true;
  });

  // The tab with the next version of the app says what it did to the copy.
  const { write } = await device.storage.update(migrate);
  if (!write) throw new Error("Migrating is a write");
  device.tabs.join().post({ type: "write", write });
  await settle();

  // That is enough: this tab does not have to touch the copy to find out.
  expect(store.getState().outdated).toBe(true);
  expect(socket.closed).toBe(true);
  expect(ended).toBe(true);
  await device.advance(10 * 60_000);
  expect(device.sockets).toHaveLength(1);
});

it("does not take the socket in a tab that is too old for the copy", async () => {
  const device = browser();
  const first = await device.tab();
  await device.storage.update(migrate);
  // It finds out between opening the copy and getting the socket, for
  // which it may have waited in line behind other tabs.
  await first.store.reload();
  expect(first.store.getState().outdated).toBe(true);

  await first.connection.run();

  // The promise has resolved: the tab is out of the line again.
  expect(device.sockets).toEqual([]);
  expect(first.store.getState().connection).toBe("connecting");
});

it("closes the socket and stays away when it is stopped", async () => {
  const device = browser();
  const { store, connection } = await device.tab();
  const run = connection.run();
  await settle();
  await device.socket.open();
  await device.socket.send(patch({ from: null, to: 0 }));

  connection.stop();
  await run;

  expect(device.socket.closed).toBe(true);
  await device.advance(10 * 60_000);
  expect(device.sockets).toHaveLength(1);
  // What the tab knew of the connection stays, for a tab that takes over
  // to correct.
  expect(store.getState().connection).toBe("online");
});

it("says why it was stopped, and sends nothing that is stored after that", async () => {
  const { device, socket, store, connection } = await online();

  // As for a session that the tab has learned is over, while its socket
  // is open and would still be served.
  connection.stop("signed-out");

  expect(socket.closed).toBe(true);
  expect(store.getState().connection).toBe("signed-out");
  // The store goes on: a mutation is stored, and stays on the device.
  store.mutate("post.delete", { id: newId() });
  await settle();
  await device.advance(10 * 60_000);
  expect(store.getState().pending).toBe(1);
  expect(socket.mutates).toEqual([]);
  expect(device.sockets).toHaveLength(1);
});

it("opens no socket when it was stopped before its turn came", async () => {
  const device = browser();
  const { store, connection } = await device.tab();

  // The tab was in line for the socket when it was stopped, and its turn
  // comes after that: the lock of the socket is granted all the same.
  connection.stop("signed-out");
  await connection.run();

  await device.advance(10 * 60_000);
  expect(device.sockets).toHaveLength(0);
  // It never held the socket, so it has nothing to say about it.
  expect(store.getState().connection).toBe("connecting");
});

it("lets another tab take the socket over, with the mutations that were waiting", async () => {
  const device = browser();
  const one = await device.holder();
  await one.socket.send(
    patch({ from: null, to: 4, changes: draft("A").puts() }),
  );
  const two = await device.tab();
  await one.socket.close(1006);
  // Made in the tab without the socket, while there is no connection.
  const id = newId();
  two.store.mutate("post.delete", { id });
  await settle();

  // The first tab is closed.
  one.connection.stop();
  one.store.close();
  void two.connection.run();
  await settle();
  await device.socket.open();

  // The hello of the second tab goes on where the first one stopped.
  expect(device.socket.sent[0]).toMatchObject({
    clientId: one.store.head.meta.clientId,
    cursor: 4,
    lastMutationId: 0,
  });
  await device.socket.send(patch({ from: 4, to: 4 }));
  expect(device.socket.mutates).toEqual([
    [{ id: 1, name: "post.delete", args: { id } }],
  ]);
});

it("sends the mutations of a tab that does not hold the socket", async () => {
  const { device, socket, store } = await online();
  const other = await device.tab();

  const id = newId();
  other.store.mutate("post.delete", { id });
  await settle();

  expect(socket.mutates).toEqual([
    [{ id: 1, name: "post.delete", args: { id } }],
  ]);
  // The answer reaches the other tab through the one with the socket.
  await socket.send(patch({ from: 0, to: 0, lastMutationId: 1 }));
  expect(store.getState().pending).toBe(0);
  expect(other.store.getState()).toMatchObject({
    connection: "online",
    pending: 0,
  });
});
