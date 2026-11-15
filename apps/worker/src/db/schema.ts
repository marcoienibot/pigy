import { environments, networks } from "@pigy/core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The D1 schema: sign-in and what is global. The data of a workspace is not
 * here, it is in the workspace's Durable Object: src/workspace/schema.ts.
 * After changing this file, run `pnpm --filter @pigy/worker db:generate` and
 * commit the SQL file it adds to `migrations`.
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
 * exists and whose it is. The data is in the Durable Object that is named
 * after the ID.
 */
export const workspaces = sqliteTable(
  "workspace",
  {
    /** Random, so that it cannot be guessed from a user ID. */
    id: text("id").primaryKey(),
    // Not "on delete cascade": deleting this row would leave the data in
    // the Durable Object behind, with nothing pointing to it.
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

/**
 * pigy as the Mastodon instances know it: the OAuth client that it
 * registered with each, the first time somebody connected an account
 * there. A cache: the adapter replaces an entry that the instance no longer
 * knows, and one that cannot be read.
 */
export const mastodonApps = sqliteTable(
  "mastodon_app",
  {
    /**
     * Whose instances these are. "live" for the real ones, where everybody
     * shares a registration. The ID of a sandbox workspace for the
     * simulated ones of its world: the same domain is another instance in
     * every world.
     */
    scope: text("scope").notNull(),
    domain: text("domain").notNull(),
    /** What the adapter stored, sealed by src/vault.ts: it holds a secret. */
    registration: text("registration").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.domain] })],
);

/**
 * The connections of accounts that have begun and whose answer from the
 * network is still out. A row is taken out when the answer comes, so it is
 * good for one answer.
 */
export const oauthStates = sqliteTable(
  "oauth_state",
  {
    /** The `state` that the network sends back. Random, made by the adapter. */
    state: text("state").primaryKey(),
    /**
     * The session that began. Only the same session can finish, and the row
     * goes when the session ends.
     */
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** The workspace that the account is connected to. */
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    network: text("network", { enum: networks }).notNull(),
    /**
     * What the adapter needs to finish, sealed by src/vault.ts: it holds
     * secrets.
     */
    pending: text("pending").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("oauth_state_expires_at_idx").on(table.expiresAt)],
);
