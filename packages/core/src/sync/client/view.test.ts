import { expect, it } from "vitest";
import { draft, newId } from "../../../test/sync-browser.ts";
import { applyChanges, emptyTables, type MutationCall } from "./copy.ts";
import { viewOf } from "./view.ts";

function setText(id: string, text: string, at = 0): MutationCall {
  return { name: "part.setText", args: { id, text }, at };
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
