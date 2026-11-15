import type { MutatorArgs, MutatorName, RejectionCode } from "../mutators.ts";
import {
  type Change,
  type Mutation,
  type Rejection,
  syncLimits,
  syncSchemaVersion,
} from "../protocol.ts";
import { type Row, type TableName, tableNames } from "../tables.ts";

/**
 * The local copy of a workspace that a client keeps, as SYNC.md describes
 * it, and every way it changes. A change is a function from what is stored
 * to what to store instead: a storage runs it as one atomic step, and the
 * tabs that share the copy apply the same `Write` to what they hold in
 * memory. Nothing here does anything but compute, so that the rules of the
 * protocol can be tested without a browser and without a server.
 */

/** The rows of the synced tables. A value of this type is never changed. */
export type Tables = {
  readonly [Table in TableName]: ReadonlyMap<string, Row<Table>>;
};

export function emptyTables(): Tables {
  // `fromEntries` forgets which keys it was given.
  return Object.fromEntries(
    tableNames.map((table) => [table, new Map()]),
  ) as Record<TableName, Map<string, never>>;
}

/**
 * `tables` after `changes`, the way a patch changes rows: after forgetting
 * every row if `clear` is set. Tables that nothing changes are the same
 * objects as before.
 */
export function applyChanges(
  tables: Tables,
  clear: boolean,
  changes: readonly Change[],
): Tables {
  // A row of any table: the compiler cannot follow which table a change is
  // for once it is in a map by name. The changes say it, and they are
  // validated where they come in.
  const next = new Map<TableName, Map<string, Row<TableName>>>();
  const writable = (table: TableName) => {
    let rows = next.get(table);
    if (!rows) {
      rows = new Map<string, Row<TableName>>(clear ? [] : tables[table]);
      next.set(table, rows);
    }
    return rows;
  };
  if (clear) for (const table of tableNames) writable(table);
  for (const change of changes) {
    if (change.op === "put") {
      writable(change.table).set(change.row.id, change.row);
    } else if (tables[change.table].has(change.id) && !clear) {
      writable(change.table).delete(change.id);
    }
  }
  return next.size === 0
    ? tables
    : ({ ...tables, ...Object.fromEntries(next) } as Tables);
}

/** A mutation that the server has not confirmed. */
export type PendingMutation = Mutation & {
  /**
   * When it was made, in milliseconds since the Unix epoch, by the clock of
   * the client. It is the time that the mutator sees when the mutation is
   * run for display.
   */
  at: number;
};

/** A mutation as the app makes it: it has no ID yet. */
export type MutationCall = Omit<PendingMutation, "id">;

/** A rejected mutation that the person has yet to be told of. */
export type StoredRejection = {
  /** Unique among the rejections of a copy. */
  key: string;
  /** The mutation that was rejected. */
  name: string;
  args: unknown;
  code: RejectionCode;
  /** For people. */
  message: string;
};

/** What a copy holds apart from rows and mutations. */
export type Meta = {
  clientId: string;
  /** The `to` of the last patch that was applied, null if there is none. */
  cursor: number | null;
  /** The `lastMutationId` of that patch, 0 if there is none. */
  lastMutationId: number;
  /**
   * The ID of the last mutation that was made under `clientId`, 0 if there
   * is none. The next one gets the ID after it.
   */
  madeMutationId: number;
  /**
   * The mutations up to this ID may have reached the server, so they stay
   * as they are. A later one can still be replaced by its successor.
   */
  sentMutationId: number;
  /** The `syncSchemaVersion` that the rows are of. */
  schemaVersion: number;
  /**
   * Counts the writes to the stored copy. A tab that is handed write 7 while
   * it is at 5 knows that it has missed one, and reads the copy again.
   */
  version: number;
};

/** A copy without its rows: what a change needs to look at. */
export type Head = {
  meta: Meta;
  /** The unconfirmed mutations, in the order of their IDs. */
  outbox: PendingMutation[];
  rejections: StoredRejection[];
};

/** One change of a stored copy. What it does not name stays as it is. */
export type Write = {
  /** The meta after the write. Its `version` is one more than before. */
  meta: Meta;
  /** Rows to forget and to change, as a patch does. */
  rows?: { clear: boolean; changes: Change[] };
  /**
   * `delete` names mutations by ID. `clear` drops all of them first, and
   * `put` adds mutations or replaces those with the same ID.
   */
  outbox?: { clear: boolean; delete: number[]; put: PendingMutation[] };
  /** `delete` names rejections by key. */
  rejections?: { delete: string[]; put: StoredRejection[] };
};

/** What a change comes to: what to store, if anything, and its outcome. */
export type Step<Result> = { write: Write | null; result: Result };

/** A copy as a tab holds it in memory. */
export type Copy = { head: Head; tables: Tables };

