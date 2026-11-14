import { type Fetch, normalizeEmail } from "@pigy/core";
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
  /** Always allowed and always admins. Normalized like every stored email. */
  adminEmails: ReadonlySet<string>;
  /** Undefined when nobody can sign in: sign-in is refused, not skipped. */
  google: GoogleConnection | undefined;
  /** Set when `google` is the stand-in. */
  simulatedGoogle: SimulatedGoogle | undefined;
};

function parseAdminEmails(value: string): Set<string> {
  return new Set(value.split(",").map(normalizeEmail).filter(Boolean));
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
 * Reads who the admins are and how to reach Google for one request. Google
 * is the real one whenever its credentials are configured. Without them it
 * is the stand-in, if this build has one and the app is reached locally, at
 * `origin`.
 */
export function accessConfig(
  env: Bindings,
  fetch: Fetch,
  simulatedGoogle: SimulatedGoogle | undefined,
  origin: string,
): AccessConfig {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      adminEmails: parseAdminEmails(env.ADMIN_EMAILS ?? ""),
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        fetch,
        browserUrl: (googleUrl) => googleUrl,
      },
      simulatedGoogle: undefined,
    };
  }
  const simulated = isLocal(origin) ? simulatedGoogle : undefined;
  const adminEmails = parseAdminEmails(
    env.ADMIN_EMAILS ?? simulated?.defaultAdminEmails ?? "",
  );
  return {
    adminEmails,
    google: simulated?.connection(origin, adminEmails),
    simulatedGoogle: simulated,
  };
}
