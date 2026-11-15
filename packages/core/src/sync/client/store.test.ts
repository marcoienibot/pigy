import { expect, it } from "vitest";
import { browser, draft, newId, settle } from "../../../test/sync-browser.ts";
import { appendMutations, applyPatch } from "./copy.ts";
import { type SyncStore, saveRetryMs, tabAnswerMs } from "./store.ts";

/** Creates a draft in `store` and returns the IDs of it and its part. */
function createDraft(store: SyncStore, text: string) {
  const ids = { id: newId(), partId: newId() };
  store.mutate("post.create", { ...ids, text });
  return ids;
}

/** A promise that the test resolves, for a storage that takes its time. */
function gate() {
  let open = () => {};
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open };
}

/**
 * Makes every write to the stored copy fail, as on a device that has no
 * room left. Reading still works. Returns how to make room again.
 */
function fill(device: ReturnType<typeof browser>): () => void {
  const { update } = device.storage;
  device.storage.update = (step, options) =>
    update((head) => {
      const outcome = step(head);
      if (outcome.write) throw new Error("The disk is full");
      return outcome;
    }, options);
  return () => {
    device.storage.update = update;
  };
}

/**
 * How many mutations `store` says the tabs could not store, if it can say
 * so without the clock being moved. Undefined if it waits for a tab.
 */
