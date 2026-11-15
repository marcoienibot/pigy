import { expect, it } from "vitest";
import { draft, newId } from "../../../test/sync-browser.ts";
import { syncLimits, syncSchemaVersion } from "../protocol.ts";
import { maxPartTextLength } from "../tables.ts";
import {
  appendMutations,
  applyChanges,
  applyPatch,
  applyWrite,
  type Copy,
  dismissRejection,
  emptyTables,
  type Head,
  type MutationCall,
  nextBatch,
  openCopy,
  type Step,
} from "./copy.ts";

/** A copy that was just made, as a tab holds it. */
function newCopy(): Copy {
  const { write } = openCopy(undefined, newId());
  if (!write) throw new Error("A new copy is a write");
  return {
    head: { meta: write.meta, outbox: [], rejections: [] },
    tables: emptyTables(),
  };
}

/** Runs a step on `copy` and returns the copy after it and its outcome. */
function step<Result>(copy: Copy, change: (head: Head) => Step<Result>) {
  const { write, result } = change(copy.head);
  return { copy: write ? applyWrite(copy, write) : copy, result, write };
}

function setText(id: string, text: string, at = 0): MutationCall {
  return { name: "part.setText", args: { id, text }, at };
}

function append(copy: Copy, ...calls: MutationCall[]): Copy {
  return step(copy, (head) => appendMutations(head, calls)).copy;
}

/** The copy after the server has confirmed its mutations up to `id`. */
function confirm(copy: Copy, id: number): Copy {
  const { copy: after, result } = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: head.meta.cursor,
        to: (head.meta.cursor ?? 0) + 1,
        changes: [],
        lastMutationId: id,
        rejected: [],
      },
      newId(),
    ),
  );
  expect(result).toBe("applied");
  return after;
}

it("makes a copy that has applied no patch and made no mutation", () => {
  const clientId = newId();

  expect(openCopy(undefined, clientId)).toEqual({
    write: {
      meta: {
        clientId,
        cursor: null,
        lastMutationId: 0,
        madeMutationId: 0,
        sentMutationId: 0,
        schemaVersion: syncSchemaVersion,
        version: 1,
      },
    },
    result: "ready",
  });
});

it("leaves a copy of this schema as it is", () => {
  const copy = newCopy();

  expect(openCopy(copy.head, newId())).toEqual({
    write: null,
    result: "ready",
  });
});

it("drops the rows of an older schema and keeps the client and its mutations", () => {
  const { post, part, puts } = draft("Old");
  let copy = append(newCopy(), setText(part.id, "One"));
  copy = step(copy, (head) =>
    applyPatch(
      head,
      { from: null, to: 5, changes: puts(), lastMutationId: 1, rejected: [] },
      newId(),
    ),
  ).copy;
  copy = append(copy, setText(part.id, "Two"));
  const old = {
    ...copy,
    head: {
      ...copy.head,
      meta: { ...copy.head.meta, schemaVersion: syncSchemaVersion - 1 },
    },
  };

  const { copy: opened, result } = step(old, (head) => openCopy(head, newId()));

  expect(result).toBe("ready");
  // SYNC.md section 6: the next hello asks for every row, as the same
  // client, which still knows what became of its mutations.
  expect(opened.tables.post.has(post.id)).toBe(false);
  expect(opened.head.meta).toMatchObject({
    clientId: copy.head.meta.clientId,
    cursor: null,
    lastMutationId: 1,
    madeMutationId: 2,
    schemaVersion: syncSchemaVersion,
  });
  expect(opened.head.outbox).toEqual(copy.head.outbox);
});

it("does not touch a copy of a newer schema", () => {
  const copy = newCopy();
  const newer = {
    ...copy.head,
    meta: { ...copy.head.meta, schemaVersion: syncSchemaVersion + 1 },
  };

  expect(openCopy(newer, newId())).toEqual({
    write: null,
    result: "outdated",
  });
});

it("numbers mutations from 1, by one", () => {
  const partId = newId();
  const copy = append(
    newCopy(),
    { name: "post.create", args: { id: newId(), partId, text: "" }, at: 5 },
    setText(partId, "Hello", 6),
    { name: "post.delete", args: { id: newId() }, at: 7 },
  );

  expect(copy.head.outbox.map(({ id, name, at }) => [id, name, at])).toEqual([
    [1, "post.create", 5],
    [2, "part.setText", 6],
    [3, "post.delete", 7],
  ]);
  expect(copy.head.meta.madeMutationId).toBe(3);
});

