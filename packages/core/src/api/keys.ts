import { z } from "zod";
import type { Environment } from "../workspace.ts";

/**
 * API keys: what the public API of `./v1.ts` is called with. A key belongs
 * to one workspace, so to one environment, and says so in how it begins.
 * These are the requests and the answers of the routes that the app
 * manages the keys with, for whoever is signed in. A key cannot make keys.
 */

/** What a key may do. */
export const apiScopes = [
  /** Read posts and the posting schedule. */
  "posts:read",
  /** Create, change, move and delete posts, and set the posting schedule. */
  "posts:write",
  /** Read the connected accounts. */
  "channels:read",
  /**
   * Upload media. Declared for the day that images exist: until then no
   * key is given it.
   */
  "media:write",
] as const;

export const apiScopeSchema = z.enum(apiScopes);

export type ApiScope = z.infer<typeof apiScopeSchema>;

/** The scopes that a key can be given today. */
export const grantableApiScopes = [
  "posts:read",
  "posts:write",
  "channels:read",
] as const satisfies readonly ApiScope[];

/**
 * What a key begins with, by the environment of its workspace. A key of a
 * sandbox says `test`, as the keys of other services do: what is done with
 * it reaches simulated networks only.
 */
export const apiKeyPrefixes: { readonly [E in Environment]: string } = {
  live: "pigy_live_",
  sandbox: "pigy_test_",
};

/** The most keys that a workspace has at a time, revoked ones not counted. */
export const maxApiKeys = 20;

/** The longest name of a key. */
export const maxApiKeyNameLength = 100;

/** A time, in milliseconds since the Unix epoch. */
const timeSchema = z.number().int().nonnegative();

/**
 * The last moment of the year 9999, in milliseconds since the Unix epoch:
 * the last that ISO 8601 writes with a year of four digits, which is how
 * the API says a time. The API takes no later one, and neither does the
 * field of the app for the time of a post. A date can hold later ones,
 * and so can the rows: `apiTime` says such a time as this one.
 */
export const maxApiTime = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** A key as the app shows it. Nothing in it lets anybody call the API. */
export const apiKeySchema = z.object({
  /** Names the key. It is the first part of the key after its prefix. */
  id: z.string().min(1),
  /** What the person called it. */
  name: z.string().min(1),
  /** How the key begins, to tell it from the others. */
  prefix: z.string().min(1),
  scopes: z.array(apiScopeSchema),
  createdAt: timeSchema,
  /** When it was last used, to the minute or so. Null if never. */
  lastUsedAt: timeSchema.nullable(),
  /** When it stops working by itself. Null if never. */
  expiresAt: timeSchema.nullable(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

/** Response of `GET /api/workspaces/{id}/api-keys`: the newest first. */
export const apiKeyListResponseSchema = z.object({
  apiKeys: z.array(apiKeySchema),
});

/** Body of `POST /api/workspaces/{id}/api-keys`. */
export const createApiKeyRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(maxApiKeyNameLength),
  scopes: z
    .array(apiScopeSchema)
    .min(1)
    .max(apiScopes.length)
    .refine(
      (scopes) => new Set(scopes).size === scopes.length,
      "A scope is listed twice",
    ),
  /** When the key stops working, or null for a key that does not. */
  expiresAt: timeSchema
    .max(maxApiTime, "A key expires in the year 9999 at the latest")
    .nullable(),
});

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/**
 * Response of `POST /api/workspaces/{id}/api-keys`. `secret` is the key
 * itself, and this is the only time that anybody is told it: the server
 * keeps a hash.
 */
export const createApiKeyResponseSchema = z.object({
  apiKey: apiKeySchema,
  secret: z.string().min(1),
});

export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;
