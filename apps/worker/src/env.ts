import type { Clock, Fetch, Role } from "@pigy/core";
import type { SimulatedGoogle } from "./auth/config.ts";

/**
 * Variables that are set as secrets, with `wrangler secret put` or in
 * `.dev.vars`. They are not in wrangler.jsonc, so `wrangler types` knows only
 * the ones in this machine's `.dev.vars`. Declared here, they have the same
 * type on every machine, and that type says that they can be missing.
 */
type Secrets = {
  /** Comma-separated. These people can always sign in and are admins. */
  ADMIN_EMAILS?: string;
  /** The OAuth client of the Google Cloud project. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * The keys that the credentials of the channels are sealed with, see
   * src/vault.ts: a comma-separated list of "<version>:<key>", each key 32
   * random bytes in base64. The key with the highest version seals, and
   * every key opens what was sealed with it. So a key is replaced by adding
   * one with a higher version, and the old one stays for as long as
   * anything is stored that it sealed. Without this variable no account
   * can be connected.
   */
  CREDENTIAL_KEYS?: string;
};

export type Bindings = Omit<Env, keyof Secrets> & Secrets;

/** What the app takes from outside instead of from globals. */
export type AppDependencies = {
  /** Carries every request to an external service. */
  fetch: Fetch;
  now: Clock;
  /**
   * Stands in for Google when no credentials are configured. Only builds for
   * development and tests pass one.
   */
  simulatedGoogle: SimulatedGoogle | undefined;
};

/** Who is making the request. */
export type Auth = {
  user: { id: string; email: string; name: string };
  role: Role;
};

/** The Hono environment of every route. */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    /** Set by `requireUser`. */
    auth: Auth;
  };
};
