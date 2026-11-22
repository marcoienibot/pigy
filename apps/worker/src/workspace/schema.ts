import {
  channelStatuses,
  environments,
  imageTypes,
  type Limits,
  mediaStatuses,
  metricStatuses,
  networks,
  notificationKinds,
  type PushMessage,
  postModes,
  postStatuses,
  type RejectionCode,
  type settingsId,
  tableNames,
  targetStatuses,
} from "@pigy/core";
import {
  type AnySQLiteColumn,
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

export const posts = sqliteTable(
  "post",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: postStatuses }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // The five below came with scheduling. All can be null, which is what
    // they are for every post from before.
    mode: text("mode", { enum: postModes }),
    dueAt: integer("due_at"),
    queuePosition: integer("queue_position"),
    heldAt: integer("held_at"),
    trashedAt: integer("trashed_at"),
  },
  (table) => [
    // By status, and within one by age. For the scheduled posts, which
    // the mutators of the queue and every look at what is due ask for,
    // among all that were ever published: the index begins with the
    // status. And for the pages of the posts of one status that the API
    // lists, the newest first, which are a walk down it.
    index("post_status_created_at_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    // For the pages of all posts that the API lists, the newest first.
    index("post_created_at_idx").on(table.createdAt, table.id),
  ],
);

export const postParts = sqliteTable(
  "post_part",
  {
    id: text("id").primaryKey(),
    // Not "on delete cascade": a row that the database deletes by itself is
    // a change that no client hears of.
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    /**
     * The target that the part is written for, in place of the post's own
     * text, or null for a part of that. The mutators delete such a part
     * before its target.
     */
    targetId: text("target_id").references(
      (): AnySQLiteColumn => postTargets.id,
    ),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (table) => [
    index("post_part_post_id_idx").on(table.postId),
    // `target_id` refers to a target, so SQLite looks for the parts of
    // every target that is deleted: without this, through all the parts
    // of the workspace, for each account that a draft no longer goes to.
    index("post_part_target_id_idx").on(table.targetId),
  ],
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
     * has that, or when the object next tries after a refresh that did
     * not work. The alarm of the object goes by it: src/workspace/renewal.ts.
     */
    refreshAt: integer("refresh_at"),
    /**
     * The end of an access that the person was told of, a week before
     * it: the `expiresAt` that the reminder was for. A reminder is given
     * once for each end, and this is what says that it was: an access
     * that is connected again or renewed has another end. Null until the
     * first.
     */
    expiryWarnedFor: integer("expiry_warned_for"),
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
    // The targets from before the column that a disconnect had ended are
    // marked by the migration that adds it, by the text of their error:
    // a post of theirs that is still being sent to another account has
    // its notification decided after the upgrade.
    disconnected: integer("disconnected", { mode: "boolean" })
      .notNull()
      .default(false),

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
    /**
     * Whether an attempt at this delivery has ended without anybody
     * knowing what became of what it sent: it ended `uncertain`. It stays
     * set over the attempts after that one, whatever they end with, until
     * the target is sent. `endDelivery` of store.ts sets it, and
     * `aboutToSend` takes it back for a delivery that begins anew. An
     * adapter that cannot look for its post goes by it: only where it is
     * set can a post that the network names be the delivery's own.
     */
    mayHaveSent: integer("may_have_sent", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * When the server next reads the stats of the delivery, for one that
     * is `sent`: at once when it was sent, then at the moments of
     * `metricMoments` after that, or later where the network asked to be
     * asked later. Null when it reads no more, and for every target that
     * is not sent: src/workspace/stats.ts. A target that was sent before
     * the column has none, and gets no stats.
     */
    metricsAt: integer("metrics_at"),
  },
  (table) => [
    // A post goes to a channel once.
    uniqueIndex("post_target_post_id_channel_id_idx").on(
      table.postId,
      table.channelId,
    ),
    index("post_target_channel_id_idx").on(table.channelId),
    // For the queue: the targets that wait and those under way are looked
    // up by their status at every change of the workspace, and they are
    // few among all that were ever published.
    index("post_target_status_idx").on(table.status),
    // For the next stats to read, which every change asks for, among all
    // that were ever published: most have none to read any more. Only a
    // target that is sent is read, and under its status the targets are in
    // the order of their next read, so a question for the sent ones goes
    // straight to the first that has one: by the time alone, or by the
    // status alone, SQLite goes through every delivery that was ever sent.
    index("post_target_metrics_at_idx").on(table.status, table.metricsAt),
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
    // `part_id` refers to a part, so SQLite looks for the results of
    // every part that is deleted. The index above begins with the target
    // and is no help with that.
    index("target_part_result_part_id_idx").on(table.partId),
  ],
);

/** The stats of a delivery: see `metricRowSchema`. */
export const metrics = sqliteTable("metric", {
  // The ID of the target. The mutators delete it before its target.
  id: text("id")
    .primaryKey()
    .references(() => postTargets.id),
  status: text("status", { enum: metricStatuses }).notNull(),
  likes: integer("likes"),
  reposts: integer("reposts"),
  replies: integer("replies"),
  quotes: integer("quotes"),
  views: integer("views"),
  countedAt: integer("counted_at"),
  reason: text("reason"),
});

/** What the inbox of the app says: see `notificationRowSchema`. */
export const notifications = sqliteTable(
  "notification",
  {
    // The ID of the post or the channel that it is about. No reference to
    // either: it is one or the other.
    id: text("id").primaryKey(),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    postId: text("post_id"),
    channelId: text("channel_id"),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  // For the oldest, which is the next to go.
  (table) => [index("notification_created_at_idx").on(table.createdAt)],
);

/** A slot of the queue: a time of the week. */
export const scheduleSlots = sqliteTable(
  "schedule_slot",
  {
    id: text("id").primaryKey(),
    weekday: integer("weekday").notNull(),
    minute: integer("minute").notNull(),
  },
  (table) => [
    // A time of the week is one slot.
    uniqueIndex("schedule_slot_weekday_minute_idx").on(
      table.weekday,
      table.minute,
    ),
  ],
);

/** What the workspace has set: one row at most, under `settingsId`. */
export const settings = sqliteTable("settings", {
  id: text("id").$type<typeof settingsId>().primaryKey(),
  timeZone: text("time_zone"),
  queuePaused: integer("queue_paused", { mode: "boolean" }).notNull(),
});

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["image"] }).notNull(),
    status: text("status", { enum: mediaStatuses }).notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: imageTypes }).notNull(),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    animated: integer("animated", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
    error: text("error"),
    originalGoneAt: integer("original_gone_at"),

    // The columns below are not synced. Where the bytes are in the bucket
    // is no column: `mediaKeys` of src/media/keys.ts makes it of the IDs
    // of the workspace and of the image.

    /**
     * The upload in several parts that the bytes arrive through, as the
     * bucket names it, while the image is `uploading` and its upload has
     * begun. Null before, and afterwards: also after the alarm has given
     * the upload up, once the bucket has dropped its parts.
     */
    uploadId: text("upload_id"),
    /**
     * When the alarm asks the bucket to drop the parts of the upload
     * `uploadId`, which it has given up, or null while there is nothing to
     * drop. The bucket bills the parts for as long as it has them, so the
     * alarm asks again, an hour later, until the bucket has done so or
     * says that it has no such upload, or for `dropUploadForMs`.
     */
    uploadAbortAt: integer("upload_abort_at"),
    /**
     * When the alarm gave the upload `uploadId` up, while it asks the
     * bucket to drop its parts. It stops asking `dropUploadForMs` later:
     * by then the lifecycle rule of the bucket has dropped them, if the
     * bucket has one.
     */
    uploadGivenUpAt: integer("upload_given_up_at"),
    /**
     * The parts of that upload that the bucket has, each with its number
     * and with what the bucket said of it, which finishing the upload
     * takes. Null with `uploadId`.
     */
    uploadParts: text("upload_parts", { mode: "json" }).$type<
      { partNumber: number; etag: string }[]
    >(),
    /**
     * Since when the image has been in no part, or null while it is in
     * one. The store keeps it with every change of what is in a part, and
     * the alarm of the object deletes an image that has been in none for
     * `unattachedMs`.
     */
    unattachedSince: integer("unattached_since"),
  },
  (table) => [
    // The mutator that makes a row counts the ones that are on their way.
    index("media_status_idx").on(table.status),
  ],
);