/** `copy` after `write`. */
export function applyWrite(copy: Copy, write: Write): Copy {
  let { outbox, rejections } = copy.head;
  if (write.outbox) {
    const deleted = new Set(write.outbox.delete);
    const put = new Map(
      write.outbox.put.map((mutation) => [mutation.id, mutation]),
    );
    outbox = (write.outbox.clear ? [] : outbox)
      .filter(({ id }) => !deleted.has(id) && !put.has(id))
      .concat(write.outbox.put)
      .sort((a, b) => a.id - b.id);
  }
  if (write.rejections) {
    const gone = new Set([
      ...write.rejections.delete,
      ...write.rejections.put.map(({ key }) => key),
    ]);
    rejections = rejections
      .filter(({ key }) => !gone.has(key))
      .concat(write.rejections.put);
  }
  return {
    head: { meta: write.meta, outbox, rejections },
    tables: write.rows
      ? applyChanges(copy.tables, write.rows.clear, write.rows.changes)
      : copy.tables,
  };
}

/** `meta` with `fields` replaced, as the next write of the copy. */
function next(meta: Meta, fields: Partial<Meta> = {}): Meta {
  return { ...meta, ...fields, version: meta.version + 1 };
}

/**
 * The first step of every tab: makes the copy if there is none, and brings
 * one of an older schema to this one. Returns whether this tab can work
 * with the copy. It cannot if a newer version of the app has left rows of a
 * schema that this one does not know.
 */
export function openCopy(
  head: Head | undefined,
  newClientId: string,
): Step<"ready" | "outdated"> {
  if (!head) {
    return {
      write: {
        meta: {
          clientId: newClientId,
          cursor: null,
          lastMutationId: 0,
          madeMutationId: 0,
          sentMutationId: 0,
          schemaVersion: syncSchemaVersion,
          version: 1,
        },
      },
      result: "ready",
    };
  }
  if (head.meta.schemaVersion > syncSchemaVersion) {
    return { write: null, result: "outdated" };
  }
  if (head.meta.schemaVersion < syncSchemaVersion) {
    // SYNC.md section 6: the rows go and the next hello asks for all of
    // them. The client ID, the `lastMutationId` and the unconfirmed
    // mutations stay.
    return {
      write: {
        meta: next(head.meta, {
          cursor: null,
          schemaVersion: syncSchemaVersion,
        }),
        rows: { clear: true, changes: [] },
      },
      result: "ready",
    };
  }
  return { write: null, result: "ready" };
}

/**
 * When a mutation makes the one before it pointless: running both does to
 * the rows what running the later one alone does. Typing sets the text of a
 * part with every keystroke, and offline only the last of them is worth
 * keeping. A mutator that is not listed is never replaced.
 */
const supersedes: {
  [Name in MutatorName]?: (
    earlier: MutatorArgs<Name>,
    later: MutatorArgs<Name>,
  ) => boolean;
} = {
  "part.setText": (earlier, later) => earlier.id === later.id,
};

function replaces(later: MutationCall, earlier: PendingMutation): boolean {
  if (later.name !== earlier.name || !Object.hasOwn(supersedes, later.name)) {
    return false;
  }
  // The arguments are those of the mutator that both mutations name: the
  // app can only make a mutation with the arguments of its mutator.
  const rule = supersedes[later.name as MutatorName] as (
    earlier: unknown,
    later: unknown,
  ) => boolean;
  return rule(earlier.args, later.args);
}

/**
 * Adds mutations that the app has made to the outbox, in order, and gives
 * each the ID after the last one made.
 *
 * A mutation takes the place of the one before it, and its ID, if it makes
 * that one pointless and that one cannot have been sent: the server may
 * have run a mutation that was sent, and would skip another under its ID.
 */
export function appendMutations(
  head: Head,
  calls: readonly MutationCall[],
): Step<void> {
  let { madeMutationId } = head.meta;
  let last = head.outbox.at(-1);
  const put = new Map<number, PendingMutation>();
  for (const call of calls) {
    if (last && last.id > head.meta.sentMutationId && replaces(call, last)) {
      last = { ...call, id: last.id };
    } else {
      madeMutationId += 1;
      last = { ...call, id: madeMutationId };
    }
    put.set(last.id, last);
  }
  if (put.size === 0) return { write: null, result: undefined };
  return {
    write: {
      meta: next(head.meta, { madeMutationId }),
      outbox: { clear: false, delete: [], put: [...put.values()] },
    },
    result: undefined,
  };
}

/**
 * Starts over, as SYNC.md section 1 has it: the copy becomes that of a new
 * client that has applied no patch. The unconfirmed mutations that are left
 * are numbered again from 1, in their order.
 *
 * The rows stay until the answer to the next hello replaces them: it is a
 * snapshot, because the cursor is null.
 */
