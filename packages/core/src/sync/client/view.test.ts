import { expect, it } from "vitest";
import { draft, newId } from "../../../test/sync-browser.ts";
import {
  applyChanges,
  emptyTables,
  type MutationCall,
  type Tables,
} from "./copy.ts";
import { viewOf } from "./view.ts";

function setText(id: string, text: string, at = 0): MutationCall {
  return { name: "part.setText", args: { id, text }, at };
}

/** When `post` was last changed, as `view` has it. */
function changed(view: Tables, { post }: ReturnType<typeof draft>): number {
  const row = view.post.get(post.id);
  if (!row) throw new Error("The view does not have the post");
  return row.updatedAt;
}

/** `rows` after the server has changed `post` at `updatedAt`. */
function confirmedAt(
  rows: Tables,
  { post }: ReturnType<typeof draft>,
  updatedAt: number,
): Tables {
  return applyChanges(rows, false, [
    { op: "put", table: "post", row: { ...post, updatedAt } },
  ]);
}

it("shows the server's rows as they are when nothing is pending", () => {
  const rows = applyChanges(emptyTables(), false, draft("Hello").puts());

  // The same object, so whoever shows it can tell that nothing changed.
  expect(viewOf(rows, [])).toBe(rows);
});

it("runs the pending mutations on top of the server's rows, at their own time", () => {
  const { post, part, puts } = draft("Server");
  const rows = applyChanges(emptyTables(), false, puts());

  const view = viewOf(rows, [setText(part.id, "Typed", 1234)]);

  expect(view.post_part.get(part.id)?.text).toBe("Typed");
  // The mutator takes the time from its transaction, and for display that
  // is when the mutation was made, not when it is run again.
  expect(view.post.get(post.id)?.updatedAt).toBe(1234);
  // The server's rows are not what was changed.
  expect(rows.post_part.get(part.id)?.text).toBe("Server");
});

it("moves a pending mutation onto rows that a patch has changed", () => {
  const mine = draft("Mine");
  const theirs = draft("Theirs");
  const pending = [setText(mine.part.id, "Mine, edited")];
  const before = applyChanges(emptyTables(), false, mine.puts());

  // Another device adds a draft and changes the one that is being edited.
  const after = applyChanges(before, false, [
    ...theirs.puts(),
    ...mine.puts("Mine, from the other device"),
  ]);
  const view = viewOf(after, pending);

  expect(view.post.has(theirs.post.id)).toBe(true);
  // The pending text is the later of the two on this client, and will be
  // on the server once the mutation gets there.
  expect(view.post_part.get(mine.part.id)?.text).toBe("Mine, edited");
});

it("leaves out a pending mutation that the rows no longer allow", () => {
  const { post, part, puts, deletes } = draft("Text");
  const pending = [setText(part.id, "Edited")];
  const before = applyChanges(emptyTables(), false, puts());
  expect(viewOf(before, pending).post_part.get(part.id)?.text).toBe("Edited");

  // Another device deletes the post. The server will reject the edit, and
  // the view does not bring the post back for it.
  const after = applyChanges(before, false, deletes());
  const view = viewOf(after, pending);

  expect(view.post.has(post.id)).toBe(false);
  expect(view.post_part.has(part.id)).toBe(false);
});

it("keeps the order of two changes when the server confirms the first, on a device whose clock is behind", () => {
  const first = draft("First");
  const second = draft("Second");
  const rows = applyChanges(emptyTables(), false, [
    ...first.puts(),
    ...second.puts(),
  ]);
  const editFirst = setText(first.part.id, "First, edited", 100);
  const editSecond = setText(second.part.id, "Second, edited", 105);

  const before = viewOf(rows, [editFirst, editSecond]);
  expect(changed(before, first)).toBe(100);
  expect(changed(before, second)).toBe(105);

  // The server runs the first edit at 110 by its own clock, which is after
  // the moment at which the device made the second one, by the device's.
  const between = viewOf(confirmedAt(rows, first, 110), [editSecond]);

  // The second edit was made last and will reach the server last. Had it
  // kept the time of the device, the draft that it changed would be the
  // older of the two until its own confirmation came, and jump back then.
  expect(changed(between, first)).toBe(110);
  expect(changed(between, second)).toBe(111);
});

