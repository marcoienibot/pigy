import { runInDurableObject } from "cloudflare:test";
import {
  maxPartTextLength,
  type SyncStore,
  syncSchemaVersion,
  syncTimings,
} from "@pigy/core";
import { expect, it, vi } from "vitest";
import { maxSockets, socketLifetimeMs } from "../src/workspace/object.ts";
import { device, shown, synced } from "./app-client.ts";
import { adminEmail, invite, setup, signedIn } from "./helpers.ts";
import { connectAccount } from "./publishing.ts";
import { newId, objectOf, SyncClient, workspaceIds } from "./sync-client.ts";

// The sync client of the app against the real workspace object. What the
// client does with each message is tested in packages/core, with a server
// that the tests play. These tests are about the two fitting together.

/** A signed-in admin and the ID of their live workspace. */
async function start() {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const { live } = await workspaceIds(browser);
  return { test, browser, workspace: live };
}

/** Creates a draft in `store` and returns the IDs of it and its part. */
function createDraft(store: SyncStore, text: string) {
  const ids = { id: newId(), partId: newId() };
  store.mutate("post.create", { ...ids, text });
  return ids;
}

/** The texts that `store` shows, in no particular order. */
function texts(store: SyncStore): string[] {
  return [...store.getView().post_part.values()].map(({ text }) => text).sort();
}

it("brings two devices to the rows of the server, through edits made online and offline", async () => {
  const { browser, workspace } = await start();
  const one = await device(browser, workspace).online();
  const two = await device(browser, workspace).online();

  // Online: what one device does, the other shows without asking.
  const shared = createDraft(one.store, "Written on one");
  await vi.waitFor(() => expect(texts(two.store)).toEqual(["Written on one"]));
  two.store.mutate("part.setText", { id: shared.partId, text: "Edited on 2" });
  await vi.waitFor(() => expect(texts(one.store)).toEqual(["Edited on 2"]));

  // Offline, both: each edits the shared draft and writes one of its own.
  await one.link.lose();
  await two.link.lose();
  one.store.mutate("part.setText", { id: shared.partId, text: "One, offline" });
  createDraft(one.store, "Only on one");
  two.store.mutate("part.setText", { id: shared.partId, text: "Two, offline" });
  createDraft(two.store, "Only on two");
  // Each shows its own work at once, and knows that it is not synced.
  expect(texts(one.store)).toEqual(["One, offline", "Only on one"]);
  expect(texts(two.store)).toEqual(["Only on two", "Two, offline"]);
  expect(one.store.getState()).toMatchObject({
    connection: "offline",
    pending: 2,
  });

  // Device one is back first, so the text of device two is the later one.
  one.link.pass(syncTimings.retry[0]);
  await synced(one.store);
  two.link.pass(syncTimings.retry[0]);
  await synced(two.store);
  await vi.waitFor(() => expect(shown(one.store)).toEqual(shown(two.store)));

  expect(texts(one.store)).toHaveLength(3);
  expect(texts(one.store)).toContain("Only on one");
  expect(texts(one.store)).toContain("Only on two");
  // Exactly what the server has, down to the times it gave the rows.
  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(shown(one.store)).toEqual(reference.copy);
  expect(one.store.getRejections()).toEqual([]);
  expect(two.store.getRejections()).toEqual([]);
});

it("does not repeat a mutation whose answer was lost", async () => {
  const { browser, workspace } = await start();
  const tab = await device(browser, workspace).online();
  const witness = await device(browser, workspace).online();

  // The server gets the mutation, and the client never hears of it.
  tab.link.deaf = true;
  createDraft(tab.store, "Once");
  await vi.waitFor(() => expect(texts(witness.store)).toEqual(["Once"]));
  expect(tab.store.getState().pending).toBe(1);
  await tab.link.lose();
  tab.link.deaf = false;

  tab.link.pass(syncTimings.retry[0]);
  await synced(tab.store);

  // Sent again, `post.create` would have been rejected: the post exists.
  // The answer to the hello told the client that it was processed.
  expect(tab.store.getRejections()).toEqual([]);
  expect(tab.store.head.meta.lastMutationId).toBe(1);
  expect(shown(tab.store)).toEqual(shown(witness.store));
  expect(texts(tab.store)).toEqual(["Once"]);
});

