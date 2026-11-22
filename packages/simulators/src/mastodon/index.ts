import type { Fetch } from "@pigy/core";
import type { FaultKind, SimWorld } from "../world/index.ts";
import {
  type Caller,
  createStatus,
  deleteStatus,
  listStatuses,
  showInstance,
  showSource,
  showStatus,
  verifyCredentials,
} from "./api.ts";
import { apiError, html, json } from "./http.ts";
import { showMedia, uploadMedia } from "./media.ts";
import {
  authorize,
  createApp,
  oauthMetadata,
  revoke,
  token as tokenEndpoint,
} from "./oauth.ts";
import {
  atLeast,
  createState,
  type Instance,
  type MastodonAccount,
  type MastodonToken,
} from "./state.ts";

export type { Instance, MastodonAccount } from "./state.ts";

/**
 * A simulation of Mastodon, written from https://docs.joinmastodon.org and,
 * where the documentation leaves a question open, from the code of Mastodon
 * that it links to. What had to be guessed is marked GUESS, for a run
 * against a real server to confirm.
 *
 * It answers on the addresses of the instances in its world, so the adapter
 * under test is the adapter that runs against Mastodon. It enforces
 * Mastodon's rules itself and shares no code with the adapter or with
 * pigy's own validation: a simulator that is more lenient than the service
 * hides the mistakes it is there to find.
 *
 * It is part of the production build, because the sandbox runs on it. So
 * it acts on its world and on nothing else:
 *
 * - It makes no requests, and fails for every host that is not an instance
 *   of its world.
 * - Its instances have names that cannot exist on the internet.
 * - It accepts only the secrets it made itself, which say what they are.
 *
 * Not simulated: media, polls, scheduled statuses, quotes, content
 * warnings, followers, federation between instances beyond finding the
 * account that a mention names, and the limits that Mastodon keeps per IP
 * address. What people do with a status is counted, and nobody does it:
 * the counts of a status are what its world says, `engagementOf`.
 */

/** The faults that Mastodon can suffer from. */
export const mastodonFaultKinds = [
  "rate-limit",
  "server-error",
  "lost-response",
  "token-revoked",
] as const satisfies readonly FaultKind[];

/**
 * The requests that a fault can strike: reading the instance, asking whose
 * token it is, and posting, reading and deleting a status. Reading takes in
 * the list of an account's statuses, the source of one, and its counts,
 * which are in the status.
 */
export const mastodonOperations = [
  "instance",
  "account",
  "publish",
  "read",
  "delete",
] as const;

type Operation = (typeof mastodonOperations)[number];

export type MastodonFault = {
  kind: (typeof mastodonFaultKinds)[number];
  /** Any of them, if left out. */
  operation?: Operation;
};

export type MastodonSimulator = {
  /**
   * Stands in for `fetch`. Answers requests to the instances of the world
   * and fails for every other host, so nothing leaves the process.
   */
  fetch: Fetch;
  /**
   * Whether `host` is one of this simulator's own: the domain of an
   * instance of the world. `host` is that of an address, as `URL.host` has
   * it. Whoever has the simulators of several networks asks each, and
   * hands a request to the one that owns its host.
   */
  owns(host: string): boolean;
  /**
   * Adds an instance to the world. Its domain must be under `.example`,
   * `.test` or `.invalid`, which are reserved: no real server has such a
   * name, so a simulated instance can never be taken for a real one, and a
   * request meant for it can never reach one.
   */
  addInstance(
    domain: string,
    options?: Partial<Omit<Instance, "domain">>,
  ): void;
  /**
   * Adds an account to an instance, for somebody to connect. `settings`
   * has what differs from an account as it is made: the visibility of its
   * statuses, and whether its moderators have limited it.
   */
  addAccount(
    domain: string,
    username: string,
    name?: string,
    settings?: Pick<MastodonAccount, "privacy" | "limited">,
  ): MastodonAccount;
  /** Arms a fault, which strikes the next request it applies to. */
  arm(fault: MastodonFault): void;
};

const reservedDomain =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.(example|test|invalid)$/;

