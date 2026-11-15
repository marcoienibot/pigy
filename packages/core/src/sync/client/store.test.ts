import { expect, it } from "vitest";
import { browser, draft, newId, settle } from "../../../test/sync-browser.ts";
import { applyPatch } from "./copy.ts";
import { type SyncStore, saveRetryMs } from "./store.ts";

/** Creates a draft in `store` and returns the IDs of it and its part. */
function createDraft(store: SyncStore, text: string) {
  const ids = { id: newId(), partId: newId() };
  store.mutate("post.create", { ...ids, text });
  return ids;
}

/** The texts of the parts that `store` shows, in no particular order. */
function texts(store: SyncStore): string[] {
  return [...store.getView().post_part.values()].map(({ text }) => text).sort();
}

it("shows a mutation before it is stored", async () => {
  const { store } = await browser().tab();
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  createDraft(store, "Hello");

  // Nothing was awaited: the view has the draft when `mutate` returns.
  expect(texts(store)).toEqual(["Hello"]);
  // Not stored yet is not the same as could not be stored.
  expect(store.getState()).toMatchObject({ pending: 1, unsaved: 0 });
  expect(notified).toBe(1);
  // It is not in the outbox yet, which is what is stored.
  expect(store.head.outbox).toEqual([]);

  await settle();
  expect(store.head.outbox.map(({ id, name }) => [id, name])).toEqual([
    [1, "post.create"],
  ]);
  // Moving it to the outbox did not show it twice or count it twice.
  expect(texts(store)).toEqual(["Hello"]);
  expect(store.getState().pending).toBe(1);
});

it("has the unconfirmed mutations again after a restart, and goes on counting", async () => {
  const device = browser();
  const first = await device.tab();
  const { partId } = createDraft(first.store, "Hello");
  await settle();
  first.store.close();

  // A new store over what is stored, as after the page was loaded again.
  const { store } = await device.tab();

  expect(texts(store)).toEqual(["Hello"]);
  expect(store.getState().pending).toBe(1);
  // Same client, and the next mutation gets the next ID.
  expect(store.head.meta.clientId).toBe(first.store.head.meta.clientId);
  store.mutate("post.delete", { id: newId() });
  store.mutate("part.setText", { id: partId, text: "Hello again" });
  await settle();
  expect(store.head.outbox.map(({ id }) => id)).toEqual([1, 2, 3]);
});

it("stores what was typed into a part as one mutation", async () => {
  const { store } = await browser().tab();
  const { partId } = createDraft(store, "");
  await settle();

  for (const text of ["H", "He", "Hey"]) {
    store.mutate("part.setText", { id: partId, text });
  }
  // Until they are stored they are three, and the view runs all of them.
  expect(store.getState().pending).toBe(4);
  expect(texts(store)).toEqual(["Hey"]);

  await settle();
  // The draft, and one mutation for all that was typed into it.
  expect(store.head.outbox.map(({ id, name }) => [id, name])).toEqual([
    [1, "post.create"],
    [2, "part.setText"],
  ]);
  expect(store.head.outbox[1]?.args).toEqual({ id: partId, text: "Hey" });
  expect(store.getState().pending).toBe(2);
  expect(texts(store)).toEqual(["Hey"]);
});

it("shows a mutation in the other tabs, which can mutate too", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();

  const { partId } = createDraft(one.store, "From one");
  await settle();
  expect(texts(two.store)).toEqual(["From one"]);

  // The second tab changes what the first one made, and makes its own.
  two.store.mutate("part.setText", { id: partId, text: "Changed by two" });
  createDraft(two.store, "From two");
  await settle();

  expect(texts(one.store)).toEqual(["Changed by two", "From two"]);
  expect(texts(two.store)).toEqual(["Changed by two", "From two"]);
  // One outbox, in which every mutation has an ID of its own.
  expect(one.store.head.outbox).toEqual(two.store.head.outbox);
  expect(one.store.head.outbox.map(({ id }) => id)).toEqual([1, 2, 3]);
});

it("gives mutations that two tabs make at the same time different IDs", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();

  // Neither has heard of the other's mutation when it makes its own.
  createDraft(one.store, "One");
  createDraft(two.store, "Two");
  await settle();

  for (const { store } of [one, two]) {
    expect(store.head.outbox.map(({ id }) => id)).toEqual([1, 2]);
    expect(texts(store)).toEqual(["One", "Two"]);
    expect(store.getState().pending).toBe(2);
  }
  expect(one.store.head.outbox).toEqual(two.store.head.outbox);
});

it("reads the copy again when it has missed a write of another tab", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();
  const { id } = createDraft(one.store, "First");
  await settle();

  // A write that the second tab is never told of: it is made on the
  // storage directly, as by a tab whose message got lost.
  const { puts } = draft("Second");
  await device.storage.update((head) => {
    if (!head) throw new Error("The copy exists");
    return applyPatch(
      head,
      { from: null, to: 1, changes: puts(), lastMutationId: 0, rejected: [] },
      newId(),
    );
  });
  expect(texts(two.store)).toEqual(["First"]);

  // The next write that it is told of does not follow the last one it has.
  one.store.mutate("post.delete", { id });
  await settle();

  expect(texts(two.store)).toEqual(["Second"]);
  expect(two.store.head).toEqual((await device.storage.read())?.head);
});

