import type { Fetch } from "@pigy/core";
import {
  type FaultKind,
  isSimulatedSecret,
  type SimWorld,
  simulatedSecret,
} from "../world/index.ts";
import { createPost, deletePost, userinfo } from "./api.ts";
import { apiError, html } from "./http.ts";
import { accessToken, authorize, introspect, revoke } from "./oauth.ts";
import {
  createState,
  type LinkedInClient,
  type LinkedInMember,
  type LinkedInToken,
} from "./state.ts";

export type { LinkedInClient, LinkedInMember } from "./state.ts";

/**
 * A simulation of LinkedIn as an application meets it that posts for a
 * member, written from LinkedIn's documentation at
 * https://learn.microsoft.com/en-us/linkedin: "Authorization Code Flow
 * (3-legged OAuth)", "Sign In with LinkedIn using OpenID Connect", "Posts
 * API", "Little Text Format", "API Rate Limiting" and "Error Handling". It
 * was written without access to those pages, from what its author knew of
 * them: what had to be assumed is marked GUESS, for a run against the real
 * LinkedIn to confirm.
 *
 * It answers on LinkedIn's own two hosts, so the adapter under test is the
 * adapter that runs against LinkedIn. It enforces LinkedIn's rules itself
 * and shares no code with the adapter or with pigy's own validation.
 *
 * It is part of the production build, because the sandbox runs on it. So
 * it acts on its world and on nothing else:
 *
 * - It makes no requests, and fails for every host but LinkedIn's two.
 * - It accepts only the secrets that a simulation made, which say what
 *   they are: the secret of an application too.
 *
 * Not simulated: organizations and their pages, media, articles, polls,
 * comments, mentions and hashtags, reading a post, which takes a
 * permission that LinkedIn gives few applications, refresh tokens, which
 * it gives few as well, the ID token of OpenID Connect, and the limits
 * that LinkedIn keeps per application.
 */

/** The faults that LinkedIn can suffer from. */
export const linkedInFaultKinds = [
  "rate-limit",
  "server-error",
  "lost-response",
  "token-revoked",
] as const satisfies readonly FaultKind[];

/**
 * The requests that a fault can strike: exchanging a code for a token,
 * asking whose token it is, posting, deleting a post, and giving a token
 * back.
 */
export const linkedInOperations = [
  "publish",
  "account",
  "token",
  "delete",
  "revoke",
] as const;

type Operation = (typeof linkedInOperations)[number];

export type LinkedInFault = {
  kind: (typeof linkedInFaultKinds)[number];
  /** Any of them, if left out. */
  operation?: Operation;
};

export type LinkedInSimulator = {
  /**
   * Stands in for `fetch`. Answers requests to LinkedIn's hosts and fails
   * for every other host, so nothing leaves the process.
   */
  fetch: Fetch;
  /** Whether `host` is one of LinkedIn's two, as `URL.host` has it. */
  owns(host: string): boolean;
  /**
   * Adds an application, as a developer makes one in LinkedIn's portal,
   * with the two products that anybody can add: signing in and sharing.
   * Its ID and secret are made here unless they are given, and a secret
   * that is given has to be a simulated one.
   */
  addClient(
    client: Pick<LinkedInClient, "name"> &
      Partial<Omit<LinkedInClient, "name">>,
  ): LinkedInClient;
  /** Adds a member, for somebody to connect as. */
  addMember(name: string): LinkedInMember;
  /** Arms a fault, which strikes the next request it applies to. */
  arm(fault: LinkedInFault): void;
};

/** Where a member signs in and consents, and where tokens are made. */
export const linkedInAuthorizationHost = "www.linkedin.com";
/** Where the API is. */
export const linkedInApiHost = "api.linkedin.com";

/** The path of the page where a member consents. */
export const linkedInAuthorizationPath = "/oauth/v2/authorization";

/**
 * The versions of its API that the simulated LinkedIn has, as the header
 * `LinkedIn-Version` names them: a year and a month. LinkedIn brings one
 * out most months and keeps each for a year at least. These are GUESSES:
 * which versions exist, only LinkedIn's documentation says.
 */
export const linkedInVersions = ["202609", "202610", "202611"];

// What the products "Sign In with LinkedIn using OpenID Connect" and
// "Share on LinkedIn" give an application.
const openScopes = ["openid", "profile", "email", "w_member_social"];

/**
 * How many posts a member may make through one application in a day.
 * GUESS: LinkedIn shows the limits of an application in its developer
 * portal and documents no number. This was the limit of the API that came
 * before the Posts API.
 */
const postsPerDay = 150;
const dayMs = 24 * 60 * 60 * 1000;