it("shows a rejection once, also when the answer that carried it was lost", async () => {
  const { browser, workspace } = await start();
  const tab = await device(browser, workspace).online();
  const other = await device(browser, workspace).online();
  const { id, partId } = createDraft(tab.store, "Draft");
  await synced(tab.store);
  await vi.waitFor(() => expect(texts(other.store)).toEqual(["Draft"]));

  // The draft is deleted elsewhere, which this client does not hear of,
  // and then edited here. Nor does it hear that the edit was rejected.
  tab.link.deaf = true;
  other.store.mutate("post.delete", { id });
  await synced(other.store);
  tab.store.mutate("part.setText", { id: partId, text: "Edited too late" });
  expect(texts(tab.store)).toEqual(["Edited too late"]);
  await vi.waitFor(async () =>
    expect(
      await runInDurableObject(objectOf(workspace), (_, state) =>
        state.storage.sql.exec("select count(*) as kept from rejection").one(),
      ),
    ).toEqual({ kept: 1 }),
  );
  await tab.link.lose();
  tab.link.deaf = false;

  tab.link.pass(syncTimings.retry[0]);
  await synced(tab.store);

  // The view is the server's again, and the client knows what was refused.
  expect(texts(tab.store)).toEqual([]);
  expect(tab.store.getRejections()).toEqual([
    {
      key: `${tab.store.head.meta.clientId}/2`,
      name: "part.setText",
      args: { id: partId, text: "Edited too late" },
      code: "not_found",
      message: "This part is gone: it was removed, or its post was deleted",
    },
  ]);

  // The next hello says that the client has seen it: it is not told again.
  // The pause before it is the second one. The socket in between has only
  // had its hello answered, which does not make it one that works.
  await tab.link.lose();
  tab.link.pass(syncTimings.retry[1]);
  await synced(tab.store);
  expect(tab.store.getRejections()).toHaveLength(1);
});

it("refuses what one device wrote for an account that another has left out meanwhile, and keeps it out of the post's own text", async () => {
  const { test, browser, workspace } = await start();
  const channelId = await connectAccount(test, browser, workspace);
  const one = await device(browser, workspace).online();
  const two = await device(browser, workspace).online();
  const { id: postId } = createDraft(one.store, "For everybody");
  const ownPartId = newId();
  one.store.mutate("target.add", { id: newId(), postId, channelId });
  one.store.mutate("target.customize", {
    postId,
    channelId,
    parts: [{ id: ownPartId, text: "For one account" }],
  });
  await synced(one.store);
  await vi.waitFor(() => expect(shown(two.store)).toEqual(shown(one.store)));

  // Offline, the first device goes on with the text of the account: it
  // adds a part and types into it. Meanwhile the second leaves the
  // account out, and its text goes with it.
  await one.link.lose();
  const addedId = newId();
  one.store.mutate("part.add", {
    id: addedId,
    postId,
    channelId,
    afterId: ownPartId,
    text: "",
  });
  one.store.mutate("part.setText", { id: addedId, text: "And more for it" });
  two.store.mutate("target.remove", { postId, channelId });
  await synced(two.store);

  one.link.pass(syncTimings.retry[0]);
  await synced(one.store);

  // Nothing of the text of the one account is in what the others get: the
  // post has its own text and no other part, on both devices.
  expect(texts(one.store)).toEqual(["For everybody"]);
  await vi.waitFor(() => expect(shown(two.store)).toEqual(shown(one.store)));
  // And the first device is told that its work did not go in, part and
  // text.
  expect(
    one.store.getRejections().map(({ name, code }) => ({ name, code })),
  ).toEqual([
    { name: "part.add", code: "not_found" },
    { name: "part.setText", code: "not_found" },
  ]);
});

