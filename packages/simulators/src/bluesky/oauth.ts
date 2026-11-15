import { base64Url } from "../world/encoding.ts";
import {
  consentPage,
  errorPage,
  isSimulatedSecret,
  simulatedSecret,
} from "../world/index.ts";
import {
  bodyParams,
  dpopChallenge,
  gatewayError,
  html,
  json,
  lose,
  oauthError,
} from "./http.ts";
import {
  type ClientAuth,
  checkAssertion,
  checkProof,
  currentNonce,
  type Proof,
} from "./proofs.ts";
import { isNsid } from "./record.ts";
import {
  type BlueskyAccount,
  type BlueskyToken,
  type Client,
  forget,
  type Pds,
  type PushedRequest,
  revokeSession,
  type Session,
  type State,
} from "./state.ts";

/**
 * The authorization server of a simulated Bluesky: where a client asks for
 * the access to an account, a person consents, and the client gets tokens
 * and renews them. Written from the "OAuth" and "Permissions"
 * specifications of atproto, https://atproto.com/specs/oauth and
 * https://atproto.com/specs/permission, and from the RFCs that they name:
 * 9126 for pushed authorization requests, 7636 for PKCE, 9449 for DPoP,
 * 7523 for the assertion of a client, 9207 for `iss`, 8414 and 9728 for
 * the metadata, 7009 for revocation.
 *
 * Where those leave a question open, the code of the server that Bluesky
 * runs was read, packages/oauth/oauth-provider of
 * https://github.com/bluesky-social/atproto, and what was taken from it is
 * marked GUESS: it is how one server behaves, not what the specification
 * says.
 *
 * Not simulated, and refused: public clients, native clients, keys of a
 * client behind `jwks_uri`, permission sets (`include:`), request objects,
 * and every algorithm but ES256.
 */

export type BlueskySimulatorOptions = {
  /**
   * What the web has at the address of a client: the JSON of its metadata
   * document, or undefined if nothing is served there. A real
   * authorization server fetches the document from the client. A simulator
   * makes no requests, so whoever makes it says what it would find.
   */
  clients: (clientId: string) => unknown;
  /**
   * Takes a client that is reached at a local address without HTTPS, such
   * as `http://localhost:5173`, which a real server refuses: its client
   * has an HTTPS address without a port. This is for the sandbox of a pigy
   * that runs on somebody's machine. Left out, the rule of the
   * specification holds.
   */
  localClients?: boolean;
};

/**
 * How long an access token is good. The specification has less than 30
 * minutes.
 */
export const accessTokenLifetimeMs = 15 * 60 * 1000;

/**
 * How long a refresh token is good while nobody uses it. GUESS, from the
 * code of the reference server: three months for a confidential client.
 * The specification names 180 days as the most.
 */
export const refreshTokenLifetimeMs = 91 * 24 * 60 * 60 * 1000;

/**
 * How long a session lasts, however often it is refreshed. GUESS, from the
 * code of the reference server: two years for a confidential client. The
 * specification lets it be without end.
 */
export const sessionLifetimeMs = 2 * 365 * 24 * 60 * 60 * 1000;

// GUESS, from the code of the reference server: how long a pushed request
// waits for a person. RFC 9126 leaves it to the server.
const requestLifetimeMs = 5 * 60 * 1000;

// GUESS: how long a code waits to be exchanged. OAuth recommends ten
// minutes at most.
const codeLifetimeMs = 10 * 60 * 1000;

// How long a code challenge is remembered. The specification has a server
// refuse one that was used before, within a time such as a day.
const challengeMemoryMs = 24 * 60 * 60 * 1000;

const requestUriPrefix = "urn:ietf:params:oauth:request_uri:";

