import type { Fetch } from "@pigy/core";
import {
  type FaultKind,
  isSimulatedSecret,
  type SimWorld,
  simulatedSecret,
} from "../world/index.ts";
import {
  type Caller,
  createContainer,
  deletePost,
  lacking,
  noSuchObject,
  object,
  ownThreads,
  profile,
  publish,
  publishingLimit,
  replies,
} from "./api.ts";
import { graphError, html, parameters } from "./http.ts";
import {
  accessToken,
  authorize,
  exchange,
  refresh,
  refusedToken,
} from "./oauth.ts";
import {
  createState,
  nextId,
  type ThreadsApp,
  type ThreadsToken,
  type ThreadsUser,
} from "./state.ts";

export { slowProcessingMs } from "./api.ts";
export type { ThreadsApp, ThreadsUser } from "./state.ts";

/**
 * A simulation of Threads as an app meets it that posts text for an
 * account, written from Meta's documentation of the Threads API at
 * https://developers.facebook.com/docs/threads: "Get Access Tokens and
 * Permissions", "Long-Lived Access Tokens", "Posts", "Reply Management",
 * "Retrieve Threads Media Objects", "Delete Posts", "Rate Limiting" and
 * "Troubleshooting". It was written without access to those pages, from
 * what its author knew of them: what had to be assumed is marked GUESS,
 * for a run against the real Threads to confirm.
 *
 * It answers on Threads' own two hosts, so the adapter under test is the
 * adapter that runs against Threads. It enforces Threads' rules itself and
 * shares no code with the adapter or with pigy's own validation.
 *
 * It is part of the production build, because the sandbox runs on it. So
 * it acts on its world and on nothing else:
 *
 * - It makes no requests, and fails for every host but Threads' two.
 * - It accepts only the secrets that a simulation made, which say what
 *   they are: the secret of an app too.
 *
 * Not simulated: media, carousels, links with a preview of the app's
 * choosing, quotes, polls, topics, publishing in one step, the list of an
 * account's replies, insights, mentions, webhooks, an app in development
 * that only its testers can use, and the limits that Meta keeps per app.
 */

/** The faults that Threads can suffer from. */
export const threadsFaultKinds = [
  "rate-limit",
  "server-error",
  "lost-response",
  "token-revoked",
  "slow-processing",
] as const satisfies readonly FaultKind[];

/**
 * The requests that a fault can strike: exchanging a code for a token,
 * that token for one that lasts, renewing the latter, asking whose token
 * it is, making a container, publishing one, looking at a container or a
 * post, and deleting a post.
 */
export const threadsOperations = [
  "publish",
  "container",
  "read",
  "account",
  "token",
  "exchange",
  "refresh",
  "delete",
] as const;

type Operation = (typeof threadsOperations)[number];

export type ThreadsFault = {
  kind: (typeof threadsFaultKinds)[number];
  /** Any of them that the kind can strike, if left out. */
  operation?: Operation;
};

export type ThreadsSimulator = {
  /**
   * Stands in for `fetch`. Answers requests to Threads' hosts and fails
   * for every other host, so nothing leaves the process.
   */
  fetch: Fetch;
  /** Whether `host` is one of Threads' two, as `URL.host` has it. */
  owns(host: string): boolean;
  /**
   * Adds an app, as a developer makes one in Meta's dashboard, with the
   * permissions of the Threads use case. Its ID and secret are made here
   * unless they are given, and a secret that is given has to be a
   * simulated one.
   */
  addApp(
    app: Pick<ThreadsApp, "name"> & Partial<Omit<ThreadsApp, "name">>,
  ): ThreadsApp;
  /** Adds an account, for somebody to connect as. */
  addUser(user: { username: string; name: string }): ThreadsUser;
  /** Arms a fault, which strikes the next request it applies to. */
  arm(fault: ThreadsFault): void;
};

/** Where a person signs in and consents. */
export const threadsAuthorizationHost = "threads.net";
/** Where the API is, and where tokens are made. */
export const threadsApiHost = "graph.threads.net";

/** The path of the page where a person consents. */
export const threadsAuthorizationPath = "/oauth/authorize";

// What the Threads use case can give an app. Each is a permission that
// the developer adds, and that Meta reviews before anybody but a tester
// of the app can grant it.
const allScopes = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
  "threads_manage_insights",
];

