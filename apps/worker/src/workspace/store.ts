import {
  applyMutation,
  type Change,
  environmentSchema,
  type Mutation,
  MutationRejected,
  type MutationSource,
  type MutatorArgs,
  type Network,
  type Rejection,
  type RejectionCode,
  type Row,
  type TableName,
  type Transaction,
  tableNames,
} from "@pigy/core";
import { and, asc, count, eq, gt, lte } from "drizzle-orm";
import {
  type DrizzleSqliteDODatabase,
  drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "./migrations/migrations.js";
import {
  changeLog,
  channels,
  clientMutations,
  rejections,
  workspaceRecord,
} from "./schema.ts";
import { deleteRow, findRows, readRow, readRows, writeRow } from "./synced.ts";

/**
 * How many of the latest changes the change log covers. A client that has
 * missed more than these gets a snapshot.
 */
export const changeLogWindow = 1000;

/** A workspace as the `workspace` table of D1 has it. */
export const workspaceIdentitySchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  environment: environmentSchema,
});

export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

/** A mutation as it is run: where it came from does not matter here. */
type MutatorCall = { name: string; args: unknown };

/** Why a mutation was refused. */
export type Refusal = { code: RejectionCode; message: string };

/**
 * What the object keeps for a channel besides its row, and what clients
 * never see: the access to the account.
 */
export type ChannelAccess = {
  /**
   * The credentials as the Worker sealed them. The object cannot read
   * them.
   */
  credentials: string;
  /** When to refresh them, in milliseconds since the epoch, or null. */
  refreshAt: number | null;
};

/** The channel that an account was stored as, or why it was not. */
export type ConnectChannelOutcome =
  | { ok: true; channelId: string }
  | ({ ok: false } & Refusal);

/** What it takes to act for the account of a channel. */
export type StoredChannelAccess = {
  network: Network;
  accountId: string;
  /** Sealed. Null for a channel that was stored without. */
  credentials: string | null;
};

/**
 * The access that a channel held when it was removed, or why it was not
 * removed: `not_found` if there is no such channel.
 */
export type DisconnectChannelOutcome =
  | { ok: true; access: StoredChannelAccess }
  | ({ ok: false } & Refusal);

/**
 * The longest reason that a refusal carries. Part of a reason can be text
 * that the client sent, such as the name of an argument that the mutator
 * does not take, and the reasons are stored.
 */
export const maxRefusalMessageLength = 200;

/**
 * Thrown in place of what the database threw, when it failed for a reason
 * of its own: it is full, say, or cannot be read. Running the mutation
 * again later can work.
 */
class StorageFailure extends Error {
  constructor(cause: unknown) {
    super("The database of the workspace failed", { cause });
  }
}

/**
 * Carries the reason why a mutation was refused out of the transaction that
 * undoes what it wrote.
 */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

/**
 * What takes a client from the cursor `from` to the cursor `to`. With `from`
 * null it is a snapshot: every row there is.
 */
export type Patch = { from: number | null; to: number; changes: Change[] };

/**
 * The `Transaction` that a mutator gets on the server. It reads and writes
 * the database through the synced columns, and notes which rows it changed.
 */
class RecordingTransaction implements Transaction {
  /** The rows written or deleted, each once. */
  readonly changed = new Map<string, { table: TableName; id: string }>();

  constructor(
    private readonly db: DrizzleSqliteDODatabase,
    readonly now: number,
  ) {}

  get<Table extends TableName>(table: Table, id: string) {
    return this.stored(() => readRow(this.db, table, id));
  }

  find<Table extends TableName, Column extends keyof Row<Table>>(
    table: Table,
    column: Column,
    value: Row<Table>[Column],
  ) {
    return this.stored(() => findRows(this.db, table, String(column), value));
  }

  put<Table extends TableName>(table: Table, row: Row<Table>) {
    this.stored(() => writeRow(this.db, table, row));
    this.note(table, row.id);
  }

  delete(table: TableName, id: string) {
    if (this.stored(() => deleteRow(this.db, table, id))) this.note(table, id);
  }