it("goes on counting after the mutations before were confirmed", () => {
  // As after a restart with an empty outbox: only the meta knows which IDs
  // were used. Starting at 1 again would make the server skip the mutation
  // as one that it has processed.
  let copy = append(newCopy(), setText(newId(), "One"), setText(newId(), "2"));
  copy = confirm(copy, 2);
  expect(copy.head.outbox).toEqual([]);

  copy = append(copy, setText(newId(), "Three"));

  expect(copy.head.outbox.map(({ id }) => id)).toEqual([3]);
});

it("keeps only the last of the texts typed into one part", () => {
  const partId = newId();
  let copy = append(newCopy(), setText(partId, "H", 1));
  copy = append(copy, setText(partId, "He", 2), setText(partId, "Hey", 3));

  expect(copy.head.outbox).toEqual([
    { id: 1, name: "part.setText", args: { id: partId, text: "Hey" }, at: 3 },
  ]);
  // No ID was used up by the texts in between.
  expect(copy.head.meta.madeMutationId).toBe(1);
});

it("does not replace a mutation that may have been sent", () => {
  const partId = newId();
  let copy = append(newCopy(), setText(partId, "H"));
  // Sending marks the mutation. The server may have run it by now, and
  // would skip another text that came under the same ID.
  const sent = step(copy, (head) => nextBatch(head, newId()));
  expect(sent.result).toEqual([
    { id: 1, name: "part.setText", args: { id: partId, text: "H" } },
  ]);
  copy = sent.copy;

  copy = append(copy, setText(partId, "He"), setText(partId, "Hey"));

  expect(copy.head.outbox.map(({ id, args }) => [id, args])).toEqual([
    [1, { id: partId, text: "H" }],
    // The two that were made after the first was sent are one again.
    [2, { id: partId, text: "Hey" }],
  ]);
});

it("replaces only the mutation right before, and only for the same part", () => {
  const first = newId();
  const second = newId();
  const copy = append(
    newCopy(),
    setText(first, "A"),
    setText(second, "B"),
    // Not replaced by this one: the text of the other part is in between,
    // and mutations run in the order they were made.
    setText(first, "AA"),
    { name: "post.delete", args: { id: newId() }, at: 0 },
    { name: "post.delete", args: { id: newId() }, at: 0 },
  );

  expect(copy.head.outbox.map(({ id, name }) => [id, name])).toEqual([
    [1, "part.setText"],
    [2, "part.setText"],
    [3, "part.setText"],
    // Deleting has no rule that lets one stand for two.
    [4, "post.delete"],
    [5, "post.delete"],
  ]);
});

it("takes note of a rejection once, however often it is told", () => {
  const first = draft("First");
  const second = draft("Second");
  let copy = newCopy();
  // Two parts, so that the second mutation does not replace the first.
  copy = append(
    copy,
    setText(first.part.id, "One"),
    setText(second.part.id, "Two"),
  );
  // Both mutations are confirmed, the first as rejected.
  copy = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 1,
        changes: second.puts("Two"),
        lastMutationId: 2,
        rejected: [{ id: 1, code: "not_found", message: "Gone" }],
      },
      newId(),
    ),
  ).copy;
  expect(copy.head.rejections).toHaveLength(1);

  // What the server answers to a hello that was sent with an older
  // `lastMutationId`: the hello of a tab that took the socket over while
  // the tab before it was still storing the patch above. The answer tells
  // of the rejection again. SYNC.md section 3, step 4.
  const { copy: after, result } = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: 1,
        to: 1,
        changes: [],
        lastMutationId: 2,
        rejected: [{ id: 1, code: "not_found", message: "Gone" }],
      },
      newId(),
    ),
  );

  expect(result).toBe("applied");
  // The person is not told twice of one refused change.
  expect(after.head.rejections).toHaveLength(1);
});