export const partMedia = sqliteTable(
  "part_media",
  {
    id: text("id").primaryKey(),
    // Not "on delete cascade", as everywhere: the mutators delete these
    // rows before the part.
    partId: text("part_id")
      .notNull()
      .references(() => postParts.id),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id),
    position: integer("position").notNull(),
    alt: text("alt").notNull(),
  },
  (table) => [
    index("part_media_part_id_idx").on(table.partId),
    index("part_media_media_id_idx").on(table.mediaId),
  ],
);

// The tables below never leave the object.

/**
 * The push messages that are to go to the devices of the owner and have
 * not gone yet. A row is written in the transaction of the change that
 * the message is about, and removed when the message has been handed to
 * the push services, by the alarm of the object: store.ts and object.ts.
 */
export const pushOutbox = sqliteTable("push_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** What the message says. It holds no text of a post and no name. */
  message: text("message", { mode: "json" }).$type<PushMessage>().notNull(),
  /** The notification of the inbox that it goes with. */
  notificationId: text("notification_id").notNull(),
  queuedAt: integer("queued_at").notNull(),
});

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
  /**
   * Since when the workspace is frozen, in milliseconds since the epoch, or
   * null while it is not: its owner has lost their access to pigy. A copy
   * of `frozen_at` of the `workspace` table of D1, which is what decides,
   * and which the object reads anew whenever the Worker says that it has
   * changed, and where a copy that is out of date would matter: see
   * `#checkFreeze` of object.ts. While it is set, the workspace takes up
   * no scheduled post, renews no access, begins no delivery and takes no
   * change from a client: `WorkspaceStore`.
   */
  frozenAt: integer("frozen_at"),
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
 * How a call of the Worker that came with a key ended: done, with what the
 * call hands back besides, or refused. What it hands back is plain data,
 * and a secret among it is sealed: the access that a connection replaced.
 * The store takes that one out again after some minutes, and leaves the
 * rest: `forgetHandedBack`.
 */
export type KeyedOutcome =
  | { ok: true; [handedBack: string]: unknown }
  | { ok: false; code: RejectionCode; message: string };

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
    outcome: text("outcome", { mode: "json" }).$type<KeyedOutcome>().notNull(),
    handledAt: integer("handled_at").notNull(),
  },
  (table) => [index("keyed_call_handled_at_idx").on(table.handledAt)],
);
