import type { Clock, Fetch, Role } from "@pigy/core";
import type { SimulatedGoogle } from "./auth/config.ts";
import type { SimulatedPush } from "./push/simulated.ts";

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
  /**
   * The keys that pigy signs with as a client of Bluesky, see
   * src/network/bluesky-client.ts: a comma-separated list of
   * "<version>:<key>", each key a private key of ECDSA on P-256 in PKCS #8,
   * in base64. The key with the highest version signs the connections that
   * begin, and the public halves of all of them are in pigy's client
   * metadata. A connection is bound to the key that it began with, so a key
   * stays for as long as a connection that began with it is to last.
   * Without this variable no Bluesky account can be connected.
   */
  BLUESKY_CLIENT_KEYS?: string;
  /**
   * The application that whoever runs this pigy has made at LinkedIn, see
   * src/network/linkedin-client.ts: its client ID and its client secret,
   * from LinkedIn's developer portal. Without both, no LinkedIn account
   * can be connected in a live workspace. A sandbox needs neither.
   */
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  /**
   * The app that whoever runs this pigy has made at Meta for Threads, see
   * src/network/threads-app.ts: the Threads app ID and the Threads app
   * secret of its use case. Without both, no Threads account can be
   * connected in a live workspace, and none that is connected has its
   * access renewed. A sandbox needs neither.
   */
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  /**
   * The key that pigy signs with as a sender of push messages, see
   * src/push/keys.ts: a private key of ECDSA on P-256 in PKCS #8, in
   * base64. A browser subscribes with its public half, so replacing it
   * turns the notifications of every device off until they are turned on
   * again there. Without this variable no device can turn them on, and
   * nothing is sent. The inbox of the app works all the same.
   */
  VAPID_PRIVATE_KEY?: string;
  /**
   * The address that this pigy is reached at from the internet, such as
   * "https://pigy.example.workers.dev", without a path. It is no secret,
   * and declared here because it is set per deployment and can be
   * missing. Work that no request stands behind makes addresses with it:
   * the link at which Threads fetches an image of a post, see
   * src/media/links.ts. Without it no post with an image goes to a real
   * Threads account. A sandbox needs none.
   */
  APP_URL?: string;
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
  /**
   * Stands in for `CREDENTIAL_KEYS` when it is not set, in the same form.
   * Only builds for development and tests pass one: it is no secret.
   */
  developmentCredentialKeys: string | undefined;
  /**
   * Stands in for `BLUESKY_CLIENT_KEYS` when it is not set, in the same
   * form. Only builds for development and tests pass one: it is no secret.
   */
  developmentBlueskyClientKeys: string | undefined;
  /**
   * Stands in for `VAPID_PRIVATE_KEY` when it is not set, in the same
   * form. Only builds for development and tests pass one: it is no secret.
   */
  developmentVapidKey: string | undefined;
  /**
   * Stands in for the push services of the browsers, in the build that the
   * end-to-end tests run against, which reaches no real host. Only that
   * build passes one: see src/simulated-push.ts.
   */
  simulatedPush: SimulatedPush | undefined;
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
    /**
     * The ID of the session that the request came with, set by
     * `requireUser`. It is not the secret of the session: it names the
     * session and signs nobody in.
     */
    sessionId: string;
    /**
     * Set by a route whose answer is not the Worker's to add to: a file
     * of the web app that is passed on, which has the headers that
     * Cloudflare gives it. See src/security-headers.ts.
     */
    passedOn?: true;
  };
};