// Mastodon counts requests in spans of time that start on the clock, not
// with the first request.
type Throttle = { limit: number; seconds: number };
// api/rate-limits: per token, per account for deletions.
const perToken: Throttle = { limit: 300, seconds: 5 * 60 };
const deletions: Throttle = { limit: 30, seconds: 30 * 60 };
// From app/lib/rate_limiter.rb: statuses posted per account.
const posted: Throttle = { limit: 300, seconds: 3 * 60 * 60 };
// api/rate-limits: media uploaded per account.
const uploads: Throttle = { limit: 30, seconds: 30 * 60 };

type Count = {
  limit: number;
  remaining: number;
  reset: Date;
  exceeded: boolean;
};

/** What a request to the API needs of whoever makes it. */
type Access =
  /** Nothing. A token is not looked at. */
  | { who: "anybody" }
  /** Nothing, but a token that is sent has to be good and have a scope. */
  | { who: "anybody-or-token"; scopes: string[] }
  /** A token with one of the scopes, of an account or of a client alone. */
  | { who: "token"; scopes: string[] }
  /** The token of an account, with one of the scopes. */
  | { who: "account"; scopes: string[] };

type Route = {
  operation: Operation;
  access: Access;
  throttles?: Throttle[];
  run(caller: Caller | undefined): Response | Promise<Response>;
};

