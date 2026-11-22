import {
  consentPage,
  errorPage,
  isSimulatedSecret,
  simulatedSecret,
} from "../world/index.ts";
import { graphError, html, json, oauthError, parameters } from "./http.ts";
import {
  codeLifetimeMs,
  longLifetimeMs,
  parseScopes,
  renewableAfterMs,
  type State,
  shortLifetimeMs,
  type ThreadsApp,
  type ThreadsToken,
} from "./state.ts";

/**
 * How an app comes by the access to an account of Threads, after "Get
 * Access Tokens and Permissions" and "Long-Lived Access Tokens" of
 * https://developers.facebook.com/docs/threads: a person consents at
 * threads.net, the app exchanges the code for a token that lasts an hour,
 * that one for a token that lasts 60 days, and renews the latter.
 */

const service = "Threads";

/**
 * `GET /oauth/authorize` shows the page where a person signs in and
 * consents, `POST` takes their answer and sends the browser back to the
 * app.
 */
export async function authorize(
  state: State,
  request: Request,
  url: URL,
): Promise<Response> {
  const params = url.searchParams;
  const refuse = (description: string) =>
    html(400, errorPage(service, description));

  // What is wrong with the request ends on a page of Threads. GUESS, for
  // all of these: Meta documents the parameters and not what a request
  // without them is answered with.
  const app = state.apps.get(params.get("client_id") ?? "");
  if (!app) return refuse("Invalid platform app.");
  const redirectUri = params.get("redirect_uri");
  // The address is compared as a whole with the ones that were entered.
  if (!redirectUri || !app.redirectUris.includes(redirectUri)) {
    return refuse(
      "The redirect_uri is not one of the redirect callback URLs of the app.",
    );
  }
  if (params.get("response_type") !== "code") {
    return refuse("The response_type must be code.");
  }
  const scopes = parseScopes(params.get("scope") ?? "");
  // Documented: every request for access has `threads_basic` in it.
  if (!scopes.includes("threads_basic")) {
    return refuse("The scope threads_basic is required.");
  }
  const unknown = scopes.find((scope) => !app.scopes.includes(scope));
  if (unknown !== undefined) {
    return refuse(`Invalid Scopes: ${unknown}.`);
  }

  const redirect = new URL(redirectUri);
  const callerState = params.get("state");
  const back = (query: Record<string, string>, fragment = "") => {
    for (const [name, value] of Object.entries(query)) {
      redirect.searchParams.set(name, value);
    }
    if (callerState !== null) redirect.searchParams.set("state", callerState);
    return new Response(null, {
      status: 302,
      headers: { Location: redirect.href + fragment },
    });
  };

  const users = state.users.all();
  if (request.method === "GET") {
    return html(
      200,
      consentPage({ service, client: app.name, scopes, accounts: users }),
    );
  }

  // The person has answered.
  const form = await request.formData();
  if (form.get("action") === "deny") {
    return back({
      error: "access_denied",
      error_reason: "user_denied",
      error_description: "The user denied your request",
    });
  }
  const user = users.find(({ id }) => id === form.get("account"));
  if (!user) return refuse("Choose one of the simulated accounts.");
  const now = state.world.now().getTime();
  // A code that was never exchanged goes when its time has passed.
  for (const [value, issued] of state.codes.entries()) {
    if (issued.expiresAt <= now) state.codes.delete(value);
  }
  const code = simulatedSecret();
  state.codes.put(code, {
    appId: app.appId,
    userId: user.id,
    redirectUri,
    scopes,
    expiresAt: now + codeLifetimeMs,
  });
  // Documented: Threads ends the address with `#_`, which is no part of
  // the code.
  return back({ code }, "#_");
}

/** Whether `secret` is the secret of `app`, and one that a simulation made. */
const isSecretOf = (app: ThreadsApp, secret: string | null) =>
  // A secret that no simulation made is not compared with anything.
  secret !== null && isSimulatedSecret(secret) && app.appSecret === secret;

/**
 * `POST /oauth/access_token`: a code for a short-lived token. GUESS: the
 * words of its refusals.
 */