async function unsavedInAllTabs(store: SyncStore): Promise<number | undefined> {
  let count: number | undefined;
  void store.unsavedInAllTabs().then((unsaved) => {
    count = unsaved;
  });
  await settle();
  return count;
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
  const view = store.getView();

  await settle();
  expect(store.head.outbox.map(({ id, name }) => [id, name])).toEqual([
    [1, "post.create"],
  ]);
  // Moving it to the outbox did not show it twice or count it twice.
  expect(texts(store)).toEqual(["Hello"]);
  expect(store.getState().pending).toBe(1);
  // Nor did it change anything on screen, so the screens are not handed
  // new rows to render: that would be once more for every keystroke.
  expect(store.getView()).toBe(view);
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
  // They are one before they are stored too: the draft and its text.
  expect(store.getState().pending).toBe(2);
  expect(texts(store)).toEqual(["Hey"]);
  const view = store.getView();

  await settle();
  // The draft, and one mutation for all that was typed into it.
  expect(store.head.outbox.map(({ id, name }) => [id, name])).toEqual([
    [1, "post.create"],
    [2, "part.setText"],
  ]);
  expect(store.head.outbox[1]?.args).toEqual({ id: partId, text: "Hey" });
  expect(store.getState().pending).toBe(2);
  expect(texts(store)).toEqual(["Hey"]);
  // One mutation does what the three did, so the rows that are shown are
  // the ones that were shown before.
  expect(store.getView()).toBe(view);
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

it("counts what was typed into a part as one change while it cannot be stored", async () => {
  const device = browser();
  const { store } = await device.tab();
  const { partId } = createDraft(store, "");
  await settle();
  const { update } = device.storage;
  device.storage.update = () => Promise.reject(new Error("The disk is full"));

  for (const text of ["H", "He", "Hey"]) {
    store.mutate("part.setText", { id: partId, text });
    // As when typing: storing the one key has failed before the next.
    await settle();
  }

  // One change that is not saved, not one for every key: that is what the
  // person is told, and what signing out says it would lose.
  expect(device.errors).toHaveLength(3);
  expect(store.getState()).toMatchObject({ pending: 2, unsaved: 1 });
  expect(texts(store)).toEqual(["Hey"]);

  // And it is stored as the one change, with the text that was typed last.
  device.storage.update = update;
  await device.advance(saveRetryMs);
  expect((await device.storage.read())?.head.outbox).toMatchObject([
    { id: 1, name: "post.create" },
    { id: 2, name: "part.setText", args: { id: partId, text: "Hey" } },
  ]);
  expect(store.getState()).toMatchObject({ pending: 2, unsaved: 0 });
});

it("leaves a mutation as it is while it is being stored", async () => {
  const device = browser();
  const { store } = await device.tab();
  const { partId } = createDraft(store, "");
  await settle();
  // A storage that takes its time: it stores nothing before the test says.
  const { update } = device.storage;
  let slow = gate();
  let fails = false;
  device.storage.update = async (step, options) => {
    await slow.passed;
    if (fails) throw new Error("The disk is full");
    return update(step, options);
  };

  store.mutate("part.setText", { id: partId, text: "H" });
  // The store has begun to store that text, and more is typed meanwhile.
  await settle();
  store.mutate("part.setText", { id: partId, text: "He" });
  store.mutate("part.setText", { id: partId, text: "Hey" });
  expect(texts(store)).toEqual(["Hey"]);
  slow.open();
  await settle();

  // "H" is what was stored first, and it left the memory of the tab as
  // that. Had the later text taken its place there, the text would have
  // left with it, and the part would show "H" from here on.
  expect(texts(store)).toEqual(["Hey"]);
  expect((await device.storage.read())?.head.outbox).toMatchObject([
    { id: 1, name: "post.create" },
    { id: 2, name: "part.setText", args: { id: partId, text: "Hey" } },
  ]);
  expect(store.getState()).toMatchObject({ pending: 2, unsaved: 0 });

  // The same when storing fails: the text that was typed while the store
  // was trying stays, and the two are one change once it has failed.
  slow = gate();
  fails = true;
  store.mutate("part.setText", { id: partId, text: "Hey y" });
  await settle();
  store.mutate("part.setText", { id: partId, text: "Hey yo" });
  store.mutate("part.setText", { id: partId, text: "Hey you" });
  slow.open();
  await settle();
  expect(texts(store)).toEqual(["Hey you"]);
  expect(store.getState()).toMatchObject({ pending: 3, unsaved: 1 });
});

it("stores a mutation once when the copy cannot be read right after", async () => {
  const device = browser();
  const { store } = await device.tab();
  // Another tab stores a mutation, and its message is still on its way
  // when this tab stores one of its own. The test stores it in that tab's
  // place, and tells nobody.
  await device.storage.update((head) => {
    if (!head) throw new Error("The copy exists");
    return appendMutations(head, [
      { name: "post.delete", args: { id: newId() }, at: 0 },
    ]);
  });
  // This tab finds that it has missed a write when it has stored its own,
  // and reads the copy again. From here on that fails.
  const { read } = device.storage;
  device.storage.read = () => Promise.reject(new Error("Cannot be read"));
  const stored = async () =>
    (await read())?.head.outbox.map(({ id, name }) => [id, name]);

  const { partId } = createDraft(store, "");
  await settle();
  expect(device.errors).toHaveLength(1);
  // The draft is stored, and that is the end of storing it: it is not
  // counted as a change that could not be stored, which would be tried
  // again. And it stays on screen, where the person goes on typing into it.
  expect(await stored()).toEqual([
    [1, "post.delete"],
    [2, "post.create"],
  ]);
  expect(store.getState().unsaved).toBe(0);
  expect(texts(store)).toEqual([""]);
  for (const text of ["H", "He"]) {
    store.mutate("part.setText", { id: partId, text });
    await settle();
  }
  expect(texts(store)).toEqual(["He"]);
  // What this tab has made: the draft and one change of its text, which
  // the second key has replaced in the stored outbox, under the same ID.
  expect(store.getState()).toMatchObject({ pending: 2, unsaved: 0 });

  // After a pause the store tries again, and what it tries is the read.
  // Nothing was stored a second time: tried again as a write, the draft
  // would be there twice, and the server would refuse the second one.
  device.storage.read = read;
  await device.advance(saveRetryMs);
  expect(await stored()).toEqual([
    [1, "post.delete"],
    [2, "post.create"],
    [3, "part.setText"],
  ]);
  // The tab has the copy as it is stored, the other tab's mutation
  // included, and shows what it showed.
  expect(store.head).toEqual((await read())?.head);
  expect(store.getState()).toMatchObject({ pending: 3, unsaved: 0 });
  expect(texts(store)).toEqual(["He"]);
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

it("counts the mutations that other tabs could not store", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();
  const makeRoom = fill(device);

  createDraft(two.store, "Only in the second tab");
  await settle();

  // The draft is in no storage, and the first tab holds nothing of its own
  // that is not: it knows of the draft from the second tab alone.
  expect((await device.storage.read())?.head.outbox).toEqual([]);
  expect(one.store.getState().unsaved).toBe(0);
  expect(await unsavedInAllTabs(one.store)).toBe(1);
  // A tab that opens later was not there to be told. It asks.
  const three = await device.tab();
  await settle();
  expect(await unsavedInAllTabs(three.store)).toBe(1);
  // What a tab holds itself is counted with the rest, in every tab.
  createDraft(one.store, "Only in the first tab");
  await settle();
  for (const { store } of [one, two, three]) {
    expect(await unsavedInAllTabs(store)).toBe(2);
  }

  // Stored, they are for whoever counts what the copy holds.
  makeRoom();
  await device.advance(saveRetryMs);
  for (const { store } of [one, two, three]) {
    expect(await unsavedInAllTabs(store)).toBe(0);
  }
  expect((await device.storage.read())?.head.outbox).toHaveLength(2);
});

it("does not count a tab that has closed its store", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();
  fill(device);
  createDraft(two.store, "Only in the second tab");
  await settle();
  expect(await unsavedInAllTabs(one.store)).toBe(1);

  // As when the app stops the sync of a tab. What the tab could not store
  // is gone with that, and it says so as it goes: the first tab has
  // nothing to wait for.
  two.store.close();

  expect(await unsavedInAllTabs(one.store)).toBe(0);
});

it("gives up on a tab that has gone without a word, and counts the others", async () => {
  const device = browser();
  const one = await device.tab();
  const two = await device.tab();
  fill(device);
  createDraft(two.store, "Only in the second tab");
  // A third tab could not store two mutations and was then closed, as a
  // browser closes a tab: nothing ran in it that could have said so. The
  // test has spoken in its place while it was there.
  device.tabs.join().post({ type: "unsaved", tab: "closed", count: 2 });
  await settle();

  // The second tab says again at once what it holds. The third is given
  // time to: it may only be slow, and what it holds would be lost.
  let count: number | undefined;
  void one.store.unsavedInAllTabs().then((unsaved) => {
    count = unsaved;
  });
  await settle();
  await device.advance(tabAnswerMs - 1);
  expect(count).toBeUndefined();
  // Then it counts as gone, and what it held with it: the first tab does
  // not warn of mutations for ever that nobody can save any more.
  await device.advance(1);
  expect(count).toBe(1);
  // Nor is it waited for a second time.
  expect(await unsavedInAllTabs(one.store)).toBe(1);
});
