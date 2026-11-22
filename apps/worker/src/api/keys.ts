import {
  type ApiKey,
  type ApiScope,
  apiKeyPrefixes,
  type CreateApiKeyRequest,
  type Environment,
  environments,
  maxApiKeys,
  type Role,
} from "@pigy/core";
import { and, count, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { allowedEmails, apiKeys, users, workspaces } from "../db/schema.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";

/**
 * The keys of the public API, in D1. A key is "<prefix><id>_<secret>":
 *
 * - The prefix says the environment of the workspace that the key
 *   belongs to, `apiKeyPrefixes`.
 * - The ID names the row, so a key is found without its secret being
 *   compared with anything in the database.
 * - The secret is 256 bits from the system's random source, of which only
 *   a SHA-256 is stored. That is enough for a secret that cannot be
 *   guessed, unlike for a password.
 *
 * The key itself is handed out once, by `createApiKey`, and is in no log:
 * what names a key anywhere else is its ID.
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const randomHex = (bytes: number) =>
  hex(crypto.getRandomValues(new Uint8Array(bytes)));

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** A key as it is written, in its three parts. */
const keyPattern = new RegExp(
  `^(${environments.map((environment) => apiKeyPrefixes[environment]).join("|")})([0-9a-f]{16})_([0-9a-f]{64})$`,
);

/**
 * How often the last use of a key is written, at most, in milliseconds:
 * not with every request, which would be a write to D1 each.
 */
export const lastUsedEveryMs = 60 * 1000;

const shown = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
};

type Shown = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

const apiKeyOf = (row: Shown): ApiKey => ({
  ...row,
  createdAt: row.createdAt.getTime(),
  lastUsedAt: row.lastUsedAt?.getTime() ?? null,
  expiresAt: row.expiresAt?.getTime() ?? null,
});

/** The keys of a workspace that are not revoked, the newest first. */
export async function apiKeysOf(
  db: DrizzleD1Database,
  workspaceId: string,
): Promise<ApiKey[]> {
  const rows = await db
    .select(shown)
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(apiKeyOf);
}

/**
 * Makes a key for `workspace` and returns it with its secret, which is
 * the key itself: nothing can hand it out again. Null if the workspace
 * has as many keys as it can have.
 */
export async function createApiKey(
  db: DrizzleD1Database,
  workspace: Pick<WorkspaceIdentity, "id" | "environment">,
  { name, scopes, expiresAt }: CreateApiKeyRequest,
  now: Date,
): Promise<{ apiKey: ApiKey; secret: string } | null> {
  const [kept] = await db
    .select({ count: count() })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.workspaceId, workspace.id), isNull(apiKeys.revokedAt)),
    );
  if ((kept?.count ?? 0) >= maxApiKeys) return null;

  const id = randomHex(8);
  const secret = randomHex(32);
  const prefix = apiKeyPrefixes[workspace.environment];
  const row = {
    id,
    workspaceId: workspace.id,
    name,
    // Enough to tell the keys of a person apart, and nothing of the secret.
    prefix: `${prefix}${id.slice(0, 8)}`,
    secretHash: await sha256Hex(secret),
    scopes,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
  };
  await db.insert(apiKeys).values(row);
  return { apiKey: apiKeyOf(row), secret: `${prefix}${id}_${secret}` };
}

/**
 * Revokes a key of `workspaceId`: it calls nothing from the next request
 * on. Returns whether there was such a key that was not revoked.
 */
export async function revokeApiKey(
  db: DrizzleD1Database,
  workspaceId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(apiKeys.id, id),
        // The workspace is part of the question: a key of another one is
        // answered like one that does not exist.
        eq(apiKeys.workspaceId, workspaceId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/** Whom a key acts for, and what it may do. */
export type ApiKeyAuth = {
  key: { id: string; name: string; scopes: ApiScope[]; expiresAt: Date | null };
  workspace: WorkspaceIdentity;
  owner: { id: string; email: string; name: string };
  role: Role;
};

/** Why a key was not taken. The words are for whoever sent it. */
export type ApiKeyRefusal = { refused: string };

const unknown = { refused: "This API key is not valid" };

/**
 * Whom `key` acts for, or why it is refused. `key` is what came after
 * "Bearer".
 *
 * The owner of the workspace is looked up with the key, on every request,
 * and has to be invited still: by the row of the allowlist that a session
 * goes by, or by `adminEmails`. So the keys of a person who is removed
 * stop with the next request, whichever way their access ended: a row
 * that an admin removed, or an address that was taken out of
 * `ADMIN_EMAILS`, which no route hears of. Revoking the keys when the row
 * is removed would miss the second, and costs nothing less: the key has
 * to be read anyway, and the owner comes with it in one statement. They
 * work again if the person is invited again, as their workspaces are
 * there again.
 *
 * Until the secret has been found right, every refusal reads the same:
 * whoever has no key learns nothing of the keys that exist.
 */
export async function verifyApiKey(
  db: DrizzleD1Database,
  key: string,
  adminEmails: ReadonlySet<string>,
  now: Date,
): Promise<ApiKeyAuth | ApiKeyRefusal> {
  const [, prefix, id, secret] = keyPattern.exec(key) ?? [];
  if (!prefix || !id || !secret) return unknown;
  const [row] = await db
    .select({
      name: apiKeys.name,
      secretHash: apiKeys.secretHash,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      workspaceId: workspaces.id,
      environment: workspaces.environment,
      ownerId: users.id,
      email: users.email,
      ownerName: users.name,
      role: allowedEmails.role,
    })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.ownerId))
    .leftJoin(allowedEmails, eq(allowedEmails.email, users.email))
    .where(eq(apiKeys.id, id));
  if (!row) return unknown;

  const expected = encoder.encode(row.secretHash);
  const actual = encoder.encode(await sha256Hex(secret));
  // In constant time, as for the secret of a session: how long a wrong
  // secret takes says nothing about how much of it was right.
  if (
    expected.byteLength !== actual.byteLength ||
    !crypto.subtle.timingSafeEqual(expected, actual)
  ) {
    return unknown;
  }
  // A key says its environment twice, in its prefix and by its workspace.
  // They agree for every key that pigy made.
  if (prefix !== apiKeyPrefixes[row.environment as Environment]) return unknown;
  if (row.revokedAt) return { refused: "This API key was revoked" };
  if (row.expiresAt && now >= row.expiresAt) {
    return { refused: "This API key has expired" };
  }
  const role = adminEmails.has(row.email) ? "admin" : row.role;
  if (!role) {
    return { refused: "The owner of this API key no longer has access" };
  }

  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() >= lastUsedEveryMs
  ) {
    const stale = new Date(now.getTime() - lastUsedEveryMs);
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      // Asked again here: of the requests that arrive together, one writes.
      .where(
        and(
          eq(apiKeys.id, id),
          or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, stale)),
        ),
      );
  }
  return {
    key: { id, name: row.name, scopes: row.scopes, expiresAt: row.expiresAt },
    workspace: {
      id: row.workspaceId,
      ownerId: row.ownerId,
      environment: row.environment,
    },
    owner: { id: row.ownerId, email: row.email, name: row.ownerName },
    role,
  };
}
