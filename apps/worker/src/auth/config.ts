import { emailSchema, type Fetch } from "@pigy/core";
import type { Bindings } from "../env.ts";

/** How this deployment reaches Google. */
export type GoogleConnection = {
  clientId: string;
  clientSecret: string;
  /** Carries the requests the Worker makes to Google. */
  fetch: Fetch;
  /**
   * Turns an address at Google that the browser is about to be sent to into
   * the one it should open. `fetch` decides where the Worker's own requests
   * go, this does the same for the browser.
   */
  browserUrl: (googleUrl: URL) => URL;
};

/** A stand-in for Google that runs inside the Worker. */
export type SimulatedGoogle = {
  /** The admin when `ADMIN_EMAILS` is not set, so that a fresh clone works. */
  defaultAdminEmails: string;
  connection: (
    origin: string,
    adminEmails: Iterable<string>,
  ) => GoogleConnection;
  /** Answers what the browser asks of the simulated Google. */
  handle: (
    request: Request,
    adminEmails: Iterable<string>,
  ) => Promise<Response>;
};

type AccessConfig = {
  /** What `readAdminEmails` returns. */
  adminEmails: ReadonlySet<string>;
  /** Undefined when nobody can sign in: sign-in is refused, not skipped. */
  google: GoogleConnection | undefined;
  /** Set when `google` is the stand-in. */
  simulatedGoogle: SimulatedGoogle | undefined;
};

/**
 * The addresses in `value`, which is what `ADMIN_EMAILS` holds. An entry
 * that is not an email address is left out and reported. Unreported, a value
 * such as "a@example.com; b@example.com" would name no admin and lock
 * everybody out without a word in the logs.
 */
function parseAdminEmails(value: string): Set<string> {
  const emails = new Set<string>();
  for (const entry of value.split(",")) {
    // The variable is typed by hand. A stray comma is not worth a report.
    if (!entry.trim()) continue;
    const email = emailSchema.safeParse(entry);
    if (email.success) {
      emails.add(email.data);
    } else {
      console.error(
        `ADMIN_EMAILS has an entry that is not an email address and is ignored: ${JSON.stringify(entry.trim())}`,
      );
    }
  }
  return emails;
}

/**
 * Whether `origin` is this machine. The simulated Google answers nowhere
 * else, so that it stays out of reach even if a build that contains it were
 * ever deployed.
 */
function isLocal(origin: string): boolean {
  const { hostname } = new URL(origin);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * The stand-in for Google, if it is the Google of this request: no
 * credentials for the real one are configured, this build has a stand-in,
 * and the app is reached locally, at `origin`.
 */
function simulatedFor<Simulated>(
  env: Bindings,
  simulatedGoogle: Simulated | undefined,
  origin: string,
): Simulated | undefined {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return undefined;
  return isLocal(origin) ? simulatedGoogle : undefined;
}

/**
 * Reads who the admins are for one request: they are always allowed and
 * always admins, and normalized like every stored email. This is all that
 * most requests need of the configuration, so it takes no `fetch` and only
 * the one property of the stand-in that it reads. It cannot make a request
 * or start a simulation.
 */
export function readAdminEmails(
  env: Bindings,
  simulatedGoogle: Pick<SimulatedGoogle, "defaultAdminEmails"> | undefined,
  origin: string,
): ReadonlySet<string> {
  return parseAdminEmails(
    env.ADMIN_EMAILS ??
      simulatedFor(env, simulatedGoogle, origin)?.defaultAdminEmails ??
      "",
  );
}

/**
 * Reads who the admins are and how to reach Google for one request, for the
 * routes that sign somebody in. Google is the real one whenever its
 * credentials are configured. Without them it is the stand-in, if this build
 * has one and the app is reached locally, at `origin`.
 */
export function accessConfig(
  env: Bindings,
  fetch: Fetch,
  simulatedGoogle: SimulatedGoogle | undefined,
  origin: string,
): AccessConfig {
  const adminEmails = readAdminEmails(env, simulatedGoogle, origin);
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      adminEmails,
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        fetch,
        browserUrl: (googleUrl) => googleUrl,
      },
      simulatedGoogle: undefined,
    };
  }
  const simulated = simulatedFor(env, simulatedGoogle, origin);
  return {
    adminEmails,
    google: simulated?.connection(origin, adminEmails),
    simulatedGoogle: simulated,
  };
}
