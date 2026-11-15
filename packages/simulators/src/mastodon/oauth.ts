import {
  consentPage,
  errorPage,
  isSimulatedSecret,
  simulatedSecret,
} from "../world/index.ts";
import {
  bodyParams,
  html,
  json,
  oauthError,
  type Params,
  text,
} from "./http.ts";
import {
  type App,
  atLeast,
  type Instance,
  knownScopes,
  type MastodonToken,
  type State,
} from "./state.ts";

/**
 * How a client becomes known to an instance and gets a token: methods/apps
 * and methods/oauth of Mastodon's documentation. Mastodon leaves OAuth to
 * the Doorkeeper library, so the messages are Doorkeeper's, as Mastodon
 * ships them in config/locales/doorkeeper.en.yml.
 */

// Doorkeeper's messages.
const messages = {
  invalidClient:
    "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
  invalidGrant:
    "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
  invalidRedirectUri: "The redirect uri included is not valid.",
  invalidScope: "The requested scope is invalid, unknown, or malformed.",
  unsupportedGrantType:
    "The authorization grant type is not supported by the authorization server.",
  unsupportedResponseType:
    "The authorization server does not support this response type.",
  accessDenied:
    "The resource owner or authorization server denied the request.",
  missing: (parameter: string) => `Missing required parameter: ${parameter}.`,
};

// The address that asks for the code to be shown instead of sent.
const outOfBand = "urn:ietf:wg:oauth:2.0:oob";

// GUESS: Doorkeeper's default, which Mastodon does not change.
const codeLifetimeMs = 10 * 60 * 1000;

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The client with this ID on this instance, or undefined. */
function findApp(
  state: State,
  instance: Instance,
  clientId: string | null | undefined,
): App | undefined {
  if (!clientId || !isSimulatedSecret(clientId)) return undefined;
  const app = state.apps.get(clientId);
  return app?.domain === instance.domain ? app : undefined;
}

/**
 * The client that a request to a token endpoint comes from, if it proves
 * to be one: by its ID and secret, in the body or in an `Authorization`
 * header.
 */
function authenticatedApp(
  state: State,
  instance: Instance,
  request: Request,
  params: Params,
): App | undefined {
  let id = text(params, "client_id");
  let secret = text(params, "client_secret");
  const [scheme, encoded] =
    request.headers.get("Authorization")?.split(" ") ?? [];
  if (scheme?.toLowerCase() === "basic" && encoded) {
    try {
      [id, secret] = atob(encoded)
        .split(":")
        .map((part) => decodeURIComponent(part.replaceAll("+", " ")));
    } catch {
      return undefined;
    }
  }
  const app = findApp(state, instance, id);
  return app && app.clientSecret === secret ? app : undefined;
}

/** `POST /api/v1/apps`: registers a client. */
export async function createApp(
  state: State,
  instance: Instance,
  request: Request,
): Promise<Response> {
  const params = await bodyParams(request);
  const errors: string[] = [];

  const name = text(params, "client_name");
  if (!name) errors.push("Name can't be blank");
  else if (name.length > 60) {
    errors.push("Name is too long (maximum is 60 characters)");
  }

  // Several addresses come as a list, which is only understood from 4.3
  // on, or as one text with whitespace between them.
  const given = params.redirect_uris;
  let redirectUris: string[] = [];
  if (typeof given === "string") {
    redirectUris = given.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(given) && atLeast(instance.version, 4, 3)) {
    redirectUris = given.filter((uri) => typeof uri === "string");
  }
  if (redirectUris.length === 0) errors.push("Redirect URI can't be blank");
  for (const uri of redirectUris) {
    if (uri === outOfBand) continue;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      errors.push("Redirect URI must be an absolute URI.");
      continue;
    }
    if (parsed.hash || uri.includes("#")) {
      errors.push("Redirect URI cannot contain a fragment.");
    }
    if (["data:", "vbscript:", "javascript:"].includes(parsed.protocol)) {
      errors.push("Redirect URI is forbidden by the server.");
    }
  }

  const scopes = (text(params, "scopes") ?? "read")
    .split(/\s+/)
    .filter(Boolean);
  const known = knownScopes(instance);
  if (!scopes.every((scope) => known.includes(scope))) {
    errors.push("Scopes doesn't match configured on the server.");
  }

  const website = text(params, "website") ?? null;
  if (website !== null && !/^https?:\/\/[^\s/]+/i.test(website)) {
    errors.push("Website is not a valid URL");
  }

  if (!name || errors.length > 0) {
    return json(422, { error: `Validation failed: ${errors.join(", ")}` });
  }

  const app: App = {
    id: state.nextId(),
    domain: instance.domain,
    clientId: simulatedSecret(),
    clientSecret: simulatedSecret(),
    name,
    website,
    redirectUris,
    scopes,
  };
  state.apps.put(app.clientId, app);
  return json(200, {
    id: app.id,
    name: app.name,
    website: app.website,
    scopes: app.scopes,
    redirect_uri: app.redirectUris.join("\n"),
    redirect_uris: app.redirectUris,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    client_secret_expires_at: 0,
  });
}