type Route = {
  operation: Operation;
  /** The scopes that the token of the request needs, all of them. */
  scopes: string[];
  /** Whether the route is of the versioned API under `/rest`. */
  versioned: boolean;
  /** How many of these a member may make in a day, where that is limited. */
  perDay?: number;
  run(member: LinkedInMember): Response | Promise<Response>;
};

export function createLinkedInSimulator(world: SimWorld): LinkedInSimulator {
  const state = createState(world);

  /**
   * What LinkedIn answers when it has been asked too often. Its limits are
   * per day, and a day begins at midnight UTC. It names no time to come
   * back at.
   */
  const tooManyRequests = (whose: "MEMBER" | "APPLICATION") =>
    apiError(
      429,
      `Resource level throttle ${whose} DAY limit for calls to this resource is reached.`,
      { serviceErrorCode: 101 },
    );

  /** The route of a request to the API, if it is one that is simulated. */
  function routeOf(request: Request, path: string): Route | Response | null {
    const { method } = request;
    if (method === "GET" && path === "/v2/userinfo") {
      return {
        operation: "account",
        scopes: ["openid", "profile"],
        versioned: false,
        run: userinfo,
      };
    }
    if (method === "POST" && path === "/rest/posts") {
      return {
        operation: "publish",
        scopes: ["w_member_social"],
        versioned: true,
        perDay: postsPerDay,
        run: (member) => createPost(state, request, member),
      };
    }
    const encoded = /^\/rest\/posts\/([^/]+)$/.exec(path)?.[1];
    if (encoded === undefined) return null;
    // An ID in an address is written with its colons encoded, as LinkedIn
    // documents for every URN in one.
    let id: string;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      id = "";
    }
    if (encoded.includes(":") || !/^urn:li:(share|ugcPost):\d+$/.test(id)) {
      return apiError(
        400,
        "The ID of a post in an address is its URN, URL-encoded",
      );
    }
    if (method === "DELETE") {
      return {
        operation: "delete",
        scopes: ["w_member_social"],
        versioned: true,
        run: (member) => deletePost(state, id, member),
      };
    }
    if (method === "GET") {
      // Reading takes `r_member_social`, which LinkedIn gives to few
      // applications, and to none of this world.
      return apiError(403, "Not enough permissions to access: GET /posts", {
        serviceErrorCode: 100,
        code: "ACCESS_DENIED",
      });
    }
    return null;
  }

  /** Answers a request to the API: its token, its headers, then the route. */
  async function api(request: Request, route: Route): Promise<Response> {
    // GUESS: the numbers and the words of these four refusals.
    const authorization = request.headers.get("Authorization");
    const bearer = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
    if (bearer === undefined) {
      return apiError(401, "Empty oauth2 access token", {
        serviceErrorCode: 65604,
      });
    }
    const token = world.findToken<LinkedInToken>("linkedin", bearer);
    const member = token?.accountId
      ? state.members.get(token.accountId)
      : undefined;
    if (!token || !member) {
      return apiError(401, "Invalid access token", { serviceErrorCode: 65600 });
    }
    const status = world.tokenStatus(token);
    if (status === "revoked") {
      return apiError(
        401,
        "The token used in the request has been revoked by the user",
        { serviceErrorCode: 65601 },
      );
    }
    if (status === "expired") {
      return apiError(401, "The token used in the request has expired", {
        serviceErrorCode: 65602,
      });
    }
    if (!route.scopes.every((scope) => token.scopes.includes(scope))) {
      return apiError(
        403,
        `Not enough permissions to access: ${request.method} ${new URL(request.url).pathname}`,
        { serviceErrorCode: 100, code: "ACCESS_DENIED" },
      );
    }
    if (route.versioned) {
      const version = request.headers.get("LinkedIn-Version");
      if (version === null) {
        return apiError(
          400,
          "A version must be present. Please specify a version by adding the LinkedIn-Version header.",
          { code: "VERSION_MISSING" },
        );
      }
      if (!/^\d{6}$/.test(version)) {
        return apiError(
          400,
          `The version ${version} is not a year and a month`,
          {
            code: "VERSION_MISSING",
          },
        );
      }
      if (!linkedInVersions.includes(version)) {
        return apiError(426, `Requested version ${version} is not active`, {
          code: "NONEXISTENT_VERSION",
        });
      }
      // GUESS: LinkedIn takes a request without this header in the first
      // version of its protocol, in which an ID is written otherwise. That
      // is not simulated, so the request is refused.
      if (request.headers.get("X-Restli-Protocol-Version") !== "2.0.0") {
        return apiError(
          400,
          "The simulated LinkedIn speaks version 2.0.0 of the Rest.li protocol: send X-Restli-Protocol-Version: 2.0.0",
        );
      }
    }
    if (route.perDay !== undefined) {
      const day = Math.floor(world.now().getTime() / dayMs);
      const key = `${route.operation}/${token.clientId}/${member.id}`;
      const counter = state.counters.get(key);
      const count = (counter?.day === day ? counter.count : 0) + 1;
      if (count > route.perDay) return tooManyRequests("MEMBER");
      state.counters.put(key, { day, count });
    }
    return route.run(member);
  }

  /**
   * Answers `request` as `answer` does, unless a fault strikes it. A fault
   * that takes a token back needs a request that has one.
   */
  async function withFaults(
    operation: Operation,
    request: Request,
    answer: () => Response | Promise<Response>,
  ): Promise<Response> {
    const bearer = /^Bearer (.+)$/i.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1];
    const fault = world.faults.take(
      "linkedin",
      operation,
      linkedInFaultKinds.filter(
        (kind) =>
          kind !== "token-revoked" ||
          (bearer !== undefined && isSimulatedSecret(bearer)),
      ),
    );
    if (fault === "server-error") {
      // GUESS: what LinkedIn answers when it fails.
      return apiError(500, "Internal Server Error");
    }
    if (fault === "rate-limit") return tooManyRequests("APPLICATION");
    if (fault === "token-revoked" && bearer !== undefined) {
      world.revokeToken("linkedin", bearer);
    }
    const response = await answer();
    if (fault === "lost-response") {
      // What `fetch` does when the connection breaks. The request was
      // carried out all the same.
      throw new TypeError(
        "The simulated LinkedIn lost its answer on the way back",
      );
    }
    return response;
  }

  const owns = (host: string) =>
    host === linkedInAuthorizationHost || host === linkedInApiHost;

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.protocol !== "https:" || !owns(url.host)) {
        // What `fetch` does when a host cannot be reached.
        throw new TypeError(`The simulated LinkedIn is not at ${url.origin}`);
      }
      const { method } = request;
      const path = url.pathname;
      const notFound = () => apiError(404, "Resource not found");

      if (url.host === linkedInAuthorizationHost) {
        if (
          path === linkedInAuthorizationPath &&
          (method === "GET" || method === "POST")
        ) {
          return authorize(state, request, url);
        }
        if (path === "/oauth/v2/accessToken" && method === "POST") {
          return withFaults("token", request, () =>
            accessToken(state, request),
          );
        }
        if (path === "/oauth/v2/revoke" && method === "POST") {
          return withFaults("revoke", request, () => revoke(state, request));
        }
        if (path === "/oauth/v2/introspectToken" && method === "POST") {
          return introspect(state, request);
        }
        return html(404, "<!doctype html><title>Page not found</title>");
      }

      const route = routeOf(request, path);
      if (route === null) return notFound();
      if (route instanceof Response) return route;
      return withFaults(route.operation, request, () => api(request, route));
    },

    owns,

    addClient({
      name,
      clientId = `sim${world.nextNumber().toString().padStart(11, "0")}`,
      clientSecret = simulatedSecret(),
      redirectUris = [],
      redirectPaths = [],
      scopes = openScopes,
    }) {
      if (!isSimulatedSecret(clientSecret)) {
        throw new Error(
          "The secret of a simulated application has to be a simulated secret",
        );
      }
      if (state.clients.get(clientId)) {
        throw new Error(`The application ${clientId} exists already`);
      }
      const client: LinkedInClient = {
        clientId,
        clientSecret,
        name,
        redirectUris,
        redirectPaths,
        scopes,
      };
      state.clients.put(clientId, client);
      return client;
    },

    addMember(name) {
      const [givenName = name, ...rest] = name.trim().split(/\s+/);
      const member: LinkedInMember = {
        network: "linkedin",
        // An ID in the form of LinkedIn's: a few letters and digits that
        // say nothing.
        id: simulatedSecret().slice(-10).replaceAll(/[-_]/g, "x"),
        // LinkedIn gives an application no other way to address a member.
        handle: name,
        name,
        givenName,
        familyName: rest.join(" "),
      };
      state.members.put(member.id, member);
      return member;
    },

    arm({ kind, operation }) {
      // Checked here as well as by the types: the sandbox passes on what a
      // person chose.
      if (!linkedInFaultKinds.includes(kind)) {
        throw new Error(`The simulated LinkedIn has no fault "${kind}"`);
      }
      if (operation !== undefined && !linkedInOperations.includes(operation)) {
        throw new Error(`The simulated LinkedIn has no request "${operation}"`);
      }
      world.faults.arm("linkedin", { kind, operation });
    },
  };
}