  /**
   * Makes a call to the database. If the database fails for a reason of
   * its own, the error is thrown as a `StorageFailure`. Anything else is
   * thrown as it is, like whatever else goes wrong in a mutator: it comes
   * from what the mutator asked for, and would come again.
   */
  private stored<Result>(call: () => Result): Result {
    try {
      return call();
    } catch (error) {
      throw isDatabaseFailure(error) ? new StorageFailure(error) : error;
    }
  }

  private note(table: TableName, id: string) {
    this.changed.set(`${table} ${id}`, { table, id });
  }
}

/**
 * The data of one workspace and the bookkeeping of sync, over the SQLite
 * database of its Durable Object. Everything here is synchronous, so nothing
 * can come in between the steps of a method.
 *
 * Every change of a synced row gets a sequence number, one per mutation, and
 * an entry in the change log that names the row. The log does not hold what
 * the row was changed to: what a client is missing is the current state of
 * the rows that were changed after its cursor.
 */
export class WorkspaceStore {
  private readonly db: DrizzleSqliteDODatabase;

  constructor(private readonly storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  /**
   * Brings the database up to the schema of this version of the Worker. The
   * promise is for `blockConcurrencyWhile`: nothing may use the object until
   * this has succeeded.
   */
  migrate(): Promise<void> {
    return migrate(this.db, migrations);
  }

  /**
   * Ties the object to the workspace it is first used for, and from then on
   * says no to any other: it returns whether `identity` is the workspace
   * that the object holds. The Worker decides which object a request
   * reaches. This makes sure that a mistake there cannot hand the data of
   * one workspace to the owner of another.
   */
  bind(identity: WorkspaceIdentity): boolean {
    const record = this.db.select().from(workspaceRecord).get();
    if (!record) {
      this.db
        .insert(workspaceRecord)
        .values({ ...identity, seq: 0, logFloor: 0 })
        .run();
      return true;
    }
    return (
      record.id === identity.id &&
      record.ownerId === identity.ownerId &&
      record.environment === identity.environment
    );
  }

  /** The sequence number of the last change. */
  get seq(): number {
    return this.record().seq;
  }

  /** The last mutation of `clientId` that was processed, 0 if none was. */
  lastMutationId(clientId: string): number {
    const client = this.db
      .select({ lastMutationId: clientMutations.lastMutationId })
      .from(clientMutations)
      .where(eq(clientMutations.clientId, clientId))
      .get();
    return client?.lastMutationId ?? 0;
  }

  /**
   * How many rejections of `clientId` are kept: those that the client has
   * not said it has seen.
   */
  rejectionCount(clientId: string): number {
    const kept = this.db
      .select({ count: count() })
      .from(rejections)
      .where(eq(rejections.clientId, clientId))
      .get();
    return kept?.count ?? 0;
  }

  /**
   * Takes note that the client has seen what became of its mutations up to
   * `lastMutationId`, and forgets the rejections among them. Returns the
   * rejections after that, which the client has yet to hear of, in the order
   * of the mutations.
   */
  acknowledge(clientId: string, lastMutationId: number): Rejection[] {
    this.db
      .delete(rejections)
      .where(
        and(
          eq(rejections.clientId, clientId),
          lte(rejections.mutationId, lastMutationId),
        ),
      )
      .run();
    return this.db
      .select({
        id: rejections.mutationId,
        code: rejections.code,
        message: rejections.message,
      })
      .from(rejections)
      .where(eq(rejections.clientId, clientId))
      .orderBy(asc(rejections.mutationId))
      .all();
  }

  /**
   * Runs `mutations` of the server's own in order and returns, for each,
   * why it was refused, or null. A mutation that is refused leaves nothing
   * behind and does not stop the ones after it.
   *
   * All of it is one transaction: after a failure half-way, nothing has
   * happened. The database failing while a mutator runs is such a failure,
   * not a refusal: it is thrown.
   */
  apply(mutations: MutatorCall[], now: number): (Refusal | null)[] {
    return this.storage.transactionSync(() =>
      this.run(mutations, now, "server"),
    );
  }

  /**
   * Stores an account that was connected as a channel, with the access to
   * it: the row through the mutator `channel.connect`, which clients hear
   * of, and the access next to it, which they do not. Both in one
   * transaction, so that there is never a channel without its access, or
   * with the access of an earlier connection.
   */
  connectChannel(
    channel: MutatorArgs<"channel.connect">,
    access: ChannelAccess,
    now: number,
  ): ConnectChannelOutcome {
    return this.storage.transactionSync(() => {
      const [refusal] = this.run(
        [{ name: "channel.connect", args: channel }],
        now,
        "server",
      );
      if (refusal) return { ok: false, ...refusal };
      // The mutator has kept the ID of the channel that the account had, if
      // it had one, so the row is found by the account.
      const [stored] = this.db
        .update(channels)
        .set(access)
        .where(
          and(
            eq(channels.network, channel.network),
            eq(channels.accountId, channel.accountId),
          ),
        )
        .returning({ id: channels.id })
        .all();
      if (!stored) throw new Error("The channel was not stored");
      return { ok: true, channelId: stored.id };
    });
  }

  /** What it takes to act for the account of a channel, if there is one. */
  channelAccess(channelId: string): StoredChannelAccess | undefined {
    return this.db
      .select({
        network: channels.network,
        accountId: channels.accountId,
        credentials: channels.credentials,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
  }

  /**
   * Removes a channel, through the mutator `channel.disconnect`, and
   * returns the access that it held. Both in one transaction: what is
   * returned is what the channel had when it went, so whoever gives that
   * access back to its network gives back the one that pigy no longer
   * keeps, and no other.
   */
  disconnectChannel(channelId: string, now: number): DisconnectChannelOutcome {
    return this.storage.transactionSync(() => {
      const access = this.channelAccess(channelId);
      if (!access) {
        return {
          ok: false,
          code: "not_found",
          message: "There is no such channel",
        };
      }
      const [refusal] = this.run(
        [{ name: "channel.disconnect", args: { id: channelId } }],
        now,
        "server",
      );
      return refusal ? { ok: false, ...refusal } : { ok: true, access };
    });
  }

  /**
   * Runs mutations of the client `clientId`, as `apply` does, and returns
   * the ones that were refused. In the same transaction as their changes it
   * records that the mutations are processed, and the refusals, for the
   * client to hear of if this answer does not reach it. After a failure
   * nothing has happened, and the client sends the mutations again.
   */
  applyFrom(clientId: string, mutations: Mutation[], now: number): Rejection[] {
    const last = mutations.at(-1);
    if (!last) return [];
    return this.storage.transactionSync(() => {
      const outcomes = this.run(mutations, now, "client");
      const rejected = mutations.flatMap(({ id }, index) => {
        const refusal = outcomes[index];
        return refusal ? [{ id, ...refusal }] : [];
      });
      this.db
        .insert(clientMutations)
        .values({ clientId, lastMutationId: last.id })
        .onConflictDoUpdate({
          target: clientMutations.clientId,
          set: { lastMutationId: last.id },
        })
        .run();
      for (const { id, code, message } of rejected) {
        this.db
          .insert(rejections)
          .values({ clientId, mutationId: id, code, message })
          .run();
      }
      return rejected;
    });
  }

  /**
   * What `apply` does, for a caller that has opened the transaction and
   * says whose the mutations are.
   */
  private run(
    mutations: MutatorCall[],
    now: number,
    source: MutationSource,
  ): (Refusal | null)[] {
    const before = this.record();
    let seq = before.seq;
    const outcomes = mutations.map((mutation) => {
      const tx = new RecordingTransaction(this.db, now);
      try {
        // A transaction within the transaction: SQLite undoes what the
        // mutator wrote if it throws.
        this.storage.transactionSync(() => {
          try {
            applyMutation(tx, mutation.name, mutation.args, source);
          } catch (error) {
            // Only what is thrown here is a refusal: it comes from the
            // mutator. The database failing under it is not, and neither is
            // a failure of the transaction around it.
            if (error instanceof StorageFailure) throw error;
            throw new Refused(refusalOf(error));
          }
        });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        return error.refusal;
      }
      if (tx.changed.size > 0) {
        seq += 1;
        // One statement per row: a statement takes at most 100 values.
        for (const { table, id } of tx.changed.values()) {
          this.db
            .insert(changeLog)
            .values({ seq, tableName: table, rowId: id })
            .run();
        }
      }
      return null;
    });

    if (seq > before.seq) {
      // The log is kept from growing by dropping what is older than the
      // window. A cursor from before the floor can no longer be served
      // from the log.
      const logFloor = Math.max(before.logFloor, seq - changeLogWindow);
      if (logFloor > before.logFloor) {
        this.db.delete(changeLog).where(lte(changeLog.seq, logFloor)).run();
      }
      this.db.update(workspaceRecord).set({ seq, logFloor }).run();
    }
    return outcomes;
  }

  /**
   * What a client at `cursor` is missing: the rows that changed since, as
   * they are now. A snapshot if the client has nothing, if the log no longer
   * reaches back to its cursor, or if its cursor is not one of this
   * workspace.
   */
  changesSince(cursor: number | null): Patch {
    const { seq, logFloor } = this.record();
    if (cursor === null || cursor < logFloor || cursor > seq) {
      return {
        from: null,
        to: seq,
        changes: tableNames.flatMap((table) =>
          readRows(this.db, table).map((row) => put(table, row)),
        ),
      };
    }
    const changed = this.db
      .selectDistinct({ table: changeLog.tableName, id: changeLog.rowId })
      .from(changeLog)
      .where(gt(changeLog.seq, cursor))
      .all();
    return {
      from: cursor,
      to: seq,
      changes: changed.map(({ table, id }) => {
        const row = readRow(this.db, table, id);
        return row ? put(table, row) : { op: "delete", table, id };
      }),
    };
  }

  private record() {
    const record = this.db
      .select({ seq: workspaceRecord.seq, logFloor: workspaceRecord.logFloor })
      .from(workspaceRecord)
      .get();
    if (!record) throw new Error("The object is not tied to a workspace yet");
    return record;
  }
}

function put<Table extends TableName>(table: Table, row: Row<Table>): Change {
  // The compiler does not see that `row` is a row of `table` once both are
  // unions. The signature of this function says it instead.
  return { op: "put", table, row } as Change;
}

/** Why a mutator did not complete, from what it threw. */
function refusalOf(error: unknown): Refusal {
  if (error instanceof MutationRejected) {
    return {
      code: error.code,
      message: error.message.slice(0, maxRefusalMessageLength),
    };
  }
  // A bug in the mutator: it threw, or it wrote what the database does not
  // take. The mutation counts as processed all the same: a client that sent
  // it again would get the same failure, and nothing after it would ever get
  // through.
  console.error("A mutation failed", error);
  return { code: "internal_error", message: "Something went wrong" };
}

/**
 * The result codes with which SQLite says that it could not do its work,
 * whatever it was asked: no room, no access, no memory, a damaged file.
 * Every other code is about the statement or its values, such as a
 * constraint that a row violates or a value that is too large.
 */
const databaseFailureCodes = new Set([
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
]);

/**
 * Whether the database failed for a reason of its own, so that the same
 * statement can work later. The runtime throws a plain `Error` for
 * everything that SQLite reports, and says which kind it is only at the end
 * of the message, where it puts the result code: "…: SQLITE_FULL", or
 * "…: SQLITE_IOERR (extended: SQLITE_IOERR_WRITE)".
 *
 * Anything that this does not recognise counts as the mutator's doing: an
 * error without a result code is thrown before the database is asked, and a
 * code that is not listed is about what the mutator wrote. Taking it for a
 * failure of the database would make the client send the mutation again
 * for ever, with the same result, and nothing after it would get through.
 */
export function isDatabaseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = /: (SQLITE_[A-Z]+)(?: \(extended: SQLITE_[A-Z_]+\))?$/.exec(
    error.message,
  )?.[1];
  return code !== undefined && databaseFailureCodes.has(code);
}