/**
 * `GET /oauth/authorize` shows the page where a person consents, `POST`
 * takes their answer and sends the browser back to the client.
 *
 * A request that is wrong ends on a page of the instance. GUESS: Doorkeeper
 * can also report some of these to the client by redirect, and Mastodon
 * leaves that setting at its default, which is the page.
 */
export async function authorize(
  state: State,
  instance: Instance,
  request: Request,
  url: URL,
): Promise<Response> {
  const params = url.searchParams;
  const service = `Mastodon at ${instance.domain}`;
  const refuse = (status: number, description: string) =>
    html(status, errorPage(service, description));

  const app = findApp(state, instance, params.get("client_id"));
  if (!app) return refuse(401, messages.invalidClient);
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !app.redirectUris.includes(redirectUri)) {
    return refuse(400, messages.invalidRedirectUri);
  }
  if (redirectUri === outOfBand) {
    return refuse(
      400,
      "The simulated Mastodon does not show a code to copy. Register a redirect address.",
    );
  }
  if (params.get("response_type") !== "code") {
    return refuse(400, messages.unsupportedResponseType);
  }
  // Without a scope, the default one is asked for.
  const scopes = (params.get("scope") ?? "read").split(" ").filter(Boolean);
  if (
    scopes.length === 0 ||
    !scopes.every((scope) => app.scopes.includes(scope))
  ) {
    return refuse(400, messages.invalidScope);
  }
  // Before 4.3 the parameters of PKCE are ignored.
  const challenge = atLeast(instance.version, 4, 3)
    ? params.get("code_challenge")
    : null;
  if (challenge !== null && params.get("code_challenge_method") !== "S256") {
    return refuse(400, "The code_challenge_method must be S256.");
  }

  const accounts = state.accounts
    .all()
    .filter((account) => account.domain === instance.domain);
  if (request.method === "GET") {
    return html(
      200,
      consentPage({ service, client: app.name, scopes, accounts }),
    );
  }

  // The person has answered.
  const form = await request.formData();
  const redirect = new URL(redirectUri);
  const callerState = params.get("state");
  if (form.get("action") === "deny") {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", messages.accessDenied);
  } else {
    const account = accounts.find(({ id }) => id === form.get("account"));
    if (!account) {
      return refuse(400, "Choose one of the accounts of this instance.");
    }
    const code = simulatedSecret();
    state.codes.put(code, {
      code,
      clientId: app.clientId,
      accountId: account.id,
      redirectUri,
      scopes,
      codeChallenge: challenge,
      expiresAt: state.world.now().getTime() + codeLifetimeMs,
    });
    redirect.searchParams.set("code", code);
  }
  if (callerState !== null) redirect.searchParams.set("state", callerState);
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href },
  });
}

/**
 * The token of a client for an account and a set of scopes. Mastodon gives
 * out the one that exists before it makes another.
 */
function tokenFor(
  state: State,
  app: App,
  accountId: string | null,
  scopes: string[],
): MastodonToken {
  const existing = state.world
    .tokens<MastodonToken>("mastodon")
    .find(
      (token) =>
        token.clientId === app.clientId &&
        token.accountId === accountId &&
        token.scopes.length === scopes.length &&
        scopes.every((scope) => token.scopes.includes(scope)) &&
        state.world.tokenStatus(token) === "valid",
    );
  return (
    existing ??
    state.world.issueToken<MastodonToken>({
      network: "mastodon",
      domain: app.domain,
      accountId,
      clientId: app.clientId,
      scopes,
      createdAt: state.world.now().getTime(),
    })
  );
}

function tokenResponse(token: MastodonToken): Response {
  return json(200, {
    access_token: token.token,
    token_type: "Bearer",
    scope: token.scopes.join(" "),
    created_at: Math.floor(token.createdAt / 1000),
  });
}