it("runs a pending mutation after everything the server has, however far the clock of the device is behind", () => {
  const old = draft("Old", 1_000_000);
  const older = draft("Older", 900_000);
  const rows = applyChanges(emptyTables(), false, [
    ...old.puts(),
    ...older.puts(),
  ]);
  const id = newId();

  // A device that takes it for a quarter of an hour earlier makes a draft,
  // and then edits the one that has not been changed for longest.
  const view = viewOf(rows, [
    {
      name: "post.create",
      args: { id, partId: newId(), text: "New" },
      at: 100_000,
    },
    setText(older.part.id, "Older, edited", 100_005),
  ]);

  // The new draft is newer than every draft of the server, from the start.
  expect(view.post.get(id)).toMatchObject({
    createdAt: 1_000_001,
    updatedAt: 1_000_001,
  });
  // And the mutations keep the order in which they were made.
  expect(changed(view, older)).toBe(1_000_002);
  // What the server has is not what was changed.
  expect(changed(view, old)).toBe(1_000_000);
});

it("runs a pending mutation at the time of the device when its clock is ahead", () => {
  const first = draft("First", 1_000);
  const second = draft("Second", 900);
  const rows = applyChanges(emptyTables(), false, [
    ...first.puts(),
    ...second.puts(),
  ]);
  const editFirst = setText(first.part.id, "First, edited", 5_000);
  const editSecond = setText(second.part.id, "Second, edited", 5_010);

  // Later than everything the server has, so nothing is moved: these are
  // the times that the person sees until the server has said its own.
  const before = viewOf(rows, [editFirst, editSecond]);
  expect(changed(before, first)).toBe(5_000);
  expect(changed(before, second)).toBe(5_010);

  // The server's time for the first edit is earlier than the device's, and
  // the second edit stays the later of the two.
  const between = viewOf(confirmedAt(rows, first, 1_010), [editSecond]);
  expect(changed(between, first)).toBe(1_010);
  expect(changed(between, second)).toBe(5_010);
});

it("runs every pending mutation after the one before it, whatever the clock of the device did in between", () => {
  const first = draft("First");
  const second = draft("Second");
  const third = draft("Third");
  const rows = applyChanges(emptyTables(), false, [
    ...first.puts(),
    ...second.puts(),
    ...third.puts(),
  ]);

  const view = viewOf(rows, [
    setText(first.part.id, "First, edited", 200),
    // In the same millisecond: the two would be told apart by nothing but
    // their IDs, which say nothing of the order in which they were made.
    setText(second.part.id, "Second, edited", 200),
    // After the clock of the device was set back.
    setText(third.part.id, "Third, edited", 150),
  ]);

  expect(changed(view, first)).toBe(200);
  expect(changed(view, second)).toBe(201);
  expect(changed(view, third)).toBe(202);
});

