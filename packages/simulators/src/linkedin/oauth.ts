import {
  consentPage,
  errorPage,
  isSimulatedSecret,
  simulatedSecret,
} from "../world/index.ts";
import { empty, formParams, html, json, oauthError } from "./http.ts";
import {
  accessTokenLifetimeMs,
  codeLifetimeMs,
  type LinkedInClient,
  type LinkedInToken,
  parseScopes,
  type State,
} from "./state.ts";

/**
 * LinkedIn's OAuth 2.0 for an application that acts for a member: the
 * "Authorization Code Flow (3-legged OAuth)" of
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow,
 * for a confidential client. There is no PKCE in it: LinkedIn has that for
 * native applications only, at other addresses.
 */

const service = "LinkedIn";

/**
 * `GET /oauth/v2/authorization` shows the page where a member signs in and
 * consents, `POST` takes their answer and sends the browser back to the
 * application.
 */
export async function authorize(
  state: State,
  request: Request,
  url: URL,
): Promise<Response> {
  const params = url.searchParams;
  const refuse = (status: number, description: string) =>
    html(status, errorPage(service, description));

  // What is wrong with the client or with the address to send the browser
  // back to ends on a page of LinkedIn: there is nowhere to send it.
  const client = state.clients.get(params.get("client_id") ?? "");
  if (!client) {
    return refuse(400, "The passed in client_id is invalid.");
  }
  const redirectUri = params.get("redirect_uri");
  // The whole address, as it was entered for the application: LinkedIn
  // compares nothing less, and an address that is only like one of them
  // could be anybody's.
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return refuse(400, "The redirect_uri does not match the registered value.");
  }
  // GUESS: a wrong `response_type` ends on a page too. LinkedIn documents
  // only that the value is `code`.
  if (params.get("response_type") !== "code") {
    return refuse(400, "The response_type must be code.");
  }
  const redirect = new URL(redirectUri);
  const callerState = params.get("state");
  const back = (query: Record<string, string>) => {
    for (const [name, value] of Object.entries(query)) {
      redirect.searchParams.set(name, value);
    }
    if (callerState !== null) redirect.searchParams.set("state", callerState);
    return new Response(null, {
      status: 302,
      headers: { Location: redirect.href },
    });
  };

  const scopes = parseScopes(params.get("scope") ?? "");
  // GUESS: a request without a scope is refused like one for a scope that
  // the application does not have. LinkedIn documents the parameter as
  // required since it stopped giving applications default scopes.
  const unauthorized =
    scopes.length === 0
      ? ""
      : scopes.find((scope) => !client.scopes.includes(scope));
  if (unauthorized !== undefined) {
    return back({
      error: "unauthorized_scope_error",
      error_description: `Scope "${unauthorized}" is not authorized for your application`,
    });
  }

  const members = state.members.all();
  if (request.method === "GET") {
    return html(
      200,
      consentPage({ service, client: client.name, scopes, accounts: members }),
    );
  }

  // The member has answered.
  const form = await request.formData();
  if (form.get("action") === "deny") {
    return back({
      error: "user_cancelled_authorize",
      error_description: "The user cancelled the authorization",
    });
  }
  const member = members.find(({ id }) => id === form.get("account"));
  if (!member) return refuse(400, "Choose one of the simulated members.");
  const now = state.world.now().getTime();
  // A code that was never exchanged goes when its time has passed.
  for (const [value, issued] of state.codes.entries()) {
    if (issued.expiresAt <= now) state.codes.delete(value);
  }
  const code = simulatedSecret();
  state.codes.put(code, {
    clientId: client.clientId,
    memberId: member.id,
    redirectUri,
    scopes,
    expiresAt: now + codeLifetimeMs,
  });
  return back({ code });
}

/**
 * The client that a request to an OAuth endpoint is made as, by the
 * `client_id` and `client_secret` in its form: a refusal if they are
 * missing or wrong.
 */
function clientOf(
  state: State,
  params: URLSearchParams,
): LinkedInClient | Response {
  for (const name of ["client_id", "client_secret"]) {
    if (!params.get(name)) {
      return oauthError(
        400,
        "invalid_request",
        `A required parameter "${name}" is missing`,
      );
    }
  }
  const client = state.clients.get(params.get("client_id") ?? "");
  const secret = params.get("client_secret") ?? "";
  // A secret that no simulation made is not compared with anything.
  if (!client || !isSimulatedSecret(secret) || client.clientSecret !== secret) {
    return oauthError(401, "invalid_client", "Client authentication failed");
  }
  return client;
}

const notAForm = () =>
  oauthError(
    400,
    "invalid_request",
    "The request must be application/x-www-form-urlencoded",
  );

