import {
  environments,
  postStatuses,
  type RejectionCode,
  tableNames,
} from "@pigy/core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
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
