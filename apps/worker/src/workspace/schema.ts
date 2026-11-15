import {
  channelStatuses,
  environments,
  type Limits,
  networks,
  postStatuses,
  type RejectionCode,
  tableNames,
  targetStatuses,
} from "@pigy/core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The schema of the SQLite database that every workspace has in its Durable
 * Object. After changing it, run `pnpm --filter @pigy/worker
 * workspace:generate` and commit what it adds to `migrations` next to this
 * file. The migrations are part of the Worker, and an object applies them to
 * its database when it starts.
 */

// The synced tables. Clients hold a copy of the columns that synced.ts
// lists, which are the fields of the rows in @pigy/core. Times are
// milliseconds since the Unix epoch.

export const posts = sqliteTable("post", {
  id: text("id").primaryKey(),
  status: text("status", { enum: postStatuses }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const postParts = sqliteTable(
  "post_part",
  {
    id: text("id").primaryKey(),
    // Not "on delete cascade": a row that the database deletes by itself is
    // a change that no client hears of.
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (table) => [index("post_part_post_id_idx").on(table.postId)],
);

export const channels = sqliteTable(
  "channel",
  {
    id: text("id").primaryKey(),
    network: text("network", { enum: networks }).notNull(),
    accountId: text("account_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    profileUrl: text("profile_url"),
    status: text("status", { enum: channelStatuses }).notNull(),
    connectedAt: integer("connected_at").notNull(),
    expiresAt: integer("expires_at"),
    limits: text("limits", { mode: "json" }).$type<Limits>(),
    limitsCheckedAt: integer("limits_checked_at"),

    // The columns below are not synced: synced.ts does not list them, so
    // they never leave the object. `connectChannel` of store.ts writes them
    // in the same transaction as the mutator that writes the row.

    /**
     * What the adapter of the network acts for the account with, sealed by
     * the Worker before it gets here: see src/vault.ts. The object stores
     * it and hands it back, and has no way to read it.
     */
    credentials: text("credentials"),
    /**
     * When the adapter wants the credentials refreshed, where the network
     * has that. Nothing reads it yet: the timer comes with the first
     * network that needs one.
     */
    refreshAt: integer("refresh_at"),
  },
  (table) => [
    // An account is one channel, however often it is connected.
    uniqueIndex("channel_network_account_id_idx").on(
      table.network,
      table.accountId,
    ),
  ],
);

/** The delivery of a post to one channel. */
export const postTargets = sqliteTable(
  "post_target",
  {
    id: text("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    // No reference to the channel: a target that has ended outlives the
    // channel it went to.
    channelId: text("channel_id").notNull(),
    status: text("status", { enum: targetStatuses }).notNull(),
    attempt: integer("attempt").notNull(),
    error: text("error"),
    queuedAt: integer("queued_at"),
    sentAt: integer("sent_at"),

    // The columns below are not synced: they are the bookkeeping of the
    // deliveries, which store.ts reads and writes.

    /**
     * How far the publishing has come, as the adapter of the network
     * returned it from its last step: the progress that the next attempt
     * goes on from. It holds no secret. Null if nothing is recorded, and
     * for a delivery that has to begin anew.
     */
    progress: text("progress", { mode: "json" }).$type<unknown>(),
    /**
     * The attempt that a workflow was created for. A target that is
     * `sending` in a later attempt than this has yet to get its workflow.
     */
    dispatched: integer("dispatched").notNull().default(0),
    /**
     * The time at which the workspace began the delivery that the target
     * is on, or was on last: that of the mutation which made it `sending`,
     * which no other mutation of the workspace shares. It is part of the
     * ID of the run that carries the delivery.
     */
    startedAt: integer("started_at").notNull().default(0),
  },
  (table) => [
    // A post goes to a channel once.
    uniqueIndex("post_target_post_id_channel_id_idx").on(
      table.postId,
      table.channelId,
    ),
    index("post_target_channel_id_idx").on(table.channelId),
  ],
);

/** Where a part of a post stands on the network of a target. */
export const targetPartResults = sqliteTable(
  "target_part_result",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id")
      .notNull()
      .references(() => postTargets.id),
    partId: text("part_id")
      .notNull()
      .references(() => postParts.id),
    remoteId: text("remote_id").notNull(),
    url: text("url"),
  },
  (table) => [
    // A part is published to a target once.
    uniqueIndex("target_part_result_target_id_part_id_idx").on(
      table.targetId,
      table.partId,
    ),
  ],
);

// The tables below never leave the object.

/**
 * A single row: which workspace this object holds, and how far its changes
 * have come.
 */
export const workspaceRecord = sqliteTable("workspace", {
  /** As in the `workspace` table of D1. */
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  environment: text("environment", { enum: environments }).notNull(),
  /** The sequence number of the last change. */
  seq: integer("seq").notNull(),
  /** `change_log` is complete for the changes after this one. */
  logFloor: integer("log_floor").notNull(),
  /**
   * The time that the last mutation was run at, in milliseconds since the
   * epoch. The next one is run later than that, whatever the clock says.
   * A workspace that is older than this column begins at the latest time
   * that its rows hold: the migration that adds the column sets it.
   */
  time: integer("time").notNull().default(0),
});

/** Which rows each of the latest changes wrote or deleted. */
export const changeLog = sqliteTable(
  "change_log",
  {
    seq: integer("seq").notNull(),
    tableName: text("table_name", { enum: tableNames }).notNull(),
    rowId: text("row_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.seq, table.tableName, table.rowId] }),
  ],
);

/** The last mutation that was processed for each client. */
export const clientMutations = sqliteTable("client_mutation", {
  clientId: text("client_id").primaryKey(),
  lastMutationId: integer("last_mutation_id").notNull(),
});

/**
 * The mutations of each client that were rejected, and why. A row is kept
 * until the client has said that it knows: the answer that told it can get
 * lost.
 */
export const rejections = sqliteTable(
  "rejection",
  {
    clientId: text("client_id").notNull(),
    mutationId: integer("mutation_id").notNull(),
    code: text("code").$type<RejectionCode>().notNull(),
    message: text("message").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.mutationId] })],
);

/**
 * The calls of the Worker that came with a key, and how each ended: a call
 * that comes a second time is answered from here and not carried out again.
 * A row is kept for as long as a caller may still repeat the call.
 */
export const keyedCalls = sqliteTable(
  "keyed_call",
  {
    key: text("key").primaryKey(),
    /** What the call was answered with. */
    outcome: text("outcome", { mode: "json" })
      .$type<
        { ok: true } | { ok: false; code: RejectionCode; message: string }
      >()
      .notNull(),
    handledAt: integer("handled_at").notNull(),
  },
  (table) => [index("keyed_call_handled_at_idx").on(table.handledAt)],
);