export function createMastodonSimulator(world: SimWorld): MastodonSimulator {
  const state = createState(world);

  /** Counts one more of `what` and says where that leaves the limit. */
  function count(what: string, { limit, seconds }: Throttle): Count {
    const span = Math.floor(world.now().getTime() / 1000 / seconds);
    const counter = state.counters.get(what);
    const counted = (counter?.span === span ? counter.count : 0) + 1;
    state.counters.put(what, { span, count: counted });
    return {
      limit,
      remaining: Math.max(0, limit - counted),
      reset: new Date((span + 1) * seconds * 1000),
      exceeded: counted > limit,
    };
  }

  function rateLimitHeaders({ limit, remaining, reset }: Count) {
    return {
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(remaining),
      // Mastodon writes six digits after the second.
      "X-RateLimit-Reset": reset.toISOString().replace("Z", "000Z"),
    };
  }

  function tooManyRequests(counted: Count): Response {
    return json(
      429,
      { error: "Too many requests" },
      rateLimitHeaders({ ...counted, remaining: 0 }),
    );
  }

  /**
   * Who makes a request, by its token: a caller, undefined if it has no
   * token, or the refusal of a token that is not good.
   */
  function callerOf(
    instance: Instance,
    bearer: string | undefined,
  ): Caller | Response | undefined {
    if (bearer === undefined) return undefined;
    const token = world.findToken<MastodonToken>("mastodon", bearer);
    const app = token && state.apps.get(token.clientId);
    if (!token || !app || token.domain !== instance.domain) {
      return apiError(401, "The access token is invalid");
    }
    if (world.tokenStatus(token) !== "valid") {
      return apiError(401, "The access token was revoked");
    }
    const account = token.accountId
      ? (state.accounts.get(token.accountId) ?? null)
      : null;
    return { token, app, account };
  }

  /** The route of a request to the API, if it is one that is simulated. */
  function routeOf(
    instance: Instance,
    request: Request,
    { pathname: path, searchParams: query }: URL,
  ): Route | undefined {
    const { method } = request;
    if (method === "GET" && path === "/api/v2/instance") {
      return {
        operation: "instance",
        access: { who: "anybody" },
        run: () => showInstance(state, instance),
      };
    }
    if (method === "GET" && path === "/api/v1/accounts/verify_credentials") {
      return {
        operation: "account",
        access: {
          who: "account",
          scopes: [
            "read",
            "read:accounts",
            ...(atLeast(instance.version, 4, 3) ? ["profile"] : []),
          ],
        },
        run: (caller) =>
          caller?.account
            ? verifyCredentials(state, caller.account)
            : apiError(401, "The access token is invalid"),
      };
    }
    if (method === "POST" && path === "/api/v1/statuses") {
      return {
        operation: "publish",
        access: { who: "account", scopes: ["write", "write:statuses"] },
        throttles: [posted],
        run: (caller) =>
          caller?.account
            ? createStatus(state, instance, request, {
                ...caller,
                account: caller.account,
              })
            : apiError(401, "The access token is invalid"),
      };
    }
    if (path === "/api/v2/media" && method === "POST") {
      return {
        // Part of posting: what goes wrong with posting goes wrong here.
        operation: "publish",
        access: { who: "account", scopes: ["write", "write:media"] },
        throttles: [uploads],
        run: (caller) =>
          caller?.account
            ? uploadMedia(state, instance, request, {
                ...caller,
                account: caller.account,
              })
            : apiError(401, "The access token is invalid"),
      };
    }
    const mediaId = /^\/api\/v1\/media\/([0-9]+)$/.exec(path)?.[1];
    if (mediaId && method === "GET") {
      return {
        operation: "read",
        access: { who: "account", scopes: ["write", "write:media"] },
        run: (caller) =>
          caller?.account
            ? showMedia(state, instance, mediaId, {
                ...caller,
                account: caller.account,
              })
            : apiError(401, "The access token is invalid"),
      };
    }
    const authorId = /^\/api\/v1\/accounts\/([0-9]+)\/statuses$/.exec(
      path,
    )?.[1];
    if (authorId && method === "GET") {
      return {
        operation: "read",
        access: { who: "anybody-or-token", scopes: ["read", "read:statuses"] },
        run: (caller) => listStatuses(state, instance, authorId, query, caller),
      };
    }
    const sourceId = /^\/api\/v1\/statuses\/([0-9]+)\/source$/.exec(path)?.[1];
    if (sourceId && method === "GET") {
      return {
        operation: "read",
        access: { who: "token", scopes: ["read", "read:statuses"] },
        run: (caller) => showSource(state, instance, sourceId, caller),
      };
    }
    const id = /^\/api\/v1\/statuses\/([0-9]+)$/.exec(path)?.[1];
    if (id && method === "GET") {
      return {
        operation: "read",
        access: { who: "anybody-or-token", scopes: ["read", "read:statuses"] },
        run: (caller) => showStatus(state, instance, id, caller),
      };
    }
    if (id && method === "DELETE") {
      return {
        operation: "delete",
        access: { who: "account", scopes: ["write", "write:statuses"] },
        throttles: [deletions],
        run: (caller) =>
          caller?.account
            ? deleteStatus(state, instance, id, {
                ...caller,
                account: caller.account,
              })
            : apiError(401, "The access token is invalid"),
      };
    }
    return undefined;
  }

  /** Answers a request to the API: faults, limits, access, then the route. */
  async function api(
    instance: Instance,
    request: Request,
    route: Route,
  ): Promise<Response> {
    const bearer = /^Bearer (.+)$/i.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1];
    const fault = world.faults.take(
      "mastodon",
      route.operation,
      // A request without a token has none to lose.
      mastodonFaultKinds.filter(
        (kind) => kind !== "token-revoked" || bearer !== undefined,
      ),
    );
    if (fault === "server-error") {
      // What the proxy in front of a Mastodon that is down answers: a page.
      return html(
        503,
        "<!doctype html><title>Service unavailable</title><h1>We're sorry, but something went wrong on our end.</h1>",
      );
    }
    if (fault === "token-revoked" && bearer !== undefined) {
      world.revokeToken("mastodon", bearer);
    }

    const caller =
      route.access.who === "anybody" ? undefined : callerOf(instance, bearer);
    // The limits come before the access, as in Mastodon, where they are
    // kept in front of the application.
    const counts: Count[] = [];
    if (caller && !(caller instanceof Response)) {
      counts.push(count(`token/${caller.token.token}`, perToken));
    }
    if (fault === "rate-limit") {
      return tooManyRequests(counts[0] ?? count("anybody", perToken));
    }
    if (counts[0]?.exceeded) return tooManyRequests(counts[0]);

    if (caller instanceof Response) return caller;
    if (route.access.who !== "anybody") {
      const { scopes } = route.access;
      if (!caller && route.access.who !== "anybody-or-token") {
        return apiError(401, "The access token is invalid");
      }
      if (
        caller &&
        !scopes.some((scope) => caller.token.scopes.includes(scope))
      ) {
        return apiError(403, "This action is outside the authorized scopes");
      }
      if (caller && !caller.account && route.access.who === "account") {
        return apiError(422, "This method requires an authenticated user");
      }
    }
    // Counted per account, whatever the token. A request that goes on to
    // fail counts too, which Mastodon takes back. That is the one thing
    // this is stricter about.
    for (const throttle of route.throttles ?? []) {
      const counted = count(
        // Each limit counts by itself: posting and uploading are both
        // part of publishing, and have a limit each.
        throttle === uploads
          ? `upload/${caller?.account?.id}`
          : `${route.operation}/${caller?.account?.id}`,
        throttle,
      );
      if (counted.exceeded) return tooManyRequests(counted);
      counts.push(counted);
    }

    const response = await route.run(caller);
    if (fault === "lost-response") {
      // What `fetch` does when the connection breaks. The request was
      // carried out all the same.
      throw new TypeError(
        "The simulated Mastodon lost its answer on the way back",
      );
    }
    // The headers tell of the limit that is closest.
    const closest = counts.sort((a, b) => a.remaining - b.remaining)[0];
    if (closest) {
      for (const [name, value] of Object.entries(rateLimitHeaders(closest))) {
        response.headers.set(name, value);
      }
    }
    return response;
  }

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const instance =
        url.protocol === "https:" && url.port === ""
          ? state.instances.get(url.hostname)
          : undefined;
      if (!instance) {
        // What `fetch` does when a host cannot be reached.
        throw new TypeError(
          `The simulated Mastodon has no instance at ${url.origin}`,
        );
      }
      const { method } = request;
      const path = url.pathname;

      if (
        path === "/oauth/authorize" &&
        (method === "GET" || method === "POST")
      ) {
        return authorize(state, instance, request, url);
      }
      if (path === "/oauth/token" && method === "POST") {
        return tokenEndpoint(state, instance, request);
      }
      if (path === "/oauth/revoke" && method === "POST") {
        return revoke(state, instance, request);
      }
      if (
        path === "/.well-known/oauth-authorization-server" &&
        method === "GET"
      ) {
        return oauthMetadata(instance);
      }
      if (path === "/api/v1/apps" && method === "POST") {
        return createApp(state, instance, request);
      }
      const route = routeOf(instance, request, url);
      if (route) return api(instance, request, route);
      // GUESS: what Mastodon answers for an address it does not have.
      return path.startsWith("/api/")
        ? apiError(404, "Not Found")
        : html(404, "<!doctype html><title>Not found</title>");
    },

    // A host with a port is no domain of an instance, so it is not owned.
    owns: (host) => state.instances.get(host) !== undefined,

    addInstance(domain, options = {}) {
      if (!reservedDomain.test(domain)) {
        throw new Error(
          `A simulated instance needs a domain under .example, .test or .invalid, in lowercase: ${domain}`,
        );
      }
      state.instances.put(domain, {
        domain,
        title: "Simulated Mastodon",
        version: "4.5.0",
        maxCharacters: 500,
        charactersReservedPerUrl: 23,
        ...options,
      });
    },

    addAccount(domain, username, name = username, settings = {}) {
      if (!state.instances.get(domain)) {
        throw new Error(`The simulated Mastodon has no instance ${domain}`);
      }
      if (!/^[a-z0-9_]{1,30}$/i.test(username)) {
        throw new Error(`Not a username on Mastodon: ${username}`);
      }
      const taken = state.accounts
        .all()
        .some(
          (account) =>
            account.domain === domain &&
            account.username.toLowerCase() === username.toLowerCase(),
        );
      if (taken) throw new Error(`@${username}@${domain} exists already`);
      const account: MastodonAccount = {
        network: "mastodon",
        id: state.nextId(),
        domain,
        username,
        handle: `@${username}@${domain}`,
        name,
        ...settings,
      };
      state.accounts.put(account.id, account);
      return account;
    },

    arm({ kind, operation }) {
      // Checked here as well as by the types: the sandbox will pass on what
      // a person chose.
      if (!mastodonFaultKinds.includes(kind)) {
        throw new Error(`The simulated Mastodon has no fault "${kind}"`);
      }
      if (operation !== undefined && !mastodonOperations.includes(operation)) {
        throw new Error(`The simulated Mastodon has no request "${operation}"`);
      }
      world.faults.arm("mastodon", { kind, operation });
    },
  };
}