/** What a server says about its OAuth: RFC 8414, as atproto requires it. */
export function serverMetadata(issuer: string) {
  return {
    issuer,
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    require_request_uri_registration: true,
    scopes_supported: [
      "atproto",
      "transition:email",
      "transition:generic",
      "transition:chat.bsky",
    ],
    subject_types_supported: ["public"],
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    ui_locales_supported: ["en-US"],
    display_values_supported: ["page", "popup", "touch"],
    authorization_response_iss_parameter_supported: true,
    jwks_uri: `${issuer}/oauth/jwks`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    revocation_endpoint: `${issuer}/oauth/revoke`,
    pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
    require_pushed_authorization_requests: true,
    dpop_signing_alg_values_supported: ["ES256"],
    client_id_metadata_document_supported: true,
  };
}

/** What a PDS says about who authorizes its accounts: RFC 9728. */
export function resourceMetadata(pds: Pds) {
  return {
    resource: `https://${pds.host}`,
    authorization_servers: [pds.issuer],
    scopes_supported: [],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://atproto.com",
  };
}

/** Whether `url` is a local address without HTTPS: see `localClients`. */
function isLocalHttp(url: URL): boolean {
  const { hostname } = url;
  return (
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]")
  );
}

/** `value` as a URL, or undefined. */
function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * What is wrong with one scope, or undefined: the forms of the
 * "Permissions" specification that are simulated.
 */
function scopeProblem(scope: string): string | undefined {
  if (
    [
      "atproto",
      "transition:generic",
      "transition:chat.bsky",
      "transition:email",
    ].includes(scope)
  ) {
    return undefined;
  }
  const [, resource, positional, query] =
    /^([a-z]+)(?::([^?]*))?(?:\?(.*))?$/.exec(scope) ?? [];
  if (!resource) return `"${scope}" is not a scope`;
  const params = new URLSearchParams(query ?? "");
  switch (resource) {
    case "repo": {
      const collections = [
        ...(positional === undefined ? [] : [decodeURIComponent(positional)]),
        ...params.getAll("collection"),
      ];
      // The positional parameter cannot be named a second time.
      if (positional !== undefined && params.has("collection")) {
        return `"${scope}" names its collection twice`;
      }
      if (
        collections.length === 0 ||
        !collections.every((name) => name === "*" || isNsid(name))
      ) {
        return `"${scope}" names no collection`;
      }
      if (
        !params
          .getAll("action")
          .every((action) => ["create", "update", "delete"].includes(action))
      ) {
        return `"${scope}" names an action that a repository does not have`;
      }
      for (const name of params.keys()) {
        if (name !== "collection" && name !== "action") {
          return `"${scope}" has a parameter that "repo" does not have`;
        }
      }
      return undefined;
    }
    case "blob": {
      const accept = [
        ...(positional === undefined ? [] : [decodeURIComponent(positional)]),
        ...params.getAll("accept"),
      ];
      return accept.length > 0 &&
        accept.every((type) => /^[a-z*]+\/[a-z0-9.+*-]+$/i.test(type))
        ? undefined
        : `"${scope}" names no type of media`;
    }
    default:
      // rpc, account, identity and include.
      return `The simulated server does not know the scope "${scope}"`;
  }
}

/**
 * Whether the scopes of a session let its client do `action` to records
 * of `collection`, as "Permissions" has it.
 */
export function allowsRepo(
  scopes: readonly string[],
  collection: string,
  action: "create" | "update" | "delete",
): boolean {
  return scopes.some((scope) => {
    if (scope === "transition:generic") return true;
    const match = /^repo(?::([^?]*))?(?:\?(.*))?$/.exec(scope);
    if (!match) return false;
    const [, positional, query] = match;
    const params = new URLSearchParams(query ?? "");
    const collections = [
      ...(positional === undefined ? [] : [decodeURIComponent(positional)]),
      ...params.getAll("collection"),
    ];
    const actions = params.getAll("action");
    return (
      (collections.includes("*") || collections.includes(collection)) &&
      (actions.length === 0 || actions.includes(action))
    );
  });
}

/**
 * The client at `clientId`, as its metadata document describes it, or what
 * is wrong with it: the section "Clients" of the OAuth specification.
 */