export async function accessToken(
  state: State,
  request: Request,
): Promise<Response> {
  const params = await parameters(request);
  if (!params) {
    return oauthError("The request must be application/x-www-form-urlencoded");
  }
  for (const name of [
    "client_id",
    "client_secret",
    "grant_type",
    "redirect_uri",
    "code",
  ]) {
    if (!params.get(name)) {
      return oauthError(`Missing required parameter: ${name}`);
    }
  }
  if (params.get("grant_type") !== "authorization_code") {
    return oauthError("The grant_type must be authorization_code");
  }
  const app = state.apps.get(params.get("client_id") ?? "");
  if (!app || !isSecretOf(app, params.get("client_secret"))) {
    return oauthError("Invalid client secret");
  }
  const code = params.get("code") ?? "";
  const grant = isSimulatedSecret(code) ? state.codes.get(code) : undefined;
  const now = state.world.now().getTime();
  if (!grant || grant.appId !== app.appId || grant.expiresAt <= now) {
    return oauthError("This authorization code has expired or been used");
  }
  if (grant.redirectUri !== params.get("redirect_uri")) {
    return oauthError(
      "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request",
    );
  }
  // A code is good for one token.
  state.codes.delete(code);
  const token = state.world.issueToken<ThreadsToken>({
    network: "threads",
    accountId: grant.userId,
    clientId: app.appId,
    scopes: grant.scopes,
    kind: "short",
    createdAt: now,
    expiresAt: now + shortLifetimeMs,
  });
  return json(200, {
    access_token: token.token,
    // A number, as documented. The real ones can be larger than a
    // program reads a number exactly: an app does better to ask `/me`.
    user_id: Number(grant.userId),
  });
}

/** The token that a request names in `access_token`, if the world issued it. */
function tokenOf(state: State, params: URLSearchParams) {
  return state.world.findToken<ThreadsToken>(
    "threads",
    params.get("access_token") ?? "",
  );
}

/** What Threads says of a token that it does not take. */
export function refusedToken(
  state: State,
  token: ThreadsToken | undefined,
): Response | undefined {
  // GUESS: the subcodes, which are those of the Graph API of Facebook.
  if (!token) {
    return graphError(state.world, {
      message: "Invalid OAuth access token - Cannot parse access token",
      code: 190,
    });
  }
  const status = state.world.tokenStatus(token);
  if (status === "revoked") {
    return graphError(state.world, {
      message:
        "Error validating access token: The user has not authorized application.",
      code: 190,
      subcode: 458,
    });
  }
  if (status === "expired") {
    return graphError(state.world, {
      message: "Error validating access token: Session has expired.",
      code: 190,
      subcode: 463,
    });
  }
  return undefined;
}

const longLived = (token: ThreadsToken) =>
  json(200, {
    access_token: token.token,
    token_type: "bearer",
    expires_in: longLifetimeMs / 1000,
  });

/**
 * `GET /access_token` with `th_exchange_token`: a short-lived token for a
 * long-lived one, as the app that the token was issued to.
 */
export async function exchange(
  state: State,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const unsupported = (message: string) =>
    graphError(state.world, { message, code: 100 });
  if (params.get("grant_type") !== "th_exchange_token") {
    return unsupported("The grant_type must be th_exchange_token");
  }
  const token = tokenOf(state, params);
  const refused = refusedToken(state, token);
  if (refused || !token) return refused as Response;
  const app = state.apps.get(token.clientId);
  if (!app || !isSecretOf(app, params.get("client_secret"))) {
    return graphError(state.world, {
      message: "Error validating client secret.",
      code: 1,
    });
  }
  // GUESS: only a short-lived token is exchanged. Meta documents the
  // exchange for those and says nothing of one that is long-lived.
  if (token.kind !== "short") {
    return unsupported("The access token is not a short-lived token");
  }
  const now = state.world.now().getTime();
  // GUESS: the short-lived token stays good for what is left of its hour,
  // and every exchange makes a token of its own.
  return longLived(
    state.world.issueToken<ThreadsToken>({
      network: "threads",
      accountId: token.accountId,
      clientId: token.clientId,
      scopes: token.scopes,
      kind: "long",
      createdAt: now,
      expiresAt: now + longLifetimeMs,
    }),
  );
}

/**
 * `GET /refresh_access_token` with `th_refresh_token`: a long-lived token
 * for one that lasts 60 days from now. Documented: only a long-lived
 * token that is at least 24 hours old and has not expired is renewed.
 */
export async function refresh(
  state: State,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const unsupported = (message: string) =>
    graphError(state.world, { message, code: 100 });
  if (params.get("grant_type") !== "th_refresh_token") {
    return unsupported("The grant_type must be th_refresh_token");
  }
  const token = tokenOf(state, params);
  const refused = refusedToken(state, token);
  if (refused || !token) return refused as Response;
  // GUESS: the words of these two refusals.
  if (token.kind !== "long") {
    return unsupported("The access token is not a long-lived token");
  }
  const now = state.world.now().getTime();
  if (now - token.createdAt < renewableAfterMs) {
    return unsupported(
      "The access token is less than 24 hours old and cannot be refreshed yet",
    );
  }
  // GUESS: the answer is a token of its own, and the one that it was made
  // from stays good until its own end. Meta documents neither: the other
  // reading is that the same token comes back with a later end.
  return longLived(
    state.world.issueToken<ThreadsToken>({
      network: "threads",
      accountId: token.accountId,
      clientId: token.clientId,
      scopes: token.scopes,
      kind: "long",
      createdAt: now,
      expiresAt: now + longLifetimeMs,
    }),
  );
}
