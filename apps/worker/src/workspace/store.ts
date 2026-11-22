import {
  applyMutation,
  type Change,
  environmentSchema,
  expiryNoticeMs,
  type Limits,
  type Mutation,
  MutationRejected,
  type MutationSource,
  type MutatorArgs,
  type Network,
  type PostContent,
  type PushMessage,
  partsFor,
  type Rejection,
  type RejectionCode,
  type Row,
  type TableName,
  type Transaction,
  tableNames,
  trashMs,
} from "@pigy/core";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
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
  type KeyedOutcome,
  keyedCalls,
  notifications,
  posts,
  postTargets,
  pushOutbox,
  rejections,
  targetPartResults,
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

/** The result of a mutation that did not come from a client. */
export type MutationOutcome = { ok: true } | ({ ok: false } & Refusal);

/**
 * What `stepBegins` answers: `by` is the mark of the run of the step that
 * was noted first, which is the caller's own unless a run of the same
 * step came before it. It is null where nobody can tell any more whether
 * one did: the delivery is so old that a note of it may have been cleared
 * away. Refused if the delivery is not under way.
 */
export type StepBegun =
  | { ok: true; by: string | null }
  | ({ ok: false } & Refusal);

/** What names a call of the Worker that is carried out once. */
export const callKeySchema = z.string().min(1).max(200);

/**
 * How long the object remembers a call that came with a key, in
 * milliseconds: 30 days, which is longer than a workflow keeps the steps
 * that it may run again.
 */
export const keyLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/**
 * For how long after a delivery began the note of a step of it is sure to
 * be kept, in milliseconds: a day less than `keyLifetimeMs`. A note is
 * kept like every call with a key, and it is made after its delivery
 * began, so it is there for at least this long. The day is for the time of
 * a mutation, which a workspace can put a little ahead of its clock.
 */
export const stepNoteLifetimeMs = keyLifetimeMs - 24 * 60 * 60 * 1000;

/**
 * How long the object keeps the access that a connection replaced under
 * the key of the call that replaced it, in milliseconds: five minutes. The
 * only caller that repeats such a call does so within its request, seconds
 * later, and the access is a secret that nothing else has a use for.
 */
export const handBackLifetimeMs = 5 * 60 * 1000;

/**
 * How long a notification stays in the inbox unless the person dismisses
 * it or what it is about is dealt with, in milliseconds: 30 days. What it
 * tells of is still on the screen that it led to after that.
 */
export const notificationLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a push message waits to be sent before it is given up, in
 * milliseconds: an hour. It waits only while the devices of the owner
 * cannot be read or the object does not get to it, and what it tells of
 * is in the inbox meanwhile. Told much later, it would be news of
 * something that the person may have dealt with.
 */
export const pushQueueLifetimeMs = 60 * 60 * 1000;

/** A push message that waits to be sent to the devices of the owner. */
export type QueuedPush = {
  id: number;
  message: PushMessage;
  /** The notification that it goes with, which names its topic. */
  notificationId: string;
};

/**
 * What the key of a call that stores a channel begins with in
 * `keyed_call`, before what its caller named it. It is what finds the
 * outcomes that may hold an access, without reading every other one.
 */
const connectKeys = "connectChannel:";
/** The first text that is after every key of that beginning. */
const afterConnectKeys = "connectChannel;";

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

/**
 * The channel that an account was stored as, or why it was not. `replaced`
 * is the access that the channel held until then, if the account had a
 * channel already: from the connection before, which nothing else holds
 * from here on.
 */
export type ConnectChannelOutcome =
  | { ok: true; channelId: string; replaced: StoredChannelAccess | null }
  | ({ ok: false } & Refusal);

/** How the Worker asks for a channel to be stored. */
export type ConnectChannelCall = {
  /** What names the call, which is then carried out once. */
  key?: string | undefined;
  /**
   * Whether to hand back the access that the connection replaced: where
   * the caller gives it back to its network.
   */
  handBack?: boolean;
};

/** What it takes to act for the account of a channel. */
export type StoredChannelAccess = {
  network: Network;
  accountId: string;
  /** Sealed. Null for a channel that was stored without. */
  credentials: string | null;
  /**
   * When the account was connected last, by the time of the workspace,
   * which names the connection that the credentials are from: no two
   * connections of a workspace share it.
   */
  connectedAt: number;
};

/** A channel whose access is due to be renewed, with that access. */
/**
 * How long the renewal of an access may be due, in milliseconds, before
 * it goes first: from then on no delivery to its channel begins until the
 * renewal has had its turn. A renewal waits for the delivery that is
 * under way to its channel, and a channel that always has a post waiting
 * would begin the next one whenever one ends, so its access would never be
 * renewed and would end. A day is far longer than any delivery takes, and
 * far less than an access has left when its renewal comes due.
 */
export const renewalOverdueMs = 24 * 60 * 60 * 1000;

export type DueRenewal = StoredChannelAccess & {
  channelId: string;
  /** Sealed: a channel without credentials has nothing to renew. */
  credentials: string;
};

/**
 * The access that a channel held when it was removed, or why it was not
 * removed: `not_found` if there is no such channel.
 */
export type DisconnectChannelOutcome =
  | { ok: true; access: StoredChannelAccess }
  | ({ ok: false } & Refusal);

/**
 * One attempt at the delivery of a target: what a run of the publishing
 * workflow stands for, and what it names itself with when it reports.
 */
export type DeliveryRun = { targetId: string; attempt: number };

/**
 * A delivery that is under way, with the time at which the workspace
 * began it: what the ID of its run is made of.
 */
export type StartedDelivery = DeliveryRun & { startedAt: number };

