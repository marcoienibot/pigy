import type { Fetch } from "@pigy/core";
import type { SimWorld } from "../world/index.ts";
import { html, json, text, withFaults } from "./http.ts";
import {
  dnsQuery,
  dnsResolverHost,
  handleFile,
  plcDirectory,
  plcDirectoryHost,
  webDidDocument,
} from "./identity.ts";
import {
  authorize,
  type BlueskySimulatorOptions,
  pushRequest,
  resourceMetadata,
  revoke,
  serverMetadata,
  token,
} from "./oauth.ts";
import { xrpc } from "./pds.ts";
import {
  type BlueskyAccount,
  type BlueskyFaultKind,
  blueskyFaultKinds,
  blueskyOperations,
  createState,
  type Operation,
  type State,
} from "./state.ts";

export { dnsResolverHost, plcDirectoryHost } from "./identity.ts";
export type { BlueskySimulatorOptions } from "./oauth.ts";
export {
  accessTokenLifetimeMs,
  refreshTokenLifetimeMs,
  sessionLifetimeMs,
} from "./oauth.ts";
export type { BlueskyAccount, PostRecord } from "./state.ts";
export { blueskyFaultKinds, blueskyOperations } from "./state.ts";

/**
 * A simulation of Bluesky and of the parts of atproto that pigy meets
 * there, written from the specifications at https://atproto.com/specs,
 * the documentation at https://docs.bsky.app and the lexicons that both
 * name. Where they leave a question open, the code of the servers that
 * Bluesky runs was read, and what was taken from it is marked GUESS, for a
 * run against the real network to confirm.
 *
 * Bluesky is not one server. An account is found by its handle, which
 * leads to its DID, whose document names the server that keeps the
 * account, which names the server that authorizes access to it. The
 * simulation answers for all of them, on their real addresses, so the
 * adapter under test is the adapter that runs against Bluesky:
 *
 * - the resolver that answers DNS queries over HTTPS, `cloudflare-dns.com`,
 * - the hosts of the handles that say their DID in a file,
 * - the directory of `did:plc`, `plc.directory`, and the hosts of `did:web`,
 * - the servers that keep accounts, each a PDS,
 * - the entryway that authorizes for Bluesky's own servers, `bsky.social`,
 *   and a PDS that authorizes for itself.
 *
 * It enforces the rules itself and shares no code with the adapter or with
 * pigy's own validation. record.ts says where it is stricter than a real
 * PDS, on purpose.
 *
 * It is part of the production build, because the sandbox runs on it. So
 * it acts on its world and on nothing else:
 *
 * - It makes no requests, and fails for every host that is not its own.
 *   Where a real server would fetch something, the metadata of a client,
 *   whoever makes the simulator says what it would find.
 * - Its accounts and the servers that keep them have names under `.test`,
 *   which cannot exist on the internet and which atproto sets aside for
 *   this. The directory, the resolver and the entryway have the names they
 *   have.
 * - It accepts only the secrets it made itself, which say what they are.
 *
 * Not simulated: the repositories behind the records, media, the app
 * view with its feeds and notifications, accounts that move, and the
 * limits that a server keeps per IP address.
 */

/** The entryway: the authorization server of Bluesky's own servers. */
export const blueskyEntryway = "bsky.social";

export type BlueskyFault = {
  kind: BlueskyFaultKind;
  /** Any of them, if left out. */
  operation?: Operation;
};

export type BlueskySimulator = {
  /**
   * Stands in for `fetch`. Answers requests to the hosts of the world and
   * fails for every other host, so nothing leaves the process.
   */
  fetch: Fetch;
  /**
   * Whether `host` is one of this simulator's own, as `URL.host` has it.
   * Whoever has the simulators of several networks asks each, and hands a
   * request to the one that owns its host.
   */
  owns(host: string): boolean;
  /**
   * Adds a server that keeps accounts. Its name must be under `.test`.
   * Its accounts are authorized by the entryway, or by the server itself
   * with `authorizes`.
   */
  addPds(host: string, options?: { authorizes?: boolean }): void;
  /** Adds an account to a server, for somebody to connect. */
  addAccount(account: {
    /** The handle, without "@": a name under `.test`. */
    handle: string;
    /** The host of the PDS that keeps the account. */
    pds: string;
    /** The name the person goes by. The handle, if left out. */
    name?: string;
    /** How the handle leads to the DID. By the DNS, if left out. */
    resolution?: BlueskyAccount["resolution"];
    /**
     * The method of the DID: registered with the directory, or the host of
     * the handle itself. `plc` if left out.
     */
    did?: "plc" | "web";
    /** Whether the account has a profile. It has, if left out. */
    profile?: boolean;
  }): BlueskyAccount;
  /** Arms a fault, which strikes the next request it applies to. */
  arm(fault: BlueskyFault): void;
};

const testName =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.test$/;

const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new `did:plc`: 24 characters, as the directory makes them. */
function newPlcDid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `did:plc:${Array.from(bytes, (byte) => base32[byte % 32]).join("")}`;
}