it("opens a new socket when the old one has run out, and loses nothing on the way", async () => {
  const { test, browser, workspace } = await start();
  const tab = await device(browser, workspace).online();
  const connections: string[] = [];
  tab.store.subscribe(() => connections.push(tab.store.getState().connection));

  test.advance(socketLifetimeMs);
  // The server closes the socket on this message without processing it.
  createDraft(tab.store, "After five minutes");
  await vi.waitFor(() => expect(tab.link.opened).toBe(2));
  await synced(tab.store);

  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(reference.copy).toEqual(shown(tab.store));
  expect(texts(tab.store)).toEqual(["After five minutes"]);
  // Nobody was shown a lost connection for it.
  expect(connections).not.toContain("offline");
});

it("finds out that it was signed out when its socket runs out, and keeps what was not sent", async () => {
  const { test, browser, workspace } = await start();
  const tab = await device(browser, workspace).online();

  const signOut = await browser.fetch("/api/auth/sign-out", { method: "POST" });
  expect(signOut.status).toBe(204);
  test.advance(socketLifetimeMs);
  createDraft(tab.store, "Not sent");
  // The handshake of the next socket is refused, and the client asks why.
  await tab.running;

  expect(tab.store.getState()).toMatchObject({
    connection: "signed-out",
    pending: 1,
  });
  expect(tab.store.head.outbox).toHaveLength(1);
  // It does not try again.
  tab.link.pass(60 * 60_000);
  expect(tab.link.opened).toBe(2);
});

it("gives up on a workspace that is not its user's", async () => {
  const test = setup();
  const memberEmail = "member@example.com";
  await invite(test, memberEmail);
  const admin = await signedIn(test, { email: adminEmail });
  const member = await signedIn(test, { email: memberEmail });
  const ofAdmin = await workspaceIds(admin);

  // As after another person has signed in in the same browser: the copy
  // on the device is of a workspace that the session does not reach.
  const tab = await device(member, ofAdmin.live).tab();
  await tab.connection.run();

  expect(tab.store.getState().connection).toBe("no-access");
  tab.link.pass(60 * 60_000);
  expect(tab.link.opened).toBe(1);
});

it("keeps trying when the handshake is refused for a reason that passes", async () => {
  const { browser, workspace } = await start();
  // The workspace has as many sockets open as it takes.
  const crowd = await Promise.all(
    Array.from({ length: maxSockets }, async () => {
      const client = new SyncClient();
      await client.open(browser, workspace);
      return client;
    }),
  );
  const tab = await device(browser, workspace).tab();
  void tab.connection.run();

  // The session is good and the workspace is the user's, so it waits.
  await vi.waitFor(() =>
    expect(tab.store.getState().connection).toBe("offline"),
  );
  expect(tab.link.opened).toBe(1);

  // One of the others leaves, and the next attempt gets in.
  crowd[0]?.disconnect();
  await vi.waitFor(async () =>
    expect(
      await runInDurableObject(
        objectOf(workspace),
        (_, state) =>
          state
            .getWebSockets()
            .filter((socket) => socket.readyState === WebSocket.OPEN).length,
      ),
    ).toBe(maxSockets - 1),
  );
  tab.link.pass(syncTimings.retry[0]);
  await synced(tab.store);
  expect(tab.link.opened).toBe(2);
});

it("makes way for a newer socket of its copy and does not take it back", async () => {
  const { browser, workspace } = await start();
  const laptop = device(browser, workspace);
  const older = await laptop.online();
  // A second tab opens a socket for the same copy. The app never does:
  // only one tab holds the socket. This is what happens if it does.
  const newer = await laptop.online();

  // The older tab gives the socket up for good.
  await older.running;
  older.link.pass(60 * 60_000);
  expect(older.link.opened).toBe(1);

  // The newer socket works, also for what the older tab does, and the
  // older tab shows how the newer one is getting on.
  await vi.waitFor(() =>
    expect(older.store.getState().connection).toBe("online"),
  );
  expect(newer.store.getState().connection).toBe("online");
  createDraft(older.store, "From the tab without a socket");
  await synced(older.store);
  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(reference.copy).toEqual(shown(older.store));
  expect(texts(older.store)).toEqual(["From the tab without a socket"]);
});