/** What a delivery publishes, where to, and from where it goes on. */
export type Delivery = {
  channel: {
    id: string;
    network: Network;
    accountId: string;
    /** True if the network has refused the access of the channel. */
    needsReconnect: boolean;
    /** What the account may post, and when its network said so. */
    limits: Limits | null;
    limitsCheckedAt: number | null;
  };
  /**
   * The text of the parts that the account gets, in order: those of the
   * post, or the ones that were written for this account in their place.
   */
  content: PostContent;
  /**
   * How far the attempts before have come, as an adapter returned it, or
   * null if the delivery begins at the beginning.
   */
  progress: unknown;
  /**
   * Whether an attempt before this one ended without anybody knowing what
   * became of what it sent: see `endDelivery` of the store.
   */
  mayHaveSent: boolean;
};

/** The credentials of a channel after a refresh, sealed, with their times. */
export type RenewedChannelAccess = ChannelAccess & {
  /** When the access ends now, in milliseconds since the epoch, or null. */
  expiresAt: number | null;
};

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
   * Runs a mutation of the server's own and returns how it ended. A
   * mutation that is refused leaves nothing behind. The database failing
   * while the mutator runs is not a refusal: it is thrown, and nothing has
   * happened.
   *
   * With a `key`, the mutation is run once: see `once`.
   */
  mutate(mutation: MutatorCall, now: number, key?: string): MutationOutcome {
    return this.once(key, now, () => {
      const [refusal] = this.run([mutation], now, "server");
      return refusal ? { ok: false, ...refusal } : { ok: true };
    });
  }

  /**
   * Carries out a call of the Worker that changes the workspace, in one
   * transaction, and returns how it ended.
   *
   * With a `key`, it is carried out once: the outcome is kept under the
   * key, in the same transaction, and a call that comes with the same key
   * again is answered with that outcome and does nothing. That is what
   * makes a call safe to repeat for a caller that cannot tell whether the
   * first one arrived, such as a step of a workflow that is run again. The
   * caller answers for the key: the same key for the same call, and for no
   * other. A call that failed, which is one that threw, has not happened
   * and left no key behind.
   */
  private once<Outcome extends KeyedOutcome>(
    key: string | undefined,
    now: number,
    call: () => Outcome,
  ): Outcome {
    return this.storage.transactionSync(() => {
      if (key === undefined) return call();
      // Before the key is looked up: a repeat that comes late is not
      // handed an access that should be gone.
      this.forgetHandedBack(now);
      const handled = this.db
        .select({ outcome: keyedCalls.outcome })
        .from(keyedCalls)
        .where(eq(keyedCalls.key, key))
        .get();
      // The caller answers for the key: it names this call, so what is
      // kept under it is an outcome of this call.
      if (handled) return handled.outcome as Outcome;
      const outcome = call();
      this.db.insert(keyedCalls).values({ key, outcome, handledAt: now }).run();
      // Nobody repeats a call after this long.
      this.db
        .delete(keyedCalls)
        .where(lt(keyedCalls.handledAt, now - keyLifetimeMs))
        .run();
      return outcome;
    });
  }

  /**
   * Takes the access that a connection replaced out of what is kept of the
   * call that replaced it: where the call is older than
   * `handBackLifetimeMs`, or, for an `account`, whatever its age. The key
   * and the rest of the outcome stay, so a repeat of the call is still
   * answered and not carried out, without `replaced`.
   *
   * It is run with every change of the workspace, so that the access does
   * not wait for another call with a key, which may never come.
   */
  private forgetHandedBack(
    now: number,
    account?: { network: Network; accountId: string },
  ): void {
    const replaced = (path: string) =>
      sql`json_extract(${keyedCalls.outcome}, ${`$.replaced${path}`})`;
    this.db
      .update(keyedCalls)
      .set({
        outcome: sql`json_set(${keyedCalls.outcome}, '$.replaced', json('null'))`,
      })
      .where(
        and(
          gte(keyedCalls.key, connectKeys),
          lt(keyedCalls.key, afterConnectKeys),
          sql`${replaced("")} is not null`,
          account
            ? and(
                sql`${replaced(".network")} = ${account.network}`,
                sql`${replaced(".accountId")} = ${account.accountId}`,
              )
            : lt(keyedCalls.handledAt, now - handBackLifetimeMs),
        ),
      )
      .run();
  }

  /**
   * Stores an account that was connected as a channel, with the access to
   * it: the row through the mutator `channel.connect`, which clients hear
   * of, and the access next to it, which they do not. Both in one
   * transaction, so that there is never a channel without its access, or
   * with the access of an earlier connection.
   *
   * It hands back the access that the channel held before, if the account
   * had one: read in the same transaction, so it is what this connection
   * replaced and nothing else, for the caller to give back to a network
   * on which it would stand otherwise.
   *
   * With a `key`, it is carried out once: see `once`. A repeat is answered
   * as the first call was, with what that one replaced. That is kept
   * under the key, sealed as it was, so only a caller that says `handBack`
   * is handed anything: one that has something to do with it. And it is
   * kept for `handBackLifetimeMs` and not for as long as the key: it goes
   * with the first change of the workspace after that, and with the
   * channel of its account when that is disconnected. A repeat that comes
   * later is answered without it.
   */
  connectChannel(
    channel: MutatorArgs<"channel.connect">,
    access: ChannelAccess,
    now: number,
    { key, handBack = false }: ConnectChannelCall = {},
  ): ConnectChannelOutcome {
    // Under a beginning of its own, by which `forgetHandedBack` finds it.
    const under = key === undefined ? undefined : `${connectKeys}${key}`;
    return this.once(under, now, (): ConnectChannelOutcome => {
      const account = and(
        eq(channels.network, channel.network),
        eq(channels.accountId, channel.accountId),
      );
      const before = this.db
        .select({
          network: channels.network,
          accountId: channels.accountId,
          credentials: channels.credentials,
          connectedAt: channels.connectedAt,
        })
        .from(channels)
        .where(account)
        .get();
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
        .where(account)
        .returning({ id: channels.id })
        .all();
      if (!stored) throw new Error("The channel was not stored");
      return {
        ok: true,
        channelId: stored.id,
        // A channel without credentials held nothing to give back.
        replaced: handBack && before?.credentials ? before : null,
      };
    });
  }

  /** What it takes to act for the account of a channel, if there is one. */
  channelAccess(channelId: string): StoredChannelAccess | undefined {
    return this.db
      .select({
        network: channels.network,
        accountId: channels.accountId,
        credentials: channels.credentials,
        connectedAt: channels.connectedAt,
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
      if (refusal) return { ok: false, ...refusal };
      // What a connection of this account replaced goes with the channel,
      // however lately: the access that is returned here is then all that
      // the workspace held of the account.
      this.forgetHandedBack(now, access);
      return { ok: true, access };
    });
  }

  /**
   * The latest time for which the object has looked for the posts that
   * were due, since it was made. A scheduled post whose time is not after
   * it was looked for and is still there: taking it up has failed.
   */
  dueLookedAt = Number.NEGATIVE_INFINITY;

  /**
   * The due posts that could not be taken up, since the object was made.
   * Each is logged once, and tried again by the alarm alone.
   */
  private readonly notTakenUp = new Set<string>();

  /**
   * The scheduled posts whose time has come by `now`, the one that was
   * due first first. Not those that are held: their time has passed, and
   * somebody has to say what becomes of them. And not those that were put
   * aside, which are as good as deleted.
   */
  private duePosts(now: number): string[] {
    this.dueLookedAt = Math.max(this.dueLookedAt, now);
    return this.db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.status, "scheduled"),
          isNotNull(posts.dueAt),
          lte(posts.dueAt, now),
          isNull(posts.heldAt),
          isNull(posts.trashedAt),
        ),
      )
      .orderBy(asc(posts.dueAt), asc(posts.id))
      .all()
      .map(({ id }) => id);
  }

  /**
   * Takes up the scheduled posts whose time has come: each is sent, held
   * or given another slot, by the mutator `post.due`. Every mutation of
   * the workspace does the same before it runs and after, so this is for
   * the alarm, which runs when a time has come and nothing else happens.
   */
  publishDue(now: number): void {
    this.storage.transactionSync(() => {
      this.run([], now, "server", true);
    });
  }

  /**
   * When the next scheduled post is due, or null if none is: the earliest
   * time among those that are not held. A time that has passed is one
   * that `publishDue` did not get done.
   */
  get nextDueAt(): number | null {
    const next = this.db
      .select({ dueAt: sql<number | null>`min(${posts.dueAt})` })
      .from(posts)
      .where(
        and(
          eq(posts.status, "scheduled"),
          isNotNull(posts.dueAt),
          isNull(posts.heldAt),
          isNull(posts.trashedAt),
        ),
      )
      .get();
    return next?.dueAt ?? null;
  }

  /**
   * Deletes the posts that were put aside `trashMs` ago or longer: the
   * second step of deleting a scheduled post, for a device that never
   * took it. With the mutator that the device would have used, so the
   * clients hear of it like of any change.
   */
  pruneTrashed(now: number): void {
    this.storage.transactionSync(() => {
      const old = this.db
        .select({ id: posts.id })
        .from(posts)
        // Only a scheduled post is put aside, and the scheduled ones are
        // few among all that were ever published: by the index.
        .where(
          and(
            eq(posts.status, "scheduled"),
            lte(posts.trashedAt, now - trashMs),
          ),
        )
        .all();
      if (old.length === 0) return;
      const refusals = this.run(
        old.map(({ id }) => ({
          name: "post.delete",
          args: { id, ifTrashed: true } satisfies MutatorArgs<"post.delete">,
        })),
        now,
        "server",
      );
      for (const refusal of refusals) {
        // The mutator refuses no post that was put aside: a bug.
        if (refusal) {
          console.error("A post that was put aside was not deleted", refusal);
        }
      }
    });
  }

  /**
   * When the next post that was put aside is to be deleted, or null if
   * none was put aside.
   */
  get nextPruneAt(): number | null {
    const next = this.db
      .select({ at: min(posts.trashedAt) })
      .from(posts)
      .where(and(eq(posts.status, "scheduled"), isNotNull(posts.trashedAt)))
      .get();
    return next?.at == null ? null : next.at + trashMs;
  }

  /** The workspace that the object holds. */
  get identity(): WorkspaceIdentity {
    const record = this.db
      .select({
        id: workspaceRecord.id,
        ownerId: workspaceRecord.ownerId,
        environment: workspaceRecord.environment,
      })
      .from(workspaceRecord)
      .get();
    if (!record) throw new Error("The object is not tied to a workspace yet");
    return record;
  }

  /**
   * Begins the deliveries whose turn has come: for every channel that has
   * none under way, the one that has waited longest. The deliveries to one
   * channel go out one after the other, because no adapter can tell two
   * apart that go to one account together. None begins to a channel whose
   * access is overdue for renewal: the renewal goes first, `renewalsDue`,
   * and the delivery begins when it has had its turn.
   */
  startDeliveries(now: number): void {
    this.storage.transactionSync(() => {
      const busy = new Set([
        ...this.db
          .select({ channelId: postTargets.channelId })
          .from(postTargets)
          .where(eq(postTargets.status, "sending"))
          .all()
          .map(({ channelId }) => channelId),
        ...this.renewalsOverdue(now),
      ]);
      const waiting = this.db
        .select({ id: postTargets.id, channelId: postTargets.channelId })
        .from(postTargets)
        .where(eq(postTargets.status, "queued"))
        .orderBy(asc(postTargets.queuedAt), asc(postTargets.id))
        .all();
      for (const { id, channelId } of waiting) {
        if (busy.has(channelId)) continue;
        busy.add(channelId);
        const [refusal] = this.run(
          [{ name: "target.start", args: { id } }],
          now,
          "server",
        );
        if (refusal) {
          throw new Error(`A delivery did not begin: ${refusal.message}`);
        }
        // The time that the mutation was run at, which is this delivery's
        // alone: it names the run that carries the delivery.
        this.db
          .update(postTargets)
          .set({ startedAt: this.record().time })
          .where(eq(postTargets.id, id))
          .run();
      }
    });
  }

  /**
   * Takes note that the delivery `run` has passed its checks and is about
   * to make its first request to the network, and returns whether it is
   * under way: not if the target has ended, or is on another attempt.
   *
   * Only for a channel of a network whose adapter cannot tell the
   * deliveries to an account apart, which is one that has
   * `tellsDeliveriesApart` of the contract as false, as Mastodon's. The
   * workflow does not call this for the others, as for Bluesky: there a
   * part is found under a key that the delivery recorded, which is the
   * only way to a first part that landed unseen and must not be dropped.
   *
   * From here on, no other delivery to the channel that has not published
   * a part can be taken up where it stopped. It would look for its first
   * part among what the account has posted since it began, which is how
   * such an adapter finds a part whose answer was lost. That now includes the
   * posts of this delivery, and it would take a first part that reads the
   * same for its own. So what the others have recorded is dropped here:
   * whichever of them is tried again begins anew. That goes for every
   * other target of the channel, whatever its status: one that failed,
   * and one that was tried again since and waits its turn behind this
   * one. A delivery that has published a part is not concerned: its next
   * part is a reply to the one before, which no other delivery has.
   *
   * A delivery that only has replies left to send drops what the others
   * have recorded too, on purpose, though on Mastodon no other delivery
   * could take a reply for its first part: the rule does not rest on what
   * the later parts of a post are on a network. Only a delivery that has
   * nothing left to send at all does not get here: see the workflow.
   *
   * Not before this point: a delivery that ends without having asked the
   * network for anything, because its post does not pass the checks, say,
   * has put nothing on the account that another could take for its own.
   * The progress of the others is what lets them find a first part that
   * landed unseen, and dropping it without need means posting twice.
   *
   * The same goes for what the workspace knows of the others besides
   * their progress: that an attempt of theirs may have sent, `mayHaveSent`
   * of the target, which `endDelivery` sets. An adapter that cannot look
   * for its post, as LinkedIn's, takes a post that the network names in a
   * refusal for the delivery's own where that is set. From here on such a
   * post can be this delivery's, where the two read the same, so the
   * others forget it with their progress. One of them whose post did land
   * unseen then fails when it is tried again while the network still
   * refuses the text, with a link to the post that the network has: it
   * says less than it could, and never "Sent" of the post of another
   * delivery.
   *
   * It is safe to repeat: while this delivery is under way no other to
   * the channel is, so none has recorded anything since the first time,
   * and none has ended.
   */
  aboutToSend({ targetId, attempt }: DeliveryRun): boolean {
    return this.storage.transactionSync(() => {
      const target = this.db
        .select({
          channelId: postTargets.channelId,
          status: postTargets.status,
          attempt: postTargets.attempt,
        })
        .from(postTargets)
        .where(eq(postTargets.id, targetId))
        .get();
      if (target?.status !== "sending" || target.attempt !== attempt) {
        return false;
      }
      this.db
        .update(postTargets)
        .set({ progress: null, mayHaveSent: false })
        .where(
          and(
            eq(postTargets.channelId, target.channelId),
            ne(postTargets.id, targetId),
            notExists(
              this.db
                .select({ id: targetPartResults.id })
                .from(targetPartResults)
                .where(eq(targetPartResults.targetId, postTargets.id)),
            ),
          ),
        )
        .run();
      return true;
    });
  }

  /**
   * Takes note that a step of the delivery `run` is about to be run, and
   * returns the mark of the run of that step that was noted first.
   *
   * Only for a channel of a network whose adapter cannot run a step again
   * safely, which is one that has `repeatsSafely` of the contract as
   * false, as LinkedIn's: it can neither look for what it has sent nor
   * send a request that is carried out once. A step of such an adapter
   * that was cut off after its request went out must not be run again,
   * and nothing but a note that outlasts the step can tell: what a step
   * returns is recorded only when it has returned.
   *
   * `key` names the step, the same for every run of it, and `mark` is a
   * value that the run of the step has made up for itself. The first run
   * to get here has its mark kept under the key, and every run is
   * answered with the mark that is kept: a run that is handed another
   * mark than its own is a second run of a step that began before, and
   * does not send. A run whose call is repeated, because its answer was
   * lost, is handed its own mark again: that is what `once` does for a
   * key, and why the step of the workflow repeats a call that failed with
   * the mark that it has.
   *
   * A note is kept for as long as every call with a key, `keyLifetimeMs`,
   * and a delivery can go on for longer: a run that is paused stays, and
   * can be taken up again whenever somebody says. So a step that finds no
   * note for a delivery that began `stepNoteLifetimeMs` ago or longer is
   * not handed its mark: a note may have been there and cleared away, and
   * the step that made it may have sent. It is answered with no mark,
   * which is kept in the place of one, and does not send.
   *
   * It is refused if the delivery is not under way, and a step that was
   * noted for a delivery which has ended since is nobody's concern.
   */
  stepBegins(
    { targetId, attempt }: DeliveryRun,
    mark: string,
    now: number,
    key: string,
  ): StepBegun {
    return this.once(key, now, (): StepBegun => {
      const target = this.db
        .select({
          status: postTargets.status,
          attempt: postTargets.attempt,
          startedAt: postTargets.startedAt,
        })
        .from(postTargets)
        .where(eq(postTargets.id, targetId))
        .get();
      if (target?.status !== "sending" || target.attempt !== attempt) {
        return {
          ok: false,
          code: "not_current",
          message: "This delivery is not under way",
        };
      }
      const noteMayBeGone = now - target.startedAt >= stepNoteLifetimeMs;
      return { ok: true, by: noteMayBeGone ? null : mark };
    });
  }

  /**
   * The deliveries that are under way: with a workflow if `dispatched`,
   * and those that have yet to get theirs if not.
   */
  deliveries(dispatched: boolean): StartedDelivery[] {
    return this.db
      .select({
        targetId: postTargets.id,
        attempt: postTargets.attempt,
        startedAt: postTargets.startedAt,
        dispatched: postTargets.dispatched,
      })
      .from(postTargets)
      .where(eq(postTargets.status, "sending"))
      .all()
      .filter((run) => (run.dispatched === run.attempt) === dispatched)
      .map(({ targetId, attempt, startedAt }) => ({
        targetId,
        attempt,
        startedAt,
      }));
  }

  /** Takes note that the workflow of a delivery was created. */
  dispatched({ targetId, attempt }: DeliveryRun): void {
    this.db
      .update(postTargets)
      .set({ dispatched: attempt })
      .where(
        and(eq(postTargets.id, targetId), eq(postTargets.attempt, attempt)),
      )
      .run();
  }

  /**
   * What is left to do for the deliveries at `now`: `begin` if a target
   * that waits can begin, because its channel has no delivery under way.
   * So if its channel is one whose access is overdue for renewal: the
   * renewal can run now, and the delivery begins after it. `watch` if none
   * can and some are under way: there is nothing to do at once, but to
   * come back and see that they end, and to create the workflow of one
   * that has none yet. `nothing` if none waits or is under way.
   */
  deliveriesNeed(now: number): "begin" | "renew" | "watch" | "nothing" {
    const { ready, waiting } = this.deliveriesWaiting(now);
    if (ready) return "begin";
    if (waiting.size > 0) return "renew";
    return this.underWay ? "watch" : "nothing";
  }

  /**
   * The channels with a delivery that could begin but for the access of
   * the channel, which is overdue for renewal at `now`. The alarm goes by
   * it to tell a delivery that it has just renewed for, or tried to,
   * from one that came to wait while it was busy with another channel.
   */
  awaitingRenewal(now: number): Set<string> {
    return this.deliveriesWaiting(now).waiting;
  }

  /** Whether a delivery waits its turn or is under way. */
  private get underWay(): boolean {
    return (
      this.db
        .select({ id: postTargets.id })
        .from(postTargets)
        .where(inArray(postTargets.status, ["queued", "sending"]))
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * The deliveries whose channel has none under way at `now`: whether
   * one of them can begin, `ready`, and the channels of those that wait
   * for a renewal that is overdue, `waiting`.
   */
  private deliveriesWaiting(now: number): {
    ready: boolean;
    waiting: Set<string>;
  } {
    const targets = this.db
      .select({
        channelId: postTargets.channelId,
        status: postTargets.status,
      })
      .from(postTargets)
      .where(inArray(postTargets.status, ["queued", "sending"]))
      .all();
    const busy = new Set(
      targets
        .filter(({ status }) => status === "sending")
        .map(({ channelId }) => channelId),
    );
    const ready = targets.filter(
      ({ status, channelId }) => status === "queued" && !busy.has(channelId),
    );
    if (ready.length === 0) return { ready: false, waiting: new Set() };
    const overdue = this.renewalsOverdue(now);
    return {
      ready: ready.some(({ channelId }) => !overdue.has(channelId)),
      waiting: new Set(
        ready
          .map(({ channelId }) => channelId)
          .filter((channelId) => overdue.has(channelId)),
      ),
    };
  }

  /**
   * What the delivery `run` publishes, or undefined if it is not under
   * way: the target has ended, or is on another attempt by now.
   */
  delivery({ targetId, attempt }: DeliveryRun): Delivery | undefined {
    const target = this.db
      .select({
        postId: postTargets.postId,
        channelId: postTargets.channelId,
        status: postTargets.status,
        attempt: postTargets.attempt,
        progress: postTargets.progress,
        mayHaveSent: postTargets.mayHaveSent,
      })
      .from(postTargets)
      .where(eq(postTargets.id, targetId))
      .get();
    if (target?.status !== "sending" || target.attempt !== attempt) {
      return undefined;
    }
    const channel = readRow(this.db, "channel", target.channelId);
    // A target does not go on without its channel: disconnecting ends it.
    if (!channel) return undefined;
    return {
      channel: {
        id: channel.id,
        network: channel.network,
        accountId: channel.accountId,
        needsReconnect: channel.status === "needs_reconnect",
        limits: channel.limits,
        limitsCheckedAt: channel.limitsCheckedAt,
      },
      content: {
        // What this account gets: the text that was written for it, or
        // the post's own. Neither changes once the post is published,
        // so every attempt and every step is handed the same.
        parts: partsFor(
          findRows(this.db, "post_part", "postId", target.postId),
          targetId,
        ).map(({ text }) => ({ text })),
      },
      progress: target.progress ?? null,
      mayHaveSent: target.mayHaveSent,
    };
  }

  /**
   * Records how far a delivery has come: the parts that are published,
   * through the mutator `target.progress`, which clients hear of, and the
   * progress that the next attempt goes on from, next to the row. Both in
   * one transaction, and once for `key`: see `once`.
   */
  recordProgress(
    { targetId, attempt }: DeliveryRun,
    parts: MutatorArgs<"target.progress">["parts"],
    progress: unknown,
    now: number,
    key: string,
  ): MutationOutcome {
    return this.once(key, now, () => {
      const [refusal] = this.run(
        [{ name: "target.progress", args: { id: targetId, attempt, parts } }],
        now,
        "server",
      );
      if (refusal) return { ok: false, ...refusal };
      this.db
        .update(postTargets)
        .set({ progress })
        .where(eq(postTargets.id, targetId))
        .run();
      return { ok: true };
    });
  }

  /**
   * Ends a delivery: the target through the mutator `target.end`, which
   * clients hear of, and next to the row what the next attempt has to
   * know of this one, `mayHaveSent`. Both in one transaction, and once
   * for a `key`: see `once`. Every end of a delivery that is not the
   * disconnect of its channel goes through here: the one that its
   * workflow reports, and the one that the alarm of the object makes of a
   * workflow that stopped without a word.
   *
   * An attempt that ends `uncertain` may have sent: a request went out, or
   * may have, and nobody learned what became of it. That stays true of
   * the target whatever the attempts after it end with: one that is
   * refused, for a limit say, has learned nothing about the one before.
   * Only a delivery that is sent has nothing left to find, and one that
   * begins anew: `aboutToSend`.
   */
  endDelivery(
    end: MutatorArgs<"target.end">,
    now: number,
    key?: string,
  ): MutationOutcome {
    return this.once(key, now, () => {
      const [refusal] = this.run(
        [{ name: "target.end", args: end }],
        now,
        "server",
      );
      if (refusal) return { ok: false, ...refusal };
      if (end.status !== "error") {
        this.db
          .update(postTargets)
          .set({ mayHaveSent: end.status === "uncertain" })
          .where(eq(postTargets.id, end.id))
          .run();
      }
      return { ok: true };
    });
  }

  /**
   * Stores the credentials that a refresh has returned in place of the
   * ones it started from, `expected`, and returns whether it did. It does
   * not if the channel no longer holds those: another refresh has replaced
   * them, or the channel is gone. When the access ends goes through the
   * mutator `channel.renew`, in the same transaction.
   */
  renewChannelAccess(
    channelId: string,
    expected: string,
    { credentials, refreshAt, expiresAt }: RenewedChannelAccess,
    now: number,
  ): boolean {
    return this.storage.transactionSync(() => {
      const [renewed] = this.db
        .update(channels)
        .set({ credentials, refreshAt })
        .where(
          and(eq(channels.id, channelId), eq(channels.credentials, expected)),
        )
        .returning({ id: channels.id })
        .all();
      if (!renewed) return false;
      const [refusal] = this.run(
        [{ name: "channel.renew", args: { id: channelId, expiresAt } }],
        now,
        "server",
      );
      if (refusal) throw new Error(`Not renewed: ${refusal.message}`);
      return true;
    });
  }

  /**
   * The channels whose access is due to be renewed at `now`: connected,
   * with a time for it that has come, and with no delivery under way. A
   * delivery renews the access of its channel itself where the network
   * asks, and two refreshes of one account must not run together, so a
   * channel that is being sent to waits for its delivery to end. The
   * ones that are overdue come first: a delivery may be waiting for one.
   */
  renewalsDue(now: number): DueRenewal[] {
    const busy = new Set(
      this.db
        .select({ channelId: postTargets.channelId })
        .from(postTargets)
        .where(eq(postTargets.status, "sending"))
        .all()
        .map(({ channelId }) => channelId),
    );
    const overdue = this.renewalsOverdue(now);
    const due = this.db
      .select({
        channelId: channels.id,
        network: channels.network,
        accountId: channels.accountId,
        credentials: channels.credentials,
        connectedAt: channels.connectedAt,
      })
      .from(channels)
      .where(
        and(
          eq(channels.status, "connected"),
          isNotNull(channels.credentials),
          lte(channels.refreshAt, now),
        ),
      )
      .all()
      .flatMap(({ credentials, ...channel }) =>
        credentials === null || busy.has(channel.channelId)
          ? []
          : [{ ...channel, credentials }],
      );
    return [
      ...due.filter(({ channelId }) => overdue.has(channelId)),
      ...due.filter(({ channelId }) => !overdue.has(channelId)),
    ];
  }

  /**
   * The channels whose access has been due to be renewed for
   * `renewalOverdueMs` or longer at `now`. No delivery to one of them
   * begins before its renewal has had its turn, which leaves the channel
   * with a later time to renew at or with none, whatever comes of it.
   */
  private renewalsOverdue(now: number): Set<string> {
    return new Set(
      this.db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.status, "connected"),
            isNotNull(channels.credentials),
            lte(channels.refreshAt, now - renewalOverdueMs),
          ),
        )
        .all()
        .map(({ id }) => id),
    );
  }

  /**
   * When the access of a channel is next due to be renewed, in
   * milliseconds since the epoch, or null if none ever is.
   */
  get nextRenewalAt(): number | null {
    return (
      this.db
        .select({ at: min(channels.refreshAt) })
        .from(channels)
        .where(
          and(
            eq(channels.status, "connected"),
            isNotNull(channels.credentials),
          ),
        )
        .get()?.at ?? null
    );
  }

  /**
   * Puts the renewal of a channel's access off until `at`, or for good
   * with null, if the channel still holds the credentials `expected`. A
   * channel that holds others has a time of its own for those.
   */
  postponeRenewal(
    channelId: string,
    expected: string,
    at: number | null,
  ): void {
    this.db
      .update(channels)
      .set({ refreshAt: at })
      .where(
        and(eq(channels.id, channelId), eq(channels.credentials, expected)),
      )
      .run();
  }

  /**
   * Runs mutations of the client `clientId`, in order, and returns the
   * ones that were refused: a mutation that is refused leaves nothing
   * behind and does not stop the ones after it. In the same transaction as their changes it
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
   * Runs `mutations` in order and returns, for each, why it was refused,
   * or null. For a caller that has opened the transaction and says whose
   * the mutations are.
   *
   * Every mutation is run at a time of its own, later than the one before
   * it: the clock's, or one millisecond after the time of the mutation
   * before if the clock has not moved on since, or has gone back. So the
   * times that mutators put into rows say in which order the mutations
   * were run, also for those of one message, and across restarts: the
   * last time is stored with the workspace.
   *
   * The scheduled posts whose time has come are taken up first, with
   * `post.due`: a mutation never finds a post that should have gone out
   * by its time. And again after every mutation, for a post whose time
   * has come with the time of that mutation. Between the mutations of
   * one message as between two messages: what becomes of a post does not
   * depend on how a client packs what it sends.
   */
  private run(
    mutations: MutatorCall[],
    now: number,
    source: MutationSource,
    // Also the due posts that could not be taken up before: for the alarm.
    retryDue = false,
  ): (Refusal | null)[] {
    this.forgetHandedBack(now);
    const before = this.record();
    let { seq, time } = before;
    const due = () => {
      // One at a time, and looked for anew after each: taking up a post
      // of the queue can give the others that were due another time.
      const tried = new Set<string>();
      for (;;) {
        const id = this.duePosts(Math.max(now, time + 1)).find(
          (id) => !tried.has(id) && (retryDue || !this.notTakenUp.has(id)),
        );
        if (id === undefined) return;
        tried.add(id);
        const refusal = apply({ name: "post.due", args: { id } }, "server");
        if (!refusal) {
          this.notTakenUp.delete(id);
          continue;
        }
        // The mutator takes every post that is due, so this is a bug.
        // The alarm comes back to the post in its own time, and the
        // mutations before then leave it alone: it is said once.
        if (!this.notTakenUp.has(id)) {
          console.error(`The due post ${id} was not taken up`, refusal.message);
        }
        this.notTakenUp.add(id);
      }
    };
    const apply = (
      mutation: MutatorCall,
      // Whose the mutation is: a due post is the server's to take up,
      // whoever the others are from.
      from: MutationSource,
    ): Refusal | null => {
      time = Math.max(now, time + 1);
      const tx = new RecordingTransaction(this.db, time);
      try {
        // A transaction within the transaction: SQLite undoes what the
        // mutator wrote if it throws.
        this.storage.transactionSync(() => {
          try {
            applyMutation(tx, mutation.name, mutation.args, from);
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
      this.queuePushes(tx, time);
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
    };
    due();
    const outcomes = mutations.map((mutation) => {
      const outcome = apply(mutation, source);
      // After every one, as before the first: what a message does is
      // what its mutations would do in messages of their own.
      due();
      return outcome;
    });

    // The log is kept from growing by dropping what is older than the
    // window. A cursor from before the floor can no longer be served from
    // the log.
    const logFloor = Math.max(before.logFloor, seq - changeLogWindow);
    if (logFloor > before.logFloor) {
      this.db.delete(changeLog).where(lte(changeLog.seq, logFloor)).run();
    }
    if (time > before.time) {
      this.db.update(workspaceRecord).set({ seq, logFloor, time }).run();
    }
    return outcomes;
  }

  /**
   * Queues a push message for every notification that the mutation of
   * `tx`, run at `time`, has made or made anew: what the inbox says, the
   * devices of the owner are told. In the transaction of the mutation, so
   * that a notification is never there without its message having been
   * queued, and none is queued for a mutation that did not happen.
   *
   * A notification is of this mutation if it is from its time: no two
   * mutations of a workspace are run at the same one. One that was only
   * marked as read keeps the time that it was made at.
   */
  private queuePushes(tx: RecordingTransaction, time: number): void {
    for (const { table, id } of tx.changed.values()) {
      if (table !== "notification") continue;
      const notification = readRow(this.db, "notification", id);
      if (notification?.createdAt !== time) continue;
      const message = this.pushMessageOf(notification);
      if (!message) continue;
      this.db
        .insert(pushOutbox)
        .values({ message, notificationId: id, queuedAt: time })
        .run();
      this.pushQueued = true;
    }
  }

  /** What the devices of the owner are told of `notification`. */
  private pushMessageOf(
    notification: Row<"notification">,
  ): PushMessage | undefined {
    const { id: workspaceId, environment } = this.identity;
    const about = { v: 1, workspaceId, environment } as const;
    if (notification.kind === "post_failed") {
      const postId = notification.postId;
      if (!postId) return undefined;
      // As the Sent screen says it: a post of which nothing is known to
      // have failed, and of which a delivery is unknown, is unknown.
      const failed = findRows(this.db, "post_target", "postId", postId).some(
        ({ status }) => status === "error",
      );
      return {
        ...about,
        kind: failed ? "post_failed" : "post_uncertain",
        postId,
      };
    }
    if (notification.kind === "post_held") {
      const postId = notification.postId;
      return postId ? { ...about, kind: "post_held", postId } : undefined;
    }
    const channel =
      notification.channelId &&
      readRow(this.db, "channel", notification.channelId);
    if (!channel) return undefined;
    return {
      ...about,
      kind: notification.kind,
      channelId: channel.id,
      network: channel.network,
      // A reminder is given a week before the end, or later: by the first
      // alarm after that time has come.
      ...(notification.kind === "channel_expiring" &&
        channel.expiresAt !== null && { expiresAt: channel.expiresAt }),
    };
  }

  /** Whether a mutation has queued a push message since this was asked. */
  private pushQueued = false;

  /**
   * Whether a push message was queued since the last time this was asked:
   * for the object, which then sends at once.
   */
  takePushQueued(): boolean {
    const queued = this.pushQueued;
    this.pushQueued = false;
    return queued;
  }

  /**
   * The push messages that wait to be sent, the oldest first. Those that
   * have waited for longer than `pushQueueLifetimeMs` are given up here.
   */
  queuedPushes(now: number): QueuedPush[] {
    this.db
      .delete(pushOutbox)
      .where(lt(pushOutbox.queuedAt, now - pushQueueLifetimeMs))
      .run();
    return this.db
      .select({
        id: pushOutbox.id,
        message: pushOutbox.message,
        notificationId: pushOutbox.notificationId,
      })
      .from(pushOutbox)
      .orderBy(asc(pushOutbox.id))
      .all();
  }

  /** Gives up every push message that waits: there is nothing to send with. */
  dropQueuedPushes(): void {
    this.db.delete(pushOutbox).run();
  }

  /** Takes note that a push message was handed to the push services. */
  pushed(id: number): void {
    this.db.delete(pushOutbox).where(eq(pushOutbox.id, id)).run();
  }

  /** Whether a push message waits to be sent. */
  get pushesWait(): boolean {
    return (
      this.db.select({ id: pushOutbox.id }).from(pushOutbox).limit(1).get() !==
      undefined
    );
  }

  /**
   * The channels whose access ends by a date and whose owner has not been
   * told of the end that it has now. Not one that waits to be connected
   * again: the inbox has said that, and there is nothing to remind of.
   */
  private readonly notWarned = and(
    isNotNull(channels.expiresAt),
    eq(channels.status, "connected"),
    or(
      isNull(channels.expiryWarnedFor),
      ne(channels.expiryWarnedFor, channels.expiresAt),
    ),
  );

  /**
   * Tells the owner of every access that ends within `expiryNoticeMs`,
   * once for each end: through the mutator `channel.warnOfExpiry`, which
   * puts it into the inbox, and with a note next to the channel that it
   * was said, in one transaction. The note is the end that was told of,
   * so an account that is connected again is told of the end of its new
   * access when that comes. So is one whose access pigy renews, as that
   * of Threads: its end moves with every renewal, which comes weeks
   * before it, so it is within the week only when the renewals have not
   * worked for weeks, and again when they stop working another time.
   *
   * An access whose end has passed unsaid is noted too, and nothing is
   * said of it: the mutator does not tell of an end that is over, and the
   * channel says it on its own screen.
   */
  warnOfExpiry(now: number): void {
    this.storage.transactionSync(() => {
      const due = this.db
        .select({ id: channels.id, expiresAt: channels.expiresAt })
        .from(channels)
        .where(
          and(this.notWarned, lte(channels.expiresAt, now + expiryNoticeMs)),
        )
        .all();
      for (const { id, expiresAt } of due) {
        const [refusal] = this.run(
          [{ name: "channel.warnOfExpiry", args: { id } }],
          now,
          "server",
        );
        if (refusal) throw new Error(`Not warned: ${refusal.message}`);
        this.db
          .update(channels)
          .set({ expiryWarnedFor: expiresAt })
          .where(eq(channels.id, id))
          .run();
      }
    });
  }

  /**
   * Removes the notifications that are older than `notificationLifetimeMs`,
   * through the mutator `notification.prune`, which clients hear of.
   */
  pruneNotifications(now: number): void {
    this.storage.transactionSync(() => {
      for (;;) {
        const old = this.db
          .select({ id: notifications.id })
          .from(notifications)
          .where(lt(notifications.createdAt, now - notificationLifetimeMs))
          // As many as the mutator takes at once.
          .limit(100)
          .all();
        if (old.length === 0) return;
        const [refusal] = this.run(
          [
            {
              name: "notification.prune",
              args: { ids: old.map(({ id }) => id) },
            },
          ],
          now,
          "server",
        );
        if (refusal) throw new Error(`Not pruned: ${refusal.message}`);
      }
    });
  }

  /**
   * When the object next has something to do by the clock, in
   * milliseconds since the epoch, or null if nothing is in sight: an
   * access whose end is to be told of, or a notification that is to go.
   */
  get nextInboxAt(): number | null {
    const access = this.db
      .select({ endsAt: min(channels.expiresAt) })
      .from(channels)
      .where(this.notWarned)
      .get();
    const oldest = this.db
      .select({ madeAt: min(notifications.createdAt) })
      .from(notifications)
      .get();
    const times = [
      ...(access?.endsAt == null ? [] : [access.endsAt - expiryNoticeMs]),
      ...(oldest?.madeAt == null
        ? []
        : [oldest.madeAt + notificationLifetimeMs]),
    ];
    return times.length > 0 ? Math.min(...times) : null;
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
      .select({
        seq: workspaceRecord.seq,
        logFloor: workspaceRecord.logFloor,
        time: workspaceRecord.time,
      })
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