/** `POST /oauth/token`: a code, or a client's own word, for a token. */
export async function token(
  state: State,
  instance: Instance,
  request: Request,
): Promise<Response> {
  const params = await bodyParams(request);
  const app = authenticatedApp(state, instance, request, params);
  const grantType = text(params, "grant_type");

  if (grantType === "client_credentials") {
    if (!app) return oauthError(401, "invalid_client", messages.invalidClient);
    // GUESS, from the documentation: without a scope the token is asked
    // for "read", and that fails for a client that did not register it.
    const scopes = (text(params, "scope") ?? "read").split(" ").filter(Boolean);
    if (!scopes.every((scope) => app.scopes.includes(scope))) {
      return oauthError(400, "invalid_scope", messages.invalidScope);
    }
    return tokenResponse(tokenFor(state, app, null, scopes));
  }
  if (grantType !== "authorization_code") {
    return grantType === undefined
      ? oauthError(400, "invalid_request", messages.missing("grant_type"))
      : oauthError(
          400,
          "unsupported_grant_type",
          messages.unsupportedGrantType,
        );
  }

  // The order of these checks is Doorkeeper's: what is missing, the
  // client, the code, the redirect address, the verifier.
  const code = text(params, "code");
  const grant =
    code && isSimulatedSecret(code) ? state.codes.get(code) : undefined;
  const pkce = atLeast(instance.version, 4, 3);
  const verifier = text(params, "code_verifier");
  const redirectUri = text(params, "redirect_uri");
  if (pkce && grant?.codeChallenge && !verifier) {
    return oauthError(
      400,
      "invalid_request",
      messages.missing("code_verifier"),
    );
  }
  if (!redirectUri) {
    return oauthError(400, "invalid_request", messages.missing("redirect_uri"));
  }
  if (!app) return oauthError(401, "invalid_client", messages.invalidClient);
  const invalidGrant = oauthError(400, "invalid_grant", messages.invalidGrant);
  if (
    !code ||
    !grant ||
    grant.clientId !== app.clientId ||
    grant.expiresAt <= state.world.now().getTime() ||
    grant.redirectUri !== redirectUri
  ) {
    return invalidGrant;
  }
  // A verifier for a code that was asked for without a challenge is as
  // wrong as one that does not fit.
  if (pkce && verifier) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    if (base64Url(digest) !== grant.codeChallenge) return invalidGrant;
  }

  // A code is good for one token. It is used up only now, when nothing can
  // refuse the request any more. Another request may have used it up while
  // this one waited for the digest, so it is looked up once more, and
  // nothing is awaited between that and using it up: of two requests with
  // the same code, only one gets past here.
  if (!state.codes.get(code)) return invalidGrant;
  state.codes.delete(code);
  return tokenResponse(tokenFor(state, app, grant.accountId, grant.scopes));
}

/** `POST /oauth/revoke`: takes a token back. */
export async function revoke(
  state: State,
  instance: Instance,
  request: Request,
): Promise<Response> {
  const params = await bodyParams(request);
  const app = authenticatedApp(state, instance, request, params);
  const value = text(params, "token");
  const forbidden = oauthError(
    403,
    "unauthorized_client",
    "You are not authorized to revoke this token",
  );
  // The documentation has a request without a token refused.
  if (!value) return forbidden;
  const found = state.world.findToken<MastodonToken>("mastodon", value);
  // GUESS, from RFC 7009, which Mastodon names: a token that the instance
  // does not know is not an error, so that revoking twice is fine.
  if (!found || found.domain !== instance.domain) return json(200, {});
  if (!app || found.clientId !== app.clientId) return forbidden;
  state.world.revokeToken("mastodon", value);
  return json(200, {});
}

/**
 * `GET /.well-known/oauth-authorization-server`: what the instance says
 * about its OAuth, from 4.3 on.
 */
export function oauthMetadata(instance: Instance): Response {
  if (!atLeast(instance.version, 4, 3)) {
    return html(404, "<!doctype html><title>Not found</title>");
  }
  const origin = `https://${instance.domain}`;
  return json(200, {
    issuer: `${origin}/`,
    service_documentation: "https://docs.joinmastodon.org/",
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    app_registration_endpoint: `${origin}/api/v1/apps`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    scopes_supported: knownScopes(instance),
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
  });
}