async function readClient(
  options: BlueskySimulatorOptions,
  clientId: string | undefined,
): Promise<Client | string> {
  const address = parseUrl(clientId);
  if (!clientId || !address) return "client_id must be a URL";
  const local = options.localClients === true && isLocalHttp(address);
  if (!local && (address.protocol !== "https:" || address.port !== "")) {
    return "client_id must be an https:// URL without a port";
  }
  if (address.hash || address.username || address.password) {
    return "client_id must be a URL without credentials or a fragment";
  }

  const document = await options.clients(clientId);
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    return `Unable to obtain client metadata for "${clientId}"`;
  }
  const metadata = document as Record<string, unknown>;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : undefined;

  if (metadata.client_id !== clientId) {
    return "client_id in the metadata must be the address it was fetched from";
  }
  // "web" unless it says otherwise.
  if ((metadata.application_type ?? "web") !== "web") {
    return "Only web clients are simulated";
  }
  const grantTypes = strings(metadata.grant_types);
  if (!grantTypes?.includes("authorization_code")) {
    return 'grant_types must include "authorization_code"';
  }
  if (!strings(metadata.response_types)?.includes("code")) {
    return 'response_types must include "code"';
  }
  if (typeof metadata.scope !== "string") return "scope is required";
  const scopes = metadata.scope.split(" ").filter(Boolean);
  if (!scopes.includes("atproto")) return 'scope must include "atproto"';
  for (const scope of scopes) {
    const problem = scopeProblem(scope);
    if (problem) return problem;
  }
  const redirectUris = strings(metadata.redirect_uris);
  if (!redirectUris || redirectUris.length === 0) {
    return "redirect_uris must hold at least one address";
  }
  for (const uri of redirectUris) {
    const redirect = parseUrl(uri);
    if (
      !redirect ||
      redirect.hash ||
      !(
        redirect.protocol === "https:" ||
        (options.localClients === true && isLocalHttp(redirect))
      )
    ) {
      return "A web client's redirect_uris must be https:// URLs";
    }
  }
  if (metadata.dpop_bound_access_tokens !== true) {
    return "dpop_bound_access_tokens must be true";
  }
  if (metadata.token_endpoint_auth_method !== "private_key_jwt") {
    return 'Only confidential clients are simulated: token_endpoint_auth_method must be "private_key_jwt"';
  }
  if ((metadata.token_endpoint_auth_signing_alg ?? "ES256") !== "ES256") {
    return 'Only "ES256" is simulated as token_endpoint_auth_signing_alg';
  }
  if (metadata.jwks_uri !== undefined) {
    return metadata.jwks === undefined
      ? "The simulated server reads the keys of a client from jwks, not from jwks_uri"
      : "jwks and jwks_uri must not both be there";
  }
  const jwks = metadata.jwks as { keys?: unknown } | undefined;
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  if (keys.length === 0) {
    return "A confidential client must publish a key in jwks";
  }
  for (const key of keys) {
    if (
      key === null ||
      typeof key !== "object" ||
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      typeof key.kid !== "string" ||
      key.kid === "" ||
      typeof key.x !== "string" ||
      typeof key.y !== "string"
    ) {
      return "jwks must hold P-256 keys, each with a kid";
    }
    // A client that publishes its private key has given it away.
    if ("d" in key) return "jwks must hold public keys only";
  }
  const clientUri = parseUrl(metadata.client_uri);
  if (
    metadata.client_uri !== undefined &&
    clientUri?.hostname !== address.hostname
  ) {
    return "client_uri must have the hostname of client_id";
  }
  for (const name of ["logo_uri", "tos_uri", "policy_uri"]) {
    if (
      metadata[name] !== undefined &&
      parseUrl(metadata[name])?.protocol !== "https:"
    ) {
      return `${name} must be an https: URL`;
    }
  }
  return {
    id: clientId,
    name:
      typeof metadata.client_name === "string" ? metadata.client_name : null,
    redirectUris,
    scopes,
    keys: keys as Record<string, unknown>[],
    refreshes: grantTypes.includes("refresh_token"),
  };
}