it("runs a pending mutation after every time that the server has put into a channel or a target", () => {
  const { post, part, puts } = draft("Text", 1_000);
  const channel = {
    id: newId(),
    network: "mastodon",
    accountId: "1@mastodon.example",
    handle: "@ada@mastodon.example",
    name: "Ada Lovelace",
    avatarUrl: null,
    profileUrl: null,
    status: "connected",
    connectedAt: 2_000,
    expiresAt: null,
    limits: { network: "mastodon", maxCharacters: 500, charactersPerUrl: 23 },
    limitsCheckedAt: 3_000,
  } as const;
  const target = {
    id: newId(),
    postId: newId(),
    channelId: channel.id,
    status: "sent",
    attempt: 1,
    error: null,
    queuedAt: 4_000,
    sentAt: 5_000,
    disconnected: false,
  } as const;
  const edit = [setText(part.id, "Edited", 10)];
  const edited = (rows: Tables) => viewOf(rows, edit).post.get(post.id);

  // The server ran a mutation at each of these times, and will run the
  // edit after all of them: the clock of the device, which says 10, is far
  // behind. Each row is looked at by itself, so that no column is missed.
  const rows = applyChanges(emptyTables(), false, puts());
  expect(edited(rows)?.updatedAt).toBe(1_001);
  const connected = applyChanges(rows, false, [
    { op: "put", table: "channel", row: { ...channel, limitsCheckedAt: null } },
  ]);
  expect(edited(connected)?.updatedAt).toBe(2_001);
  const asked = applyChanges(rows, false, [
    { op: "put", table: "channel", row: channel },
  ]);
  expect(edited(asked)?.updatedAt).toBe(3_001);
  const queued = applyChanges(rows, false, [
    { op: "put", table: "post_target", row: { ...target, sentAt: null } },
  ]);
  expect(edited(queued)?.updatedAt).toBe(4_001);
  const sent = applyChanges(rows, false, [
    { op: "put", table: "post_target", row: target },
  ]);
  expect(edited(sent)?.updatedAt).toBe(5_001);
  // Another post, which the server has held: `heldAt` is a time of the
  // server's too.
  const held = applyChanges(rows, false, [
    {
      op: "put",
      table: "post",
      row: {
        id: newId(),
        status: "scheduled",
        createdAt: 1,
        updatedAt: 1,
        mode: "custom",
        dueAt: 5,
        queuePosition: null,
        heldAt: 6_000,
        trashedAt: null,
      },
    },
  ]);
  expect(edited(held)?.updatedAt).toBe(6_001);
  // And one that was put aside: `trashedAt` is one as well.
  const aside = applyChanges(rows, false, [
    {
      op: "put",
      table: "post",
      row: {
        id: newId(),
        status: "scheduled",
        createdAt: 1,
        updatedAt: 1,
        mode: "custom",
        dueAt: 5,
        queuePosition: null,
        heldAt: null,
        trashedAt: 7_000,
      },
    },
  ]);
  expect(edited(aside)?.updatedAt).toBe(7_001);
});

it("lets a pending mutation see what the ones before it did", () => {
  const id = newId();
  const partId = newId();
  const created: MutationCall = {
    name: "post.create",
    args: { id, partId, text: "" },
    at: 1,
  };

  const edited = viewOf(emptyTables(), [created, setText(partId, "Hi", 2)]);
  expect(edited.post_part.get(partId)?.text).toBe("Hi");
  expect(edited.post.get(id)).toMatchObject({ createdAt: 1, updatedAt: 2 });

  // Deleting finds the part by its post, among rows that exist only in the
  // mutations before it.
  const deleted = viewOf(emptyTables(), [
    created,
    { name: "post.delete", args: { id }, at: 3 },
  ]);
  expect(deleted.post.size).toBe(0);
  expect(deleted.post_part.size).toBe(0);
});

it("goes on after a mutation that fails", () => {
  const { part, puts } = draft("Text");
  const rows = applyChanges(emptyTables(), false, puts());

  const view = viewOf(rows, [
    // Not a mutation at all, and one with arguments that are not its own.
    { name: "post.archive", args: {}, at: 0 },
    { name: "part.setText", args: { id: part.id }, at: 0 },
    setText(part.id, "Still here"),
  ]);

  expect(view.post_part.get(part.id)?.text).toBe("Still here");
});

it("keeps a table that no mutation writes to as the same object", () => {
  const rows = applyChanges(emptyTables(), false, draft("Text").puts());

  // Deleting a post that does not exist writes nothing to the parts.
  const view = viewOf(rows, [
    { name: "post.delete", args: { id: newId() }, at: 0 },
  ]);

  expect(view.post_part).toBe(rows.post_part);
});