it("applies a patch to the rows, the cursor and the outbox in one write", () => {
  const kept = draft("Kept");
  const gone = draft("Gone");
  const changed = draft("Before");
  let copy = newCopy();
  copy = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 3,
        changes: [...kept.puts(), ...gone.puts(), ...changed.puts()],
        lastMutationId: 0,
        rejected: [],
      },
      newId(),
    ),
  ).copy;
  copy = append(
    copy,
    setText(changed.part.id, "After"),
    setText(kept.part.id, "Later"),
  );

  const { write, result } = applyPatch(
    copy.head,
    {
      from: 3,
      to: 5,
      changes: [...gone.deletes(), ...changed.puts("After")],
      lastMutationId: 1,
      rejected: [],
    },
    newId(),
  );
  if (!write) throw new Error("A patch that applies is a write");
  const after = applyWrite(copy, write);

  expect(result).toBe("applied");
  expect(after.head.meta).toMatchObject({ cursor: 5, lastMutationId: 1 });
  expect([...after.tables.post.keys()].sort()).toEqual(
    [kept.post.id, changed.post.id].sort(),
  );
  expect(after.tables.post_part.get(changed.part.id)?.text).toBe("After");
  // The mutation that the patch confirms goes, the one after it stays.
  expect(after.head.outbox.map(({ id }) => id)).toEqual([2]);
  // A table that the patch did not touch would be the same object. Both
  // were touched here, and neither was changed in place.
  expect(copy.tables.post.has(gone.post.id)).toBe(true);
});

it("forgets every row before it applies a snapshot", () => {
  const before = draft("Before");
  const after = draft("After");
  let copy = step(newCopy(), (head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 2,
        changes: before.puts(),
        lastMutationId: 0,
        rejected: [],
      },
      newId(),
    ),
  ).copy;

  // A snapshot applies at any cursor: `from` is not compared.
  copy = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 9,
        changes: after.puts(),
        lastMutationId: 0,
        rejected: [],
      },
      newId(),
    ),
  ).copy;

  expect([...copy.tables.post.keys()]).toEqual([after.post.id]);
  expect([...copy.tables.post_part.keys()]).toEqual([after.part.id]);
  expect(copy.head.meta.cursor).toBe(9);
});

it("refuses a patch that does not follow the cursor", () => {
  const copy = confirm(newCopy(), 0);
  expect(copy.head.meta.cursor).toBe(1);

  const outcome = applyPatch(
    copy.head,
    {
      from: 2,
      to: 3,
      changes: draft("Missed").puts(),
      lastMutationId: 0,
      rejected: [],
    },
    newId(),
  );

  expect(outcome).toEqual({ write: null, result: "gap" });
});

it("keeps what was rejected, with the mutation that it was", () => {
  const partId = newId();
  const other = newId();
  let copy = append(newCopy(), setText(partId, "Lost"), setText(other, "Fine"));

  copy = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: null,
        to: 4,
        changes: [],
        lastMutationId: 2,
        rejected: [{ id: 1, code: "not_found", message: "No such post" }],
      },
      newId(),
    ),
  ).copy;

  expect(copy.head.outbox).toEqual([]);
  expect(copy.head.rejections).toEqual([
    {
      key: `${copy.head.meta.clientId}/1`,
      name: "part.setText",
      args: { id: partId, text: "Lost" },
      code: "not_found",
      message: "No such post",
    },
  ]);

  const [rejection] = copy.head.rejections;
  copy = step(copy, (head) =>
    dismissRejection(head, rejection?.key ?? ""),
  ).copy;
  expect(copy.head.rejections).toEqual([]);
});

it("starts over when the server knows of a mutation that the copy never made", () => {
  const { puts } = draft("Row");
  let copy = step(newCopy(), (head) =>
    applyPatch(
      head,
      { from: null, to: 2, changes: puts(), lastMutationId: 0, rejected: [] },
      newId(),
    ),
  ).copy;
  copy = append(copy, setText(newId(), "One"), setText(newId(), "Two"));
  const clientId = newId();

  // The copy has made two mutations and the server has processed three:
  // the copy has lost part of itself, as after a restore from a backup.
  const { copy: after, result } = step(copy, (head) =>
    applyPatch(
      head,
      {
        from: 2,
        to: 3,
        changes: [],
        lastMutationId: 3,
        rejected: [{ id: 2, code: "not_found", message: "No such post" }],
      },
      clientId,
    ),
  );

  expect(result).toBe("start-over");
  expect(after.head.meta).toMatchObject({
    clientId,
    cursor: null,
    lastMutationId: 0,
    madeMutationId: 0,
    sentMutationId: 0,
  });
  // The server has run other mutations under the IDs of these two. They
  // are gone, and the rejection is of one of the others.
  expect(after.head.outbox).toEqual([]);
  expect(after.head.rejections).toEqual([]);
});