/** `POST /oauth/v2/accessToken`: a code for an access token. */
export async function accessToken(
  state: State,
  request: Request,
): Promise<Response> {
  const params = await formParams(request);
  if (!params) return notAForm();
  const grantType = params.get("grant_type");
  if (!grantType) {
    return oauthError(
      400,
      "invalid_request",
      'A required parameter "grant_type" is missing',
    );
  }
  // An application gets refresh tokens, and tokens of its own, only where
  // LinkedIn has approved it for them. The applications of this world are
  // not: they have the products that anybody can add.
  if (grantType !== "authorization_code") {
    return oauthError(
      400,
      "unsupported_grant_type",
      `The simulated LinkedIn gives its applications no grant of the type "${grantType}"`,
    );
  }
  for (const name of ["code", "redirect_uri"]) {
    if (!params.get(name)) {
      return oauthError(
        400,
        "invalid_request",
        `A required parameter "${name}" is missing`,
      );
    }
  }
  const client = clientOf(state, params);
  if (client instanceof Response) return client;

  const code = params.get("code") ?? "";
  const grant = isSimulatedSecret(code) ? state.codes.get(code) : undefined;
  const now = state.world.now().getTime();
  if (!grant || grant.clientId !== client.clientId || grant.expiresAt <= now) {
    return oauthError(
      400,
      "invalid_request",
      "Unable to retrieve access token: authorization code not found",
    );
  }
  if (grant.redirectUri !== params.get("redirect_uri")) {
    return oauthError(
      400,
      "invalid_redirect_uri",
      "Unable to retrieve access token: appid/redirect uri/code verifier does not match authorization code. Or authorization code expired. Or external member binding exists",
    );
  }
  // A code is good for one token.
  state.codes.delete(code);
  // GUESS: every exchange makes a token of its own, and the ones that the
  // member gave the application before stay as they are.
  const token = state.world.issueToken<LinkedInToken>({
    network: "linkedin",
    accountId: grant.memberId,
    clientId: client.clientId,
    scopes: grant.scopes,
    createdAt: now,
    expiresAt: now + accessTokenLifetimeMs,
  });
  return json(200, {
    access_token: token.token,
    expires_in: accessTokenLifetimeMs / 1000,
    // GUESS: LinkedIn lists the scopes of a token with commas between
    // them, as its answers have been seen to. Its documentation shows no
    // token with more than one.
    scope: token.scopes.join(","),
    token_type: "Bearer",
  });
}

/**
 * `POST /oauth/v2/revoke`: takes a token back. GUESS, all of it: LinkedIn
 * documents the address and its three parameters, and that it answers 200.
 * That it ends this one token and no other of the member, that a token
 * which it does not know is no error, as RFC 7009 has it, and that a token
 * of another application is refused, are assumed.
 */
export async function revoke(
  state: State,
  request: Request,
): Promise<Response> {
  const params = await formParams(request);
  if (!params) return notAForm();
  const client = clientOf(state, params);
  if (client instanceof Response) return client;
  const value = params.get("token");
  if (!value) {
    return oauthError(
      400,
      "invalid_request",
      'A required parameter "token" is missing',
    );
  }
  const token = state.world.findToken<LinkedInToken>("linkedin", value);
  if (!token) return empty(200);
  if (token.clientId !== client.clientId) {
    return oauthError(
      400,
      "invalid_request",
      "The token was not issued to this application",
    );
  }
  state.world.revokeToken("linkedin", value);
  return empty(200);
}

/**
 * `POST /oauth/v2/introspectToken`: what LinkedIn knows of a token, from
 * "Token Introspection" of its documentation.
 */
export async function introspect(
  state: State,
  request: Request,
): Promise<Response> {
  const params = await formParams(request);
  if (!params) return notAForm();
  const client = clientOf(state, params);
  if (client instanceof Response) return client;
  const token = state.world.findToken<LinkedInToken>(
    "linkedin",
    params.get("token") ?? "",
  );
  // GUESS: a token that is not the application's is one that LinkedIn
  // says nothing about.
  if (!token || token.clientId !== client.clientId) {
    return json(200, { active: false });
  }
  const status = state.world.tokenStatus(token);
  return json(200, {
    active: status === "valid",
    client_id: token.clientId,
    authorized_at: Math.floor(token.createdAt / 1000),
    created_at: Math.floor(token.createdAt / 1000),
    status: status === "valid" ? "active" : status,
    expires_at: Math.floor((token.expiresAt ?? 0) / 1000),
    scope: token.scopes.join(","),
    auth_type: "3L",
  });
}