/** The headers of every answer of an authorization server. */
const nonceHeader = (state: State, host: string) => ({
  "DPoP-Nonce": currentNonce(state, host),
});

/**
 * A request to an endpoint of an authorization server, checked as far as
 * all of them check it: the DPoP proof, the fault that strikes, the client
 * and its assertion. Returns the refusal if one of them fails.
 */
async function authenticated(
  state: State,
  options: BlueskySimulatorOptions,
  issuer: string,
  request: Request,
  operation: "authorize" | "token",
  refreshToken: (params: Record<string, string>) => string | undefined,
): Promise<
  | Response
  | {
      params: Record<string, string>;
      client: Client;
      auth: ClientAuth;
      proof: Proof;
      headers: Record<string, string>;
      lost: boolean;
    }
> {
  const { host } = new URL(issuer);
  const headers = nonceHeader(state, host);
  const params = await bodyParams(request);

  // The proof comes first: a client learns the nonce of a server by being
  // refused for the lack of it, and that refusal is no outcome of the
  // request.
  const proof = await checkProof(state, host, request);
  if (proof === null) {
    return oauthError(
      400,
      "invalid_dpop_proof",
      "DPoP proof required",
      headers,
    );
  }
  if ("error" in proof) {
    return proof.error === "use_dpop_nonce"
      ? oauthError(400, proof.error, proof.description, headers)
      : oauthError(401, proof.error, proof.description, {
          ...headers,
          "WWW-Authenticate": dpopChallenge(proof.error, proof.description),
        });
  }

  const presented = refreshToken(params);
  const fault = state.takeFault(
    operation,
    ["rate-limit", "server-error", "lost-response", "token-revoked"],
    presented !== undefined,
  );
  if (fault === "server-error") return gatewayError();
  if (fault === "rate-limit") {
    return json(
      429,
      { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
      { ...headers, "Retry-After": "60" },
    );
  }
  if (fault === "token-revoked" && presented !== undefined) {
    const token = state.world.findToken<BlueskyToken>("bluesky", presented);
    const session = token && state.sessions.get(token.sessionId);
    if (session) revokeSession(state, session);
  }

  const client = await readClient(options, params.client_id);
  if (typeof client === "string") {
    return oauthError(400, "invalid_client_metadata", client, headers);
  }
  const auth = await checkAssertion(state, issuer, client, params);
  if (typeof auth === "string") {
    return oauthError(400, "invalid_client", auth, headers);
  }
  if (auth.jkt === proof.jkt) {
    return oauthError(
      400,
      "invalid_request",
      "The DPoP proof must be signed with a different key than the client assertion",
      headers,
    );
  }
  return {
    params,
    client,
    auth,
    proof,
    headers,
    lost: fault === "lost-response",
  };
}

/** `POST /oauth/par`: takes an authorization request, RFC 9126. */
export async function pushRequest(
  state: State,
  options: BlueskySimulatorOptions,
  issuer: string,
  request: Request,
): Promise<Response> {
  const checked = await authenticated(
    state,
    options,
    issuer,
    request,
    "authorize",
    () => undefined,
  );
  if (checked instanceof Response) return checked;
  const { params, client, auth, proof, headers } = checked;
  const refuse = (error: string, description: string) =>
    oauthError(400, error, description, headers);

  if (params.response_type !== "code") {
    return refuse("invalid_request", 'response_type must be "code"');
  }
  if (!params.state) return refuse("invalid_request", "state is required");
  const challenge = params.code_challenge;
  if (!challenge) {
    return refuse("invalid_request", "code_challenge is required");
  }
  if (params.code_challenge_method !== "S256") {
    return refuse("invalid_request", 'code_challenge_method must be "S256"');
  }
  const now = state.world.now().getTime();
  if ((state.challenges.get(challenge) ?? 0) > now) {
    return refuse("invalid_request", "code_challenge was used before");
  }
  if (
    !params.redirect_uri ||
    !client.redirectUris.includes(params.redirect_uri)
  ) {
    return refuse(
      "invalid_request",
      "redirect_uri must be one of the client's redirect_uris",
    );
  }
  const scopes = (params.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes("atproto")) {
    return refuse("invalid_scope", 'scope must include "atproto"');
  }
  if (!scopes.every((scope) => client.scopes.includes(scope))) {
    return refuse(
      "invalid_scope",
      "scope must be among the scopes that the client declares",
    );
  }

  forget(state.challenges, (until) => until <= now);
  state.challenges.put(challenge, now + challengeMemoryMs);
  const pushed: PushedRequest = {
    id: `req-${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`,
    issuer,
    clientId: client.id,
    redirectUri: params.redirect_uri,
    scopes,
    state: params.state,
    codeChallenge: challenge,
    loginHint: params.login_hint ?? null,
    dpopJkt: proof.jkt,
    clientKid: auth.kid,
    clientJkt: auth.jkt,
    expiresAt: now + requestLifetimeMs,
  };
  forget(state.requests, ({ expiresAt }) => expiresAt <= now);
  state.requests.put(pushed.id, pushed);
  if (checked.lost) lose();
  return json(
    201,
    {
      request_uri: requestUriPrefix + pushed.id,
      expires_in: requestLifetimeMs / 1000,
    },
    headers,
  );
}

/** The accounts that the authorization server at `issuer` signs in. */
function accountsOf(state: State, issuer: string): BlueskyAccount[] {
  const hosts = new Set(
    state.servers
      .all()
      .filter((pds) => pds.issuer === issuer)
      .map(({ host }) => host),
  );
  return state.accounts.all().filter(({ pds }) => hosts.has(pds));
}

/**
 * `GET /oauth/authorize` shows the page where a person consents to a
 * request that was pushed, `POST` takes their answer and sends the browser
 * back to the client.
 *
 * A request that is wrong ends on a page of the server: there is no
 * address of the client that could be trusted to hear of it.
 */
export async function authorize(
  state: State,
  issuer: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const service = `Bluesky at ${new URL(issuer).host}`;
  const refuse = (status: number, description: string) =>
    html(status, errorPage(service, description));

  const requestUri = url.searchParams.get("request_uri");
  const id = requestUri?.startsWith(requestUriPrefix)
    ? requestUri.slice(requestUriPrefix.length)
    : undefined;
  const pushed = id ? state.requests.get(id) : undefined;
  if (
    !pushed ||
    pushed.issuer !== issuer ||
    pushed.clientId !== url.searchParams.get("client_id")
  ) {
    return refuse(400, "This authorization request is not known. Start again.");
  }
  if (pushed.expiresAt <= state.world.now().getTime()) {
    return refuse(400, "This authorization request has expired. Start again.");
  }

  // With a hint, only the account that it names can be signed in as: the
  // client would refuse any other in the end.
  const all = accountsOf(state, issuer);
  const hint = pushed.loginHint?.replace(/^@/, "").toLowerCase();
  const hinted = all.filter(
    (account) => account.id === pushed.loginHint || account.domain === hint,
  );
  const accounts = hinted.length > 0 ? hinted : all;

  if (request.method === "GET") {
    return html(
      200,
      consentPage({
        service,
        // The address of the client, not the name it gives itself: anybody
        // can call their client anything. The specification of atproto:
        // "The full client_id URL should be displayed by default", and the
        // name only for a client that the server has chosen to trust.
        client: pushed.clientId,
        scopes: pushed.scopes,
        accounts,
      }),
    );
  }

  // The person has answered. A request is good for one answer.
  const form = await request.formData();
  state.requests.delete(pushed.id);
  const redirect = new URL(pushed.redirectUri);
  redirect.searchParams.set("iss", issuer);
  redirect.searchParams.set("state", pushed.state);
  if (form.get("action") === "deny") {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set(
      "error_description",
      "The user rejected the request",
    );
  } else {
    const account = accounts.find(({ id }) => id === form.get("account"));
    if (!account) {
      state.requests.put(pushed.id, pushed);
      return refuse(400, "Choose one of the accounts of this server.");
    }
    const code = simulatedSecret();
    const now = state.world.now().getTime();
    forget(state.codes, ({ expiresAt }) => expiresAt <= now);
    state.codes.put(code, {
      code,
      request: pushed,
      did: account.id,
      expiresAt: now + codeLifetimeMs,
      sessionId: null,
    });
    redirect.searchParams.set("code", code);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href },
  });
}