it("sends the outbox from its start and marks it as sent", () => {
  const first = newId();
  const second = newId();
  const copy = append(newCopy(), setText(first, "A", 7), setText(second, "B"));

  const { copy: after, result } = step(copy, (head) =>
    nextBatch(head, newId()),
  );

  // As the protocol has them: without the time they were made.
  expect(result).toEqual([
    { id: 1, name: "part.setText", args: { id: first, text: "A" } },
    { id: 2, name: "part.setText", args: { id: second, text: "B" } },
  ]);
  expect(after.head.meta.sentMutationId).toBe(2);
  // Sending again, as after a lost socket, is no write: nothing is new.
  expect(nextBatch(after.head, newId())).toEqual({ write: null, result });
});

it("has nothing to send from an empty outbox", () => {
  expect(nextBatch(newCopy().head, newId())).toEqual({
    write: null,
    result: null,
  });
});

it("puts no more mutations in a message than the server takes", () => {
  const calls = Array.from(
    { length: syncLimits.mutationsPerMessage + 1 },
    (_, index) => setText(newId(), String(index)),
  );
  const copy = append(newCopy(), ...calls);

  const { copy: after, result } = step(copy, (head) =>
    nextBatch(head, newId()),
  );

  expect(result).toHaveLength(syncLimits.mutationsPerMessage);
  // The one that did not fit is not marked: it can still be replaced.
  expect(after.head.meta.sentMutationId).toBe(syncLimits.mutationsPerMessage);
});

it("keeps a message under the length that the server takes", () => {
  // Texts of the greatest length, of a character that JSON spells with six.
  const text = "\u0001".repeat(maxPartTextLength);
  const copy = append(
    newCopy(),
    ...Array.from({ length: 10 }, () => setText(newId(), text)),
  );

  const { result } = nextBatch(copy.head, newId());

  if (!Array.isArray(result)) throw new Error("There are mutations to send");
  const message = JSON.stringify({ type: "mutate", mutations: result });
  expect(message.length).toBeLessThanOrEqual(syncLimits.clientMessageLength);
  // As many as fit: one more would have been too long.
  const next = copy.head.outbox[result.length];
  expect(message.length + JSON.stringify(next).length).toBeGreaterThan(
    syncLimits.clientMessageLength,
  );
});

it("starts over, and numbers its mutations again, when the one the server expects is missing", () => {
  const first = newId();
  const second = newId();
  // Two mutations were confirmed, two more were made since.
  let copy = append(newCopy(), setText(newId(), "A"), setText(newId(), "B"));
  copy = confirm(copy, 2);
  copy = append(copy, setText(first, "C", 3), setText(second, "D", 4));
  // The answer to a hello, from a server that has gone back to a state in
  // which it has processed nothing of this client. It expects mutation 1
  // next, which the copy dropped long ago.
  copy = confirm(copy, 0);
  const clientId = newId();

  const { copy: after, result } = step(copy, (head) =>
    nextBatch(head, clientId),
  );

  expect(result).toBe("start-over");
  expect(after.head.meta).toMatchObject({
    clientId,
    cursor: null,
    lastMutationId: 0,
    madeMutationId: 2,
    sentMutationId: 0,
  });
  // The server has processed none of the mutations that are left, so they
  // are kept, in their order, as the first two of the new client.
  expect(after.head.outbox).toEqual([
    { id: 1, name: "part.setText", args: { id: first, text: "C" }, at: 3 },
    { id: 2, name: "part.setText", args: { id: second, text: "D" }, at: 4 },
  ]);
});

it("changes rows without changing the tables it was given", () => {
  const { post, part, puts } = draft("Text");
  const before = applyChanges(emptyTables(), false, puts());

  const after = applyChanges(before, false, [
    { op: "delete", table: "post_part", id: part.id },
  ]);

  expect(before.post_part.has(part.id)).toBe(true);
  expect(after.post_part.has(part.id)).toBe(false);
  // The table that no change names is not copied: whoever shows it can
  // tell that it is the same.
  expect(after.post).toBe(before.post);
  expect(after.post.get(post.id)).toEqual(post);
});