it("tells a tab that opens how the tab with the socket is getting on", async () => {
  const device = browser();
  const holder = await device.tab();
  holder.store.setConnection("online");

  // It asks when it opens: nobody tells it otherwise until the state
  // changes, which can be much later.
  const late = await device.tab();
  await settle();
  expect(late.store.getState().connection).toBe("online");

  holder.store.setConnection("offline");
  await settle();
  expect(late.store.getState().connection).toBe("offline");
});

it("dismisses a rejection in every tab", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();
  one.store.mutate("part.setText", { id: newId(), text: "Lost" });
  await settle();
  // The server rejects the mutation: there is no such part.
  await one.store.transact((head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 0,
        changes: [],
        lastMutationId: 1,
        rejected: [{ id: 1, code: "not_found", message: "No such post" }],
      },
      newId(),
    ),
  );
  await settle();
  const [rejection] = two.store.getRejections();
  expect(rejection).toMatchObject({ name: "part.setText", code: "not_found" });

  two.store.dismiss(rejection?.key ?? "");
  await settle();

  expect(one.store.getRejections()).toEqual([]);
  expect(two.store.getRejections()).toEqual([]);
});

it("keeps showing a mutation that could not be stored, and stores it with the next", async () => {
  const device = browser();
  const { store } = await device.tab();
  const { update } = device.storage;
  device.storage.update = () => Promise.reject(new Error("The disk is full"));

  createDraft(store, "Kept");
  await settle();
  expect(texts(store)).toEqual(["Kept"]);
  expect(store.head.outbox).toEqual([]);
  expect(device.errors).toHaveLength(1);

  device.storage.update = update;
  createDraft(store, "Next");
  await settle();
  expect(texts(store)).toEqual(["Kept", "Next"]);
  expect(store.head.outbox.map(({ id }) => id)).toEqual([1, 2]);
  expect(store.getState()).toMatchObject({ pending: 2, unsaved: 0 });
  // The attempt that was planned for later has nothing left to do.
  await device.advance(saveRetryMs);
  expect(store.head.outbox.map(({ id }) => id)).toEqual([1, 2]);
  expect(device.errors).toHaveLength(1);
});

it("says that a mutation is not stored when storing it fails, and tries again by itself", async () => {
  const device = browser();
  const { store } = await device.tab();
  const { update } = device.storage;
  device.storage.update = () => Promise.reject(new Error("The disk is full"));

  createDraft(store, "Kept");
  await settle();

  // It is counted as what it is: a change that is in the memory of this
  // tab and nowhere else. The app must not call that saved.
  expect(store.getState()).toMatchObject({ pending: 1, unsaved: 1 });
  expect(texts(store)).toEqual(["Kept"]);
  expect(device.errors).toHaveLength(1);
  expect((await device.storage.read())?.head.outbox).toEqual([]);

  // It is tried again after a pause, and nothing else has to happen for
  // that. The disk is still full.
  await device.advance(saveRetryMs - 1);
  expect(device.errors).toHaveLength(1);
  await device.advance(1);
  expect(device.errors).toHaveLength(2);
  expect(store.getState()).toMatchObject({ pending: 1, unsaved: 1 });

  // There is room again, and the next attempt stores it.
  device.storage.update = update;
  await device.advance(saveRetryMs);
  expect(store.getState()).toMatchObject({ pending: 1, unsaved: 0 });
  expect((await device.storage.read())?.head.outbox).toMatchObject([
    { id: 1, name: "post.create" },
  ]);
  expect(texts(store)).toEqual(["Kept"]);
});

it("stores a mutation that a person makes in a tab that is too old for the copy", async () => {
  const device = browser();
  const { store } = await device.tab();
  // A tab with the next version of the app has taken the copy to its
  // schema.
  await device.storage.update((head) => {
    if (!head) throw new Error("The copy exists");
    return {
      write: {
        meta: {
          ...head.meta,
          cursor: null,
          schemaVersion: head.meta.schemaVersion + 1,
          version: head.meta.version + 1,
        },
        rows: { clear: true, changes: [] },
      },
      result: undefined,
    };
  });

  const id = newId();
  store.mutate("post.delete", { id });
  await settle();

  // The tab has found out, and tells the person to load it again. What
  // they did in it meanwhile must still be there after that. It is a
  // mutation of the old schema among those that the copy held before the
  // update, which SYNC.md section 6 has the new version send as they are.
  expect(store.getState().outdated).toBe(true);
  expect((await device.storage.read())?.head.outbox).toMatchObject([
    { id: 1, name: "post.delete", args: { id } },
  ]);
  // What the socket brings is another matter: that is not written.
  const outcome = await store.transact((head) =>
    applyPatch(
      head,
      { from: null, to: 3, changes: [], lastMutationId: 0, rejected: [] },
      newId(),
    ),
  );
  expect(outcome).toBeUndefined();
  expect((await device.storage.read())?.head.meta.cursor).toBeNull();
});