/** What a server answers for an address that it does not have. */
const notFound = () => text(404, "Not Found");

export function createBlueskySimulator(
  world: SimWorld,
  options: BlueskySimulatorOptions,
): BlueskySimulator {
  const state: State = createState(world);
  const entryway = `https://${blueskyEntryway}`;

  /** The account whose handle or `did:web` is served by `host`. */
  const accountAt = (host: string) =>
    state.accounts.all().find(({ domain }) => domain === host);

  /** The origin of the authorization server at `host`, if it is one. */
  const issuerAt = (host: string): string | undefined => {
    if (host === blueskyEntryway) return entryway;
    const pds = state.servers.get(host);
    return pds && pds.issuer === `https://${host}` ? pds.issuer : undefined;
  };

  const owns = (host: string) =>
    host === plcDirectoryHost ||
    host === dnsResolverHost ||
    host === blueskyEntryway ||
    state.servers.get(host) !== undefined ||
    accountAt(host) !== undefined;

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const host = url.hostname;
      if (url.protocol !== "https:" || url.port !== "" || !owns(host)) {
        // What `fetch` does when a host cannot be reached.
        throw new TypeError(
          `The simulated Bluesky has no host at ${url.origin}`,
        );
      }
      const { method } = request;
      const path = url.pathname;

      if (host === plcDirectoryHost) return plcDirectory(state, request, url);
      if (host === dnsResolverHost) return dnsQuery(state, request, url);

      const account = accountAt(host);
      if (method === "GET" && path === "/.well-known/atproto-did") {
        // A host says the DID of its handle only where that is how the
        // handle is resolved.
        return account?.resolution === "https"
          ? handleFile(state, account)
          : notFound();
      }
      if (method === "GET" && path === "/.well-known/did.json") {
        return account?.id === `did:web:${host}`
          ? webDidDocument(state, account)
          : notFound();
      }

      const pds = state.servers.get(host);
      const issuer = issuerAt(host);
      if (
        method === "GET" &&
        path === "/.well-known/oauth-protected-resource"
      ) {
        if (!pds) return notFound();
        return withFaults(state, "server", () =>
          json(200, resourceMetadata(pds)),
        );
      }
      if (
        method === "GET" &&
        path === "/.well-known/oauth-authorization-server"
      ) {
        if (!issuer) return notFound();
        return withFaults(state, "server", () =>
          json(200, serverMetadata(issuer)),
        );
      }
      if (issuer && path === "/oauth/par" && method === "POST") {
        return pushRequest(state, options, issuer, request);
      }
      if (
        issuer &&
        path === "/oauth/authorize" &&
        (method === "GET" || method === "POST")
      ) {
        return authorize(state, issuer, request, url);
      }
      if (issuer && path === "/oauth/token" && method === "POST") {
        return token(state, options, issuer, request);
      }
      if (issuer && path === "/oauth/revoke" && method === "POST") {
        return revoke(state, options, issuer, request);
      }
      if (pds && path.startsWith("/xrpc/")) {
        return xrpc(state, pds, request, url);
      }
      return path.startsWith("/xrpc/")
        ? json(404, { error: "NotFound", message: "Not Found" })
        : html(404, "<!doctype html><title>Not found</title>");
    },

    owns,

    addPds(host, { authorizes = false } = {}) {
      if (!testName.test(host)) {
        throw new Error(
          `A simulated PDS needs a name under .test, in lowercase: ${host}`,
        );
      }
      state.servers.put(host, {
        host,
        issuer: authorizes ? `https://${host}` : entryway,
      });
    },

    addAccount({
      handle,
      pds,
      name = handle,
      resolution = "dns",
      did = "plc",
      profile = true,
    }) {
      if (!testName.test(handle) || !handle.includes(".")) {
        throw new Error(
          `A simulated account needs a handle under .test, in lowercase: ${handle}`,
        );
      }
      if (!state.servers.get(pds)) {
        throw new Error(`The simulated Bluesky has no PDS ${pds}`);
      }
      if (accountAt(handle) || state.servers.get(handle)) {
        throw new Error(`${handle} exists already`);
      }
      const account: BlueskyAccount = {
        network: "bluesky",
        id: did === "web" ? `did:web:${handle}` : newPlcDid(),
        handle: `@${handle}`,
        name,
        domain: handle,
        pds,
        resolution,
        profile,
      };
      state.accounts.put(account.id, account);
      return account;
    },

    arm({ kind, operation }) {
      // Checked here as well as by the types: the sandbox passes on what a
      // person chose.
      if (!blueskyFaultKinds.includes(kind)) {
        throw new Error(`The simulated Bluesky has no fault "${kind}"`);
      }
      if (operation !== undefined && !blueskyOperations.includes(operation)) {
        throw new Error(`The simulated Bluesky has no request "${operation}"`);
      }
      world.faults.arm("bluesky", { kind, operation });
    },
  };
}