function startOver(head: Head, newClientId: string): Write {
  const outbox = head.outbox.map((mutation, index) => ({
    ...mutation,
    id: index + 1,
  }));
  return {
    meta: next(head.meta, {
      clientId: newClientId,
      cursor: null,
      lastMutationId: 0,
      madeMutationId: outbox.length,
      sentMutationId: 0,
    }),
    outbox: { clear: true, delete: [], put: outbox },
  };
}

/** A patch as a client has it once all its messages are in. */
export type Patch = {
  from: number | null;
  to: number;
  changes: Change[];
  lastMutationId: number;
  rejected: Rejection[];
};

/**
 * Applies a patch, which is steps 1 to 4 of SYNC.md section 3 in one write:
 * the rows, the cursor, the `lastMutationId`, the mutations that the patch
 * confirms and the rejections among them.
 *
 * - `gap`: the patch does not follow the cursor, so one was missed. Nothing
 *   is written. The client connects again.
 * - `start-over`: the server has processed a mutation that this copy never
 *   made. Part of the copy was lost, so it starts over, with `newClientId`.
 *   The client connects again.
 */
export function applyPatch(
  head: Head,
  patch: Patch,
  newClientId: string,
): Step<"applied" | "gap" | "start-over"> {
  const { meta } = head;
  if (patch.from !== null && patch.from !== meta.cursor) {
    return { write: null, result: "gap" };
  }
  if (patch.lastMutationId > meta.madeMutationId) {
    // Every mutation that is left has an ID that the server has processed,
    // for another mutation: none of them will ever run. What the patch says
    // of rejections is about those other mutations.
    return {
      write: startOver({ ...head, outbox: [] }, newClientId),
      result: "start-over",
    };
  }
  const confirmed = head.outbox.filter(({ id }) => id <= patch.lastMutationId);
  const rejections = patch.rejected.flatMap(({ id, code, message }) => {
    const mutation = confirmed.find((candidate) => candidate.id === id);
    // The key holds the client ID because the IDs of mutations begin again
    // when the copy starts over.
    return mutation
      ? [
          {
            key: `${meta.clientId}/${id}`,
            name: mutation.name,
            args: mutation.args,
            code,
            message,
          },
        ]
      : [];
  });
  return {
    write: {
      meta: next(meta, {
        cursor: patch.to,
        lastMutationId: patch.lastMutationId,
      }),
      rows: { clear: patch.from === null, changes: patch.changes },
      ...(confirmed.length > 0 && {
        outbox: {
          clear: false,
          delete: confirmed.map(({ id }) => id),
          put: [],
        },
      }),
      ...(rejections.length > 0 && {
        rejections: { delete: [], put: rejections },
      }),
    },
    result: "applied",
  };
}

/** The length of a `mutate` message with no mutations in it. */
const emptyMutateLength = JSON.stringify({
  type: "mutate",
  mutations: [],
}).length;

/**
 * The mutations to send next, on a socket whose hello has been answered and
 * that waits for no answer to a `mutate`: the first of the outbox, as many
 * as fit in one message. They are marked as sent in the same step, so that
 * none of them is replaced afterwards. Null if there is nothing to send.
 *
 * `start-over`: the server expects the mutation after `lastMutationId` and
 * the copy does not have it. It was lost, or the server has gone back to an
 * earlier state. The copy starts over with `newClientId` and keeps its
 * mutations. The client connects again.
 */
export function nextBatch(
  head: Head,
  newClientId: string,
): Step<Mutation[] | "start-over" | null> {
  const { meta, outbox } = head;
  const [first] = outbox;
  if (!first) return { write: null, result: null };
  if (first.id !== meta.lastMutationId + 1) {
    return { write: startOver(head, newClientId), result: "start-over" };
  }

  const batch: Mutation[] = [];
  let length = emptyMutateLength;
  for (const { id, name, args } of outbox) {
    const mutation = { id, name, args };
    // One more for the comma between two mutations.
    length += JSON.stringify(mutation).length + (batch.length > 0 ? 1 : 0);
    if (
      batch.length > 0 &&
      (batch.length === syncLimits.mutationsPerMessage ||
        length > syncLimits.clientMessageLength)
    ) {
      break;
    }
    batch.push(mutation);
  }
  const sentMutationId = batch.at(-1)?.id ?? 0;
  return {
    write:
      sentMutationId > meta.sentMutationId
        ? { meta: next(meta, { sentMutationId }) }
        : null,
    result: batch,
  };
}

/** Forgets a rejection: the person has been told. */
export function dismissRejection(head: Head, key: string): Step<void> {
  if (!head.rejections.some((rejection) => rejection.key === key)) {
    return { write: null, result: undefined };
  }
  return {
    write: {
      meta: next(head.meta),
      rejections: { delete: [key], put: [] },
    },
    result: undefined,
  };
}
