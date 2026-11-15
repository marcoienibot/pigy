import {
  applyMutation,
  type Change,
  environmentSchema,
  MutationRejected,
  type RejectionCode,
  type Row,
  type TableName,
  type Transaction,
  tableNames,
} from "@pigy/core";
import { eq, gt, lte } from "drizzle-orm";
import {
  type DrizzleSqliteDODatabase,
  drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "./migrations/migrations.js";
import { changeLog, clientMutations, workspaceRecord } from "./schema.ts";
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
 * Thrown in place of what the database threw, when it failed for a reason
 * that is not the mutation's: it is full, say, or cannot be read. Running
 * the mutation again later can work.
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
   * Makes a call to the database. If the call fails because it violates a
   * constraint, that is the doing of the mutator, which asked for something
   * that cannot be stored: the error is thrown as it is, like anything else
   * that goes wrong in a mutator. Any other failure is the database's own
   * and is thrown as a `StorageFailure`.
   */
  private stored<Result>(call: () => Result): Result {
    try {
      return call();
    } catch (error) {
      throw isConstraintViolation(error) ? error : new StorageFailure(error);
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
   * Runs `mutations` in order and returns, for each, why it was refused, or
   * null. A mutation that is refused leaves nothing behind and does not stop
   * the ones after it. With `client`, it is recorded along with the changes
   * that the mutations of this client up to `lastMutationId` are processed.
   *
   * All of it is one transaction: after a failure half-way, nothing has
   * happened and the client sends the mutations again. The database failing
   * while a mutator runs is such a failure, not a refusal: it is thrown.
   */
  apply(
    mutations: MutatorCall[],
    now: number,
    client?: { id: string; lastMutationId: number },
  ): (Refusal | null)[] {
    return this.storage.transactionSync(() => {
      const before = this.record();
      let seq = before.seq;
      const outcomes = mutations.map((mutation) => {
        const tx = new RecordingTransaction(this.db, now);
        try {
          // A transaction within the transaction: SQLite undoes what the
          // mutator wrote if it throws.
          this.storage.transactionSync(() => {
            try {
              applyMutation(tx, mutation.name, mutation.args);
            } catch (error) {
              // Only what is thrown here is a refusal: it comes from the
              // mutator. The database failing under it is not, and neither
              // is a failure of the transaction around it.
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
      if (client) {
        this.db
          .insert(clientMutations)
          .values({
            clientId: client.id,
            lastMutationId: client.lastMutationId,
          })
          .onConflictDoUpdate({
            target: clientMutations.clientId,
            set: { lastMutationId: client.lastMutationId },
          })
          .run();
      }
      return outcomes;
    });
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
    return { code: error.code, message: error.message };
  }
  // A bug in the mutator: it threw, or it wrote what the database does not
  // take. The mutation counts as processed all the same: a client that sent
  // it again would get the same failure, and nothing after it would ever get
  // through.
  console.error("A mutation failed", error);
  return { code: "internal_error", message: "Something went wrong" };
}

/**
 * Whether the database refused a statement for what it was asked to store:
 * a value that is missing, or a reference to a row that is not there. The
 * runtime throws a plain `Error` for everything that SQLite reports, and
 * says which kind it is only at the end of the message, where it puts the
 * result code: "…: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)".
 * An error that this does not recognise counts as a failure of the
 * database, which loses nothing: the client sends its mutations again.
 */
function isConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /: SQLITE_CONSTRAINT(?: \(extended: SQLITE_[A-Z_]+\))?$/.test(error.message)
  );
}
