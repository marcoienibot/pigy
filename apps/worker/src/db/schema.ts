import { environments } from "@pigy/core";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The D1 schema. After changing it, run `pnpm --filter @pigy/worker
 * db:generate` and commit the SQL file it adds to `migrations`.
 */

/** A person who has signed in at least once. */
export const users = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    /**
     * The Google account ID, the `sub` claim. It is the identity: an email
     * address can change or move to another account, this cannot.
     */
    googleSub: text("google_sub").notNull().unique(),
    /** As of the last sign-in that succeeded, trimmed and lowercased. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("user_email_idx").on(table.email)],
);

/**
 * The cookie of a session holds "<id>.<secret>". Only a hash of the secret
 * is stored, so a copy of this table signs nobody in.
 */
export const sessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the secret, as hex. */
    secretHash: text("secret_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Moves forward while the session is in use. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

/**
 * Who may sign in, and as what. The emails in the `ADMIN_EMAILS` variable are
 * allowed without a row here.
 */
export const allowedEmails = sqliteTable("allowed_email", {
  /** Trimmed and lowercased. */
  email: text("email").primaryKey(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  /** The admin who added the row. */
  invitedBy: text("invited_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One user's data in one environment. The row only says that the workspace
 * exists and whose it is.
 */
export const workspaces = sqliteTable(
  "workspace",
  {
    /** Random, so that it cannot be guessed from a user ID. */
    id: text("id").primaryKey(),
    // Not "on delete cascade": deleting this row would leave the data of
    // the workspace behind, with nothing pointing to it.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    environment: text("environment", { enum: environments }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // One workspace per user and environment. This is also what makes
    // creating them idempotent.
    uniqueIndex("workspace_owner_environment_idx").on(
      table.ownerId,
      table.environment,
    ),
  ],
);