it("lets a second tab take the socket over when the first is closed", async () => {
  const { browser, workspace } = await start();
  const laptop = device(browser, workspace);
  const first = await laptop.online();
  const second = await laptop.tab();
  const { partId } = createDraft(second.store, "Made in the second tab");
  // Through the socket of the first tab.
  await synced(second.store);
  expect(second.link.opened).toBe(0);

  // The first tab loses its connection and is closed before it is back.
  await first.link.lose();
  second.store.mutate("part.setText", { id: partId, text: "Edited alone" });
  first.connection.stop();
  first.store.close();
  void second.connection.run();
  await synced(second.store);

  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(reference.copy).toEqual(shown(second.store));
  expect(texts(second.store)).toEqual(["Edited alone"]);
  // One copy, so one client to the server, whichever tab holds the socket.
  const clients = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql
      .exec("select client_id, last_mutation_id from client_mutation")
      .toArray(),
  );
  expect(clients).toEqual([
    { client_id: second.store.head.meta.clientId, last_mutation_id: 2 },
  ]);
});

it("starts over as a new client when the server no longer knows its mutations", async () => {
  const { browser, workspace } = await start();
  const tab = await device(browser, workspace).online();
  const { partId } = createDraft(tab.store, "Draft");
  await synced(tab.store);
  const { clientId } = tab.store.head.meta;
  // The server forgets what it has processed of this client, as it would
  // after its data was restored to an earlier state.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    state.storage.sql.exec("delete from client_mutation");
  });

  // Mutation 2, where the server now expects 1: `mutation_gap`. The answer
  // to the next hello says so again, and the client has no mutation 1.
  tab.store.mutate("part.setText", { id: partId, text: "Edited" });
  await vi.waitFor(() =>
    expect(tab.store.head.meta.clientId).not.toBe(clientId),
  );
  await synced(tab.store);

  // The edit got through, as mutation 1 of the new client.
  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(reference.copy).toEqual(shown(tab.store));
  expect(texts(tab.store)).toEqual(["Edited"]);
  expect(tab.store.head.meta.lastMutationId).toBe(1);
  expect(tab.store.getRejections()).toEqual([]);
  // Three sockets: the one that was refused, the one whose hello showed
  // that the gap stays, and the one of the new client.
  expect(tab.link.opened).toBe(3);
});

it("comes back when the server was updated under an open socket", async () => {
  const { browser, workspace } = await start();
  const tab = await device(browser, workspace).online();
  // As in sync.test.ts: the socket was opened under the version before.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    for (const socket of state.getWebSockets()) {
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        schemaVersion: syncSchemaVersion - 1,
      });
    }
  });

  // The server turns the socket away, with versions that are the client's
  // own: it is not the client that is out of date.
  createDraft(tab.store, "Written during the update");
  await vi.waitFor(() =>
    expect(tab.store.getState().connection).toBe("offline"),
  );
  expect(tab.store.getState().outdated).toBe(false);

  tab.link.pass(syncTimings.retry[0]);
  await synced(tab.store);
  const reference = new SyncClient();
  await reference.connect(browser, workspace);
  expect(reference.copy).toEqual(shown(tab.store));
});

it("puts a snapshot together that arrives in several messages", async () => {
  const { browser, workspace } = await start();
  const author = new SyncClient();
  await author.connect(browser, workspace);
  // More text than the server puts in one message.
  for (let index = 0; index < 60; index += 1) {
    author.mutate("post.create", {
      id: newId(),
      partId: newId(),
      text: String(index % 10).repeat(maxPartTextLength),
    });
    await author.patch();
  }
  const reference = new SyncClient();
  const snapshot = await reference.connect(browser, workspace);
  expect(snapshot.messages).toBeGreaterThan(1);

  const tab = await device(browser, workspace).online();

  expect(shown(tab.store)).toEqual(reference.copy);
});
