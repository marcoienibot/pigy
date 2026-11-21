import {
  applyMutation,
  type Change,
  environmentSchema,
  inReadingOrder,
  type Limits,
  type Mutation,
  MutationRejected,
  type MutationSource,
  type MutatorArgs,
  type Network,
  type PostContent,
  type Rejection,
  type RejectionCode,
  type Row,
  type TableName,
  type Transaction,
  tableNames,
} from "@pigy/core";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  notExists,
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
  postTargets,
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
 * step came before it. Refused if the delivery is not under way.
 */
export type StepBegun = { ok: true; by: string } | ({ ok: false } & Refusal);

/** What names a call of the Worker that is carried out once. */
export const callKeySchema = z.string().min(1).max(200);

/**
 * How long the object remembers a call that came with a key, in
 * milliseconds: 30 days, which is longer than a workflow keeps the steps
 * that it may run again.
 */
export const keyLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the object keeps the access that a connection replaced under
 * the key of the call that replaced it, in milliseconds: five minutes. The
 * only caller that repeats such a call does so within its request, seconds
 * later, and the access is a secret that nothing else has a use for.
 */
export const handBackLifetimeMs = 5 * 60 * 1000;

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
  /** The text of the parts of the post, in order. */
  content: PostContent;
  /**
   * How far the attempts before have come, as an adapter returned it, or
   * null if the delivery begins at the beginning.
   */
  progress: unknown;
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
   * apart that go to one account together.
   */
  startDeliveries(now: number): void {
    this.storage.transactionSync(() => {
      const busy = new Set(
        this.db
          .select({ channelId: postTargets.channelId })
          .from(postTargets)
          .where(eq(postTargets.status, "sending"))
          .all()
          .map(({ channelId }) => channelId),
      );
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
   * It is safe to repeat: while this delivery is under way no other to
   * the channel is, so none has recorded anything since the first time.
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
        .set({ progress: null })
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
   * key.
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
        .select({ status: postTargets.status, attempt: postTargets.attempt })
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
      return { ok: true, by: mark };
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
   * What is left to do for the deliveries: `begin` if a target that waits
   * can begin, because its channel has no delivery under way. `watch` if
   * none can and some are under way: there is nothing to do at once, but
   * to come back and see that they end, and to create the workflow of one
   * that has none yet. `nothing` if none waits or is under way.
   */
  get deliveriesNeed(): "begin" | "watch" | "nothing" {
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
    const begin = targets.some(
      ({ status, channelId }) => status === "queued" && !busy.has(channelId),
    );
    return begin ? "begin" : targets.length > 0 ? "watch" : "nothing";
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
        parts: inReadingOrder(
          findRows(this.db, "post_part", "postId", target.postId),
        ).map(({ text }) => ({ text })),
      },
      progress: target.progress ?? null,
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
   */
  private run(
    mutations: MutatorCall[],
    now: number,
    source: MutationSource,
  ): (Refusal | null)[] {
    this.forgetHandedBack(now);
    const before = this.record();
    let { seq, time } = before;
    const outcomes = mutations.map((mutation) => {
      time = Math.max(now, time + 1);
      const tx = new RecordingTransaction(this.db, time);
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