/** Issues the tokens of `session`, new ones, and returns the answer. */
function issueTokens(
  state: State,
  session: Omit<Session, "accessToken" | "refreshToken" | "refreshedAt">,
  headers: Record<string, string>,
): { session: Session; response: Response } {
  const now = state.world.now().getTime();
  const fields = {
    network: "bluesky" as const,
    accountId: session.did,
    clientId: session.clientId,
    scopes: session.scopes,
    sessionId: session.id,
  };
  const access = state.world.issueToken<BlueskyToken>({
    ...fields,
    kind: "access",
    expiresAt: now + accessTokenLifetimeMs,
  });
  const refresh = state.world.issueToken<BlueskyToken>({
    ...fields,
    kind: "refresh",
    expiresAt: now + refreshTokenLifetimeMs,
  });
  const issued: Session = {
    ...session,
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshedAt: now,
  };
  state.sessions.put(issued.id, issued);
  return {
    session: issued,
    response: json(
      200,
      {
        access_token: access.token,
        token_type: "DPoP",
        refresh_token: refresh.token,
        scope: session.scopes.join(" "),
        expires_in: accessTokenLifetimeMs / 1000,
        // What atproto adds: whose tokens these are.
        sub: session.did,
      },
      headers,
    ),
  };
}

/** `POST /oauth/token`: a code for tokens, or new tokens for old. */
export async function token(
  state: State,
  options: BlueskySimulatorOptions,
  issuer: string,
  request: Request,
): Promise<Response> {
  const checked = await authenticated(
    state,
    options,
    issuer,
    request,
    "token",
    (params) =>
      params.grant_type === "refresh_token" ? params.refresh_token : undefined,
  );
  if (checked instanceof Response) return checked;
  const { params, client, auth, proof, headers } = checked;
  const invalidGrant = (description: string) =>
    oauthError(400, "invalid_grant", description, headers);
  const now = state.world.now().getTime();

  if (params.grant_type === "authorization_code") {
    const value = params.code;
    const grant =
      value && isSimulatedSecret(value) ? state.codes.get(value) : undefined;
    if (!value || !grant) return invalidGrant("Invalid code");
    // A code that comes a second time is a code that somebody else may
    // have used: the session that it was exchanged for is ended.
    if (grant.sessionId !== null) {
      const session = state.sessions.get(grant.sessionId);
      if (session) revokeSession(state, session);
      return invalidGrant("Code replayed");
    }
    const { request: pushed } = grant;
    if (grant.expiresAt <= now) return invalidGrant("Code expired");
    if (pushed.issuer !== issuer || pushed.clientId !== client.id) {
      return invalidGrant("Token was not issued to this client");
    }
    if (pushed.clientKid !== auth.kid || pushed.clientJkt !== auth.jkt) {
      return invalidGrant("The client authenticated with another key");
    }
    if (pushed.dpopJkt !== proof.jkt) {
      return invalidGrant("DPoP proof does not match the expected JKT");
    }
    if (params.redirect_uri !== pushed.redirectUri) {
      return invalidGrant("redirect_uri mismatch");
    }
    const verifier = params.code_verifier;
    if (!verifier) {
      return oauthError(
        400,
        "invalid_request",
        "code_verifier is required",
        headers,
      );
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    if (base64Url(digest) !== pushed.codeChallenge) {
      return invalidGrant("Invalid code_verifier");
    }
    // Another request may have used the code while this one waited for
    // the digest. It is looked up once more, and nothing is awaited
    // between that and using it up.
    if (state.codes.get(value)?.sessionId !== null) {
      return invalidGrant("Code replayed");
    }
    const { session, response } = issueTokens(
      state,
      {
        id: `ses-${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`,
        issuer,
        did: grant.did,
        clientId: client.id,
        clientKid: auth.kid,
        clientJkt: auth.jkt,
        dpopJkt: proof.jkt,
        scopes: pushed.scopes,
        createdAt: now,
        revoked: false,
      },
      headers,
    );
    state.codes.put(value, { ...grant, sessionId: session.id });
    if (checked.lost) lose();
    return response;
  }

  if (params.grant_type === "refresh_token") {
    if (!client.refreshes) {
      return oauthError(
        400,
        "unauthorized_client",
        'The client does not declare the grant type "refresh_token"',
        headers,
      );
    }
    const value = params.refresh_token;
    const found = value
      ? state.world.findToken<BlueskyToken>("bluesky", value)
      : undefined;
    const session = found && state.sessions.get(found.sessionId);
    if (found?.kind !== "refresh" || !session || session.revoked) {
      return invalidGrant("Invalid refresh token");
    }
    // A refresh token is good once. One that comes again was copied, or
    // its answer was lost: nobody can tell, so the session ends. GUESS:
    // the specification has refresh tokens used once, and a server end
    // the session of a code that comes again. That it does the same for a
    // refresh token, with no grace for an answer that was lost, is from
    // the code of the reference server.
    if (session.refreshToken !== found.token) {
      revokeSession(state, session);
      return invalidGrant("Refresh token replayed");
    }
    if (session.issuer !== issuer || session.clientId !== client.id) {
      return invalidGrant("Token was not issued to this client");
    }
    // A session belongs to the key that the client began it with. The
    // client publishes that key for as long as the session is to last:
    // `checkAssertion` has found it among the published ones.
    if (session.clientKid !== auth.kid || session.clientJkt !== auth.jkt) {
      return invalidGrant(
        "The session was begun with another key of the client",
      );
    }
    if (session.dpopJkt !== proof.jkt) {
      return invalidGrant("DPoP proof does not match the expected JKT");
    }
    if (
      state.world.tokenStatus(found) !== "valid" ||
      now - session.createdAt >= sessionLifetimeMs
    ) {
      revokeSession(state, session);
      return invalidGrant("Session expired");
    }
    state.world.revokeToken("bluesky", session.accessToken);
    state.world.revokeToken("bluesky", session.refreshToken);
    const { response } = issueTokens(state, session, headers);
    if (checked.lost) lose();
    return response;
  }

  return oauthError(
    400,
    "unsupported_grant_type",
    'grant_type must be "authorization_code" or "refresh_token"',
    headers,
  );
}

/**
 * `POST /oauth/revoke`: ends the session of a token, RFC 7009.
 *
 * GUESS, from the code of the reference server, where the specification of
 * atproto says nothing of revocation. A server publishes the endpoint in
 * its metadata. It takes the token of a session only from the client of
 * that session, which proves to be that by its assertion and by a DPoP
 * proof of the key of the session. And it answers a request that fails one
 * of those checks like one that succeeded, as RFC 7009 has it for a token
 * that is not known: with 200 and nothing revoked.
 */
export async function revoke(
  state: State,
  options: BlueskySimulatorOptions,
  issuer: string,
  request: Request,
): Promise<Response> {
  const { host } = new URL(issuer);
  const headers = nonceHeader(state, host);
  const params = await bodyParams(request);
  if (!params.client_id) {
    return oauthError(
      400,
      "invalid_request",
      "Client credentials missing",
      headers,
    );
  }
  if (!params.token) {
    return oauthError(
      400,
      "invalid_request",
      "Invalid request payload",
      headers,
    );
  }
  // The one refusal that is told: a proof without the nonce of the server,
  // which the client is to send again.
  const proof = await checkProof(state, host, request);
  if (proof !== null && "error" in proof) {
    return proof.error === "use_dpop_nonce"
      ? oauthError(400, proof.error, proof.description, headers)
      : oauthError(401, proof.error, proof.description, headers);
  }

  const fault = state.takeFault(
    "revoke",
    ["rate-limit", "server-error", "lost-response"],
    false,
  );
  if (fault === "server-error") return gatewayError();
  if (fault === "rate-limit") {
    return json(
      429,
      { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
      { ...headers, "Retry-After": "60" },
    );
  }

  const done = json(200, {}, headers);
  const client = await readClient(options, params.client_id);
  const auth =
    typeof client === "string"
      ? undefined
      : await checkAssertion(state, issuer, client, params);
  const found = state.world.findToken<BlueskyToken>("bluesky", params.token);
  const session = found && state.sessions.get(found.sessionId);
  if (
    proof !== null &&
    typeof client !== "string" &&
    auth !== undefined &&
    typeof auth !== "string" &&
    session &&
    session.issuer === issuer &&
    session.clientId === client.id &&
    session.clientKid === auth.kid &&
    session.clientJkt === auth.jkt &&
    session.dpopJkt === proof.jkt
  ) {
    revokeSession(state, session);
  }
  if (fault === "lost-response") lose();
  return done;
}

/** Who makes a request to a PDS, by its access token. */
export type Caller = { account: BlueskyAccount; session: Session };

/**
 * Who makes `request` to the PDS at `host`: the account and the session of
 * its access token, or the refusal. A request for an account is made with
 * `Authorization: DPoP <token>` and a proof of the key of the session.
 *
 * `strike` is called once the proof has held up, with the token: it is
 * where a fault that is about the token takes effect, before the token is
 * looked at.
 */
export async function authenticate(
  state: State,
  host: string,
  request: Request,
  strike: (token: string) => Response | undefined,
): Promise<Caller | Response> {
  const headers = nonceHeader(state, host);
  const refuse = (error: string, description: string) =>
    json(
      401,
      // The errors of OAuth, in the form of the HTTP API. GUESS: the body
      // of such a refusal is not documented. The reference server says
      // the error in `WWW-Authenticate` as well, as RFC 9449 has it.
      { error, message: description },
      {
        ...headers,
        "WWW-Authenticate": dpopChallenge(error, description),
      },
    );
  const [scheme, value, ...rest] = (
    request.headers.get("Authorization") ?? ""
  ).split(" ");
  if (!scheme || !value || rest.length > 0) {
    return json(
      401,
      { error: "AuthenticationRequired", message: "Authentication Required" },
      headers,
    );
  }
  // A token that is bound to a key is not taken as a bearer token.
  if (scheme.toLowerCase() !== "dpop") {
    return refuse("invalid_token", "Invalid token type");
  }
  const proof = await checkProof(state, host, request, value);
  if (proof === null)
    return refuse("invalid_dpop_proof", "DPoP proof required");
  if ("error" in proof) {
    return refuse(
      proof.error,
      proof.error === "use_dpop_nonce"
        ? "Resource server requires nonce in DPoP proof"
        : proof.description,
    );
  }

  const struck = strike(value);
  if (struck) return struck;

  const found = state.world.findToken<BlueskyToken>("bluesky", value);
  const session = found && state.sessions.get(found.sessionId);
  const account = session && state.accounts.get(session.did);
  if (found?.kind !== "access" || !session || !account) {
    return refuse("invalid_token", "Invalid token");
  }
  // A token is good at the server that keeps its account, and nowhere
  // else.
  if (account.pds !== host) return refuse("invalid_token", "Invalid audience");
  const status = state.world.tokenStatus(found);
  if (status === "expired") return refuse("invalid_token", "Token expired");
  if (status !== "valid" || session.revoked) {
    return refuse("invalid_token", "Invalid token");
  }
  if (session.dpopJkt !== proof.jkt) {
    return refuse("invalid_token", "DPoP proof does not match the token");
  }
  return { account, session };
}