type Route = {
  operation: Operation;
  /** The scopes that the token of the request needs, all of them. */
  scopes: string[];
  /** `slow` is a fault that a new container suffers from. */
  run(
    caller: Caller,
    params: URLSearchParams,
    slow: boolean,
  ): Response | Promise<Response>;
};

export function createThreadsSimulator(world: SimWorld): ThreadsSimulator {
  const state = createState(world);

  const unsupported = (method: string) =>
    graphError(world, {
      message: `Unsupported ${method.toLowerCase()} request.`,
      type: "THApiException",
      code: 100,
      subcode: 33,
    });

  /** The route of a request to the API, if it is one that is simulated. */
  function routeOf(method: string, path: string): Route | null {
    // `me` is the account of the token. Its own ID names it as well.
    const [first = "", second, ...rest] = path.split("/").filter(Boolean);
    if (rest.length > 0 || !/^(me|\d+)$/.test(first)) return null;
    // An address under an account is answered for the account of the
    // token and for no other.
    const own =
      (run: Route["run"]): Route["run"] =>
      (caller, params, slow) =>
        first === "me" || first === caller.user.id
          ? run(caller, params, slow)
          : noSuchObject(state, first);

    if (second === undefined) {
      if (method === "GET") {
        return {
          // Asking who the account is, is a request of its own kind.
          operation: first === "me" ? "account" : "read",
          scopes: ["threads_basic"],
          run: (caller, params) =>
            first === "me"
              ? profile(state, caller, params)
              : object(state, caller, first, params),
        };
      }
      if (method === "DELETE" && first !== "me") {
        return {
          operation: "delete",
          scopes: ["threads_basic", "threads_delete"],
          run: (caller) => deletePost(state, caller, first),
        };
      }
      return null;
    }
    if (second === "threads" && method === "POST") {
      return {
        operation: "container",
        scopes: ["threads_basic", "threads_content_publish"],
        run: own((caller, params, slow) =>
          createContainer(state, caller, params, slow),
        ),
      };
    }
    if (second === "threads" && method === "GET") {
      return {
        operation: "read",
        scopes: ["threads_basic"],
        run: own((caller, params) => ownThreads(state, caller, params)),
      };
    }
    if (second === "threads_publish" && method === "POST") {
      return {
        operation: "publish",
        scopes: ["threads_basic", "threads_content_publish"],
        run: own((caller, params) => publish(state, caller, params)),
      };
    }
    if (second === "threads_publishing_limit" && method === "GET") {
      return {
        operation: "read",
        scopes: ["threads_basic", "threads_content_publish"],
        run: own((caller, params) => publishingLimit(state, caller, params)),
      };
    }
    if (second === "replies" && method === "GET" && first !== "me") {
      return {
        operation: "read",
        scopes: ["threads_basic", "threads_read_replies"],
        run: (caller, params) => replies(state, caller, first, params),
      };
    }
    return null;
  }

  /**
   * The token that a request to the API comes with. Documented: in the
   * parameter `access_token`. GUESS: in the header `Authorization` too,
   * as the Graph API of Facebook takes it.
   */
  function bearerOf(request: Request, params: URLSearchParams) {
    return (
      params.get("access_token") ??
      /^Bearer (.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]
    );
  }

  /** Answers a request to the API: its token, then the route. */
  async function api(
    request: Request,
    params: URLSearchParams,
    route: Route,
    slow: boolean,
  ): Promise<Response> {
    const bearer = bearerOf(request, params);
    if (bearer === undefined) {
      return graphError(world, {
        message: "An access token is required to request this resource.",
        code: 104,
      });
    }
    const token = world.findToken<ThreadsToken>("threads", bearer);
    const refused = refusedToken(state, token);
    if (refused) return refused;
    const user = token?.accountId
      ? state.users.get(token.accountId)
      : undefined;
    if (!token || !user) {
      return refusedToken(state, undefined) as Response;
    }
    const caller: Caller = { user, token };
    return (
      lacking(state, caller, route.scopes) ?? route.run(caller, params, slow)
    );
  }

  /**
   * Answers a request as `answer` does, unless a fault strikes it.
   * `bearer` is the token of the request, which a fault that takes a
   * token back needs.
   */
  async function withFaults(
    operation: Operation,
    bearer: string | null | undefined,
    answer: (slow: boolean) => Response | Promise<Response>,
  ): Promise<Response> {
    const fault = world.faults.take(
      "threads",
      operation,
      threadsFaultKinds.filter(
        (kind) =>
          (kind !== "token-revoked" ||
            (typeof bearer === "string" && isSimulatedSecret(bearer))) &&
          // Only a container is prepared.
          (kind !== "slow-processing" || operation === "container"),
      ),
    );
    if (fault === "server-error") {
      return graphError(world, {
        status: 500,
        message:
          "An unexpected error has occurred. Please retry your request later.",
        code: 2,
        transient: true,
      });
    }
    if (fault === "rate-limit") {
      return graphError(world, {
        status: 403,
        message: "(#4) Application request limit reached",
        code: 4,
        transient: true,
      });
    }
    if (fault === "token-revoked" && typeof bearer === "string") {
      world.revokeToken("threads", bearer);
    }
    const response = await answer(fault === "slow-processing");
    if (fault === "lost-response") {
      // What `fetch` does when the connection breaks. The request was
      // carried out all the same.
      throw new TypeError(
        "The simulated Threads lost its answer on the way back",
      );
    }
    return response;
  }

  const owns = (host: string) =>
    host === threadsAuthorizationHost || host === threadsApiHost;

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.protocol !== "https:" || !owns(url.host)) {
        // What `fetch` does when a host cannot be reached.
        throw new TypeError(`The simulated Threads is not at ${url.origin}`);
      }
      const { method } = request;

      if (url.host === threadsAuthorizationHost) {
        if (
          url.pathname === threadsAuthorizationPath &&
          (method === "GET" || method === "POST")
        ) {
          return authorize(state, request, url);
        }
        return html(404, "<!doctype html><title>Page not found</title>");
      }

      // The three addresses where tokens are made have no version.
      if (url.pathname === "/oauth/access_token" && method === "POST") {
        return withFaults("token", null, () => accessToken(state, request));
      }
      if (url.pathname === "/access_token" && method === "GET") {
        return withFaults(
          "exchange",
          url.searchParams.get("access_token"),
          () => exchange(state, request),
        );
      }
      if (url.pathname === "/refresh_access_token" && method === "GET") {
        return withFaults("refresh", url.searchParams.get("access_token"), () =>
          refresh(state, request),
        );
      }

      // The API is asked with its version or without: `v1.0` is the one
      // that there is.
      const path = url.pathname.replace(/^\/v1\.0(?=\/)/, "");
      const params = await parameters(request);
      if (!params) {
        return graphError(world, {
          message:
            "The simulated Threads takes the parameters of a request in its address or as a form",
          type: "THApiException",
          code: 100,
        });
      }
      const bearer = bearerOf(request, params);
      const route = routeOf(method, path);
      if (route === null) return unsupported(method);
      return withFaults(route.operation, bearer, (slow) =>
        api(request, params, route, slow),
      );
    },

    owns,

    addApp({
      name,
      appId = nextId(world),
      appSecret = simulatedSecret(),
      redirectUris = [],
      scopes = allScopes,
    }) {
      if (!isSimulatedSecret(appSecret)) {
        throw new Error(
          "The secret of a simulated app has to be a simulated secret",
        );
      }
      if (state.apps.get(appId)) {
        throw new Error(`The app ${appId} exists already`);
      }
      const app: ThreadsApp = { appId, appSecret, name, redirectUris, scopes };
      state.apps.put(appId, app);
      return app;
    },

    addUser({ username, name }) {
      // Documented: letters, digits, periods and underscores, 30 at most.
      if (!/^[a-z0-9._]{1,30}$/.test(username)) {
        throw new Error(`"${username}" is no username of Threads`);
      }
      if (state.users.all().some((user) => user.username === username)) {
        throw new Error(`The account ${username} exists already`);
      }
      const user: ThreadsUser = {
        network: "threads",
        id: nextId(world),
        handle: `@${username}`,
        username,
        name,
      };
      state.users.put(user.id, user);
      return user;
    },

    arm({ kind, operation }) {
      // Checked here as well as by the types: the sandbox passes on what a
      // person chose.
      if (!threadsFaultKinds.includes(kind)) {
        throw new Error(`The simulated Threads has no fault "${kind}"`);
      }
      if (operation !== undefined && !threadsOperations.includes(operation)) {
        throw new Error(`The simulated Threads has no request "${operation}"`);
      }
      world.faults.arm("threads", { kind, operation });
    },
  };
}
