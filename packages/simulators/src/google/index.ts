import { type Clock, type Fetch, normalizeEmail } from "@pigy/core";
import {
  decodeJwt,
  errors,
  importJWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import { base64Url } from "../world/encoding.ts";
import { html, json, oauthError } from "../world/http.ts";
import { consentPage, errorPage } from "./pages.ts";
import { signingKey } from "./signing-key.ts";

/**
 * A simulation of Google's OpenID Connect service, written from
 * https://developers.google.com/identity/openid-connect/openid-connect and
 * https://developers.google.com/identity/protocols/oauth2/web-server.
 *
 * It answers on Google's real addresses, so the code under test is the code
 * that runs against Google. For development and tests only: it signs anybody
 * in as anybody.
 */

export const googleIssuer = "https://accounts.google.com";
export const googleAuthorizationEndpoint = `${googleIssuer}/o/oauth2/v2/auth`;
const discoveryEndpoint = `${googleIssuer}/.well-known/openid-configuration`;
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const jwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const googleOrigins = [
  "https://accounts.google.com",
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
];

// Google documents neither lifetime. Ten minutes is the longest RFC 6749
// recommends for a code, and Google's ID tokens are observed to last an hour.
const codeLifetimeSeconds = 10 * 60;
const idTokenLifetimeSeconds = 60 * 60;

// What sets a code apart from an ID token, which is signed with the same key.
const codeType = "simulated-google-code+jwt";

/** An OAuth client, as registered in the Google Cloud Console. */
export type GoogleSimulatorClient = {
  clientId: string;
  clientSecret: string;
  /** Google redirects to these addresses only, compared character by character. */
  redirectUris: readonly string[];
};

export type GoogleSimulatorAccount = {
  email: string;
  name: string;
};

export type GoogleSimulatorOptions = {
  /** Codes and ID tokens are issued and expire by this clock. */
  now: Clock;
  client: GoogleSimulatorClient;
  /** Offered on the consent page, to sign in with one click. */
  accounts?: readonly GoogleSimulatorAccount[];
};

export type GoogleSimulator = {
  /**
   * Stands in for `fetch`. Answers requests to Google's hosts and fails for
   * every other host, so nothing leaves the process.
   *
   * The codes it hands out carry everything needed to redeem them, so any
   * instance with the same client can redeem a code of another. Only the
   * memory of which codes were redeemed already is kept per instance.
   */
  fetch: Fetch;
};

// The authorization request, kept in the code until it is redeemed.
type CodeClaims = {
  jti: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
};

const encoder = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

/** A 21-digit account ID like Google's, the same for the same email address. */
async function subjectFor(email: string): Promise<string> {
  const digest = new Uint8Array(await sha256(normalizeEmail(email)));
  const number = digest
    .slice(0, 8)
    .reduce((sum, byte) => sum * 256n + BigInt(byte), 0n);
  return `1${(number % 10n ** 20n).toString().padStart(20, "0")}`;
}

/** A text field of a submitted form. */
function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function nameFor(email: string): string {
  return email.split("@")[0] || email;
}

function redirectTo(url: URL): Response {
  return new Response(null, { status: 302, headers: { Location: url.href } });
}

/**
 * `idToken` with `claims` changed, signed again with the key of the
 * simulated Google. The simulator only issues tokens that are right, so this
 * is how a test gets one that a client has to refuse for a single claim,
 * such as its audience.
 */
export async function resignIdToken(
  idToken: string,
  claims: JWTPayload,
): Promise<string> {
  const { kid, alg } = signingKey;
  return new SignJWT({ ...decodeJwt(idToken), ...claims })
    .setProtectedHeader({ alg, kid, typ: "JWT" })
    .sign(await importJWK(signingKey, alg));
}

export function createGoogleSimulator({
  now,
  client,
  accounts = [],
}: GoogleSimulatorOptions): GoogleSimulator {
  const { kid, alg, use, kty, n, e } = signingKey;
  const privateKey = importJWK(signingKey, alg);
  const publicKey = importJWK({ kty, n, e }, alg);
  const epochSeconds = () => Math.floor(now().getTime() / 1000);

  // Codes that were redeemed, by ID, with the time they expire at. A code is
  // good for one use.
  const redeemed = new Map<string, number>();

  function discovery(): Response {
    return Response.json({
      issuer: googleIssuer,
      authorization_endpoint: googleAuthorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksEndpoint,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [alg],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      claims_supported: [
        "aud",
        "email",
        "email_verified",
        "exp",
        "family_name",
        "given_name",
        "iat",
        "iss",
        "name",
        "sub",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
      grant_types_supported: ["authorization_code"],
    });
  }

  function jwks(): Response {
    return Response.json({ keys: [{ kty, alg, use, kid, n, e }] });
  }

  /**
   * Checks an authorization request the way Google does before it shows
   * anything. These failures end on an error page: Google does not redirect
   * to an address it has no reason to trust.
   */
  function invalidAuthorizationRequest(
    params: URLSearchParams,
  ): Response | undefined {
    const fail = (status: number, error: string, description: string) =>
      html(status, errorPage(status, error, description));

    if (params.get("client_id") !== client.clientId) {
      return fail(401, "invalid_client", "The OAuth client was not found.");
    }
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return fail(
        400,
        "redirect_uri_mismatch",
        "The redirect URI in the request does not match the ones authorized for the OAuth client.",
      );
    }
    if (params.get("response_type") !== "code") {
      return fail(
        400,
        "invalid_request",
        "Only response_type=code is simulated.",
      );
    }
    const scopes = params.get("scope")?.split(" ") ?? [];
    if (!scopes.includes("openid")) {
      return fail(
        400,
        "invalid_scope",
        'Only OpenID Connect is simulated: the scope must include "openid".',
      );
    }
    const challenge = params.get("code_challenge");
    const method = params.get("code_challenge_method");
    if (method !== null && method !== "S256" && method !== "plain") {
      return fail(
        400,
        "invalid_request",
        "code_challenge_method must be S256 or plain.",
      );
    }
    if (method !== null && challenge === null) {
      return fail(400, "invalid_request", "Missing code_challenge.");
    }
    // The form RFC 7636 gives a challenge.
    if (challenge !== null && !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
      return fail(400, "invalid_request", "Invalid code_challenge.");
    }
    // A space-delimited, case-sensitive list of the three values that Google
    // documents.
    for (const prompt of params.get("prompt")?.split(" ") ?? []) {
      if (prompt === "none") {
        // It asks for an answer without any page. Nobody is ever signed in
        // at the simulated Google, which always asks who to sign in as.
        return fail(400, "invalid_request", "prompt=none is not simulated.");
      }
      if (prompt !== "consent" && prompt !== "select_account") {
        return fail(400, "invalid_request", `Invalid prompt: ${prompt}`);
      }
    }
    return undefined;
  }

  async function authorize(request: Request, url: URL): Promise<Response> {
    const params = url.searchParams;
    const invalid = invalidAuthorizationRequest(params);
    if (invalid) return invalid;
    if (request.method === "GET") return html(200, consentPage(accounts));

    // The person has answered the consent page.
    const form = await request.formData();
    const redirectUri = params.get("redirect_uri") ?? "";
    const redirect = new URL(redirectUri);
    const state = params.get("state");
    if (state !== null) redirect.searchParams.set("state", state);

    if (field(form, "action") === "cancel") {
      redirect.searchParams.set("error", "access_denied");
      return redirectTo(redirect);
    }

    const email = field(form, "email")?.trim();
    if (!email) {
      return html(400, errorPage(400, "invalid_request", "Enter an email."));
    }
    const scope = params.get("scope") ?? "";
    const nonce = params.get("nonce");
    const challenge = params.get("code_challenge");
    const claims: CodeClaims = {
      jti: crypto.randomUUID(),
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope,
      ...(nonce !== null && { nonce }),
      ...(challenge !== null && {
        code_challenge: challenge,
        // RFC 7636: a challenge without a method is a plain one.
        code_challenge_method: params.get("code_challenge_method") ?? "plain",
      }),
      sub: field(form, "sub")?.trim() || (await subjectFor(email)),
      email,
      // A browser leaves an unchecked checkbox out of the form.
      email_verified: form.has("email_verified"),
      name: field(form, "name")?.trim() || nameFor(email),
    };
    const issuedAt = epochSeconds();
    const code = await new SignJWT(claims)
      .setProtectedHeader({ alg, kid, typ: codeType })
      .setIssuer(googleIssuer)
      .setAudience(tokenEndpoint)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + codeLifetimeSeconds)
      .sign(await privateKey);

    // Google's codes start like this too. The slash has to survive the trip
    // through the redirect and the token request.
    redirect.searchParams.set("code", `4/0${code}`);
    redirect.searchParams.set("scope", scope);
    return redirectTo(redirect);
  }

  /** The client ID and secret of a token request, sent either way Google accepts. */
  function clientCredentials(
    request: Request,
    form: FormData,
  ): { id: string | null; secret: string | null } {
    const [scheme, encoded] =
      request.headers.get("Authorization")?.split(" ") ?? [];
    if (scheme?.toLowerCase() === "basic" && encoded) {
      try {
        // RFC 6749: both are form-encoded before they are joined.
        const [id, secret] = atob(encoded)
          .split(":")
          .map((part) => decodeURIComponent(part.replaceAll("+", " ")));
        return { id: id ?? null, secret: secret ?? null };
      } catch {
        return { id: null, secret: null };
      }
    }
    return {
      id: field(form, "client_id"),
      secret: field(form, "client_secret"),
    };
  }

  async function verifiedCode(
    code: string | null,
  ): Promise<CodeClaims | "malformed" | "expired"> {
    if (!code?.startsWith("4/0")) return "malformed";
    try {
      const { payload } = await jwtVerify<CodeClaims>(
        code.slice(3),
        await publicKey,
        {
          algorithms: [alg],
          typ: codeType,
          issuer: googleIssuer,
          audience: tokenEndpoint,
          currentDate: now(),
          clockTolerance: 0,
        },
      );
      return payload;
    } catch (error) {
      return error instanceof errors.JWTExpired ? "expired" : "malformed";
    }
  }

  async function matchesChallenge(
    verifier: string,
    challenge: string,
    method: string | undefined,
  ): Promise<boolean> {
    if (method === "S256") {
      return base64Url(await sha256(verifier)) === challenge;
    }
    return verifier === challenge;
  }

  async function token(request: Request): Promise<Response> {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return oauthError(400, "invalid_request", "Bad Request");
    }
    const form = await request.formData();

    const credentials = clientCredentials(request, form);
    if (credentials.id !== client.clientId) {
      return oauthError(
        401,
        "invalid_client",
        "The OAuth client was not found.",
      );
    }
    if (credentials.secret !== client.clientSecret) {
      return oauthError(401, "invalid_client", "Unauthorized");
    }
    const grantType = field(form, "grant_type");
    if (grantType !== "authorization_code") {
      return oauthError(
        400,
        "unsupported_grant_type",
        `Invalid grant_type: ${grantType ?? ""}`,
      );
    }

    const code = await verifiedCode(field(form, "code"));
    if (code === "malformed") {
      return oauthError(400, "invalid_grant", "Malformed auth code.");
    }
    if (code === "expired" || code.client_id !== client.clientId) {
      return oauthError(400, "invalid_grant", "Bad Request");
    }
    if (field(form, "redirect_uri") !== code.redirect_uri) {
      return oauthError(400, "redirect_uri_mismatch", "Bad Request");
    }
    const verifier = field(form, "code_verifier");
    if (code.code_challenge === undefined) {
      if (verifier !== null) {
        return oauthError(
          400,
          "invalid_grant",
          "code_verifier or verifier is not needed.",
        );
      }
    } else if (verifier === null) {
      return oauthError(400, "invalid_grant", "Missing code verifier.");
    } else if (
      !(await matchesChallenge(
        verifier,
        code.code_challenge,
        code.code_challenge_method,
      ))
    ) {
      return oauthError(400, "invalid_grant", "Invalid code verifier.");
    }

    const issuedAt = epochSeconds();
    for (const [id, expiresAt] of redeemed) {
      // An expired code is refused for its age, so it can be forgotten.
      if (expiresAt <= issuedAt) redeemed.delete(id);
    }
    // Looked up and noted in one step, with no `await` in between, so that
    // of two requests that arrive together only one gets past this point.
    // It comes after everything that can refuse the request, because a
    // request that is refused must not use the code up.
    if (redeemed.has(code.jti)) {
      return oauthError(400, "invalid_grant", "Bad Request");
    }
    redeemed.set(code.jti, issuedAt + codeLifetimeSeconds);

    const scopes = code.scope.split(" ");
    const accessToken = `ya29.${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
    // The left half of the hash of the access token, as OpenID Connect
    // defines "at_hash".
    const accessTokenHash = base64Url((await sha256(accessToken)).slice(0, 16));
    const [givenName, ...familyNames] = code.name.split(" ");
    const idToken = await new SignJWT({
      azp: client.clientId,
      ...(scopes.includes("email") && {
        email: code.email,
        email_verified: code.email_verified,
      }),
      at_hash: accessTokenHash,
      ...(code.nonce !== undefined && { nonce: code.nonce }),
      ...(scopes.includes("profile") && {
        name: code.name,
        given_name: givenName,
        family_name: familyNames.join(" "),
      }),
    })
      .setProtectedHeader({ alg, kid, typ: "JWT" })
      .setIssuer(googleIssuer)
      .setAudience(client.clientId)
      .setSubject(code.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + idTokenLifetimeSeconds)
      .sign(await privateKey);

    return json(200, {
      access_token: accessToken,
      expires_in: idTokenLifetimeSeconds - 1,
      // Google answers with the long names of these two scopes.
      scope: scopes
        .map((scope) =>
          scope === "email" || scope === "profile"
            ? `https://www.googleapis.com/auth/userinfo.${scope}`
            : scope,
        )
        .join(" "),
      token_type: "Bearer",
      id_token: idToken,
    });
  }

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const endpoint = url.origin + url.pathname;
      const { method } = request;

      if (endpoint === discoveryEndpoint && method === "GET") {
        return discovery();
      }
      if (endpoint === jwksEndpoint && method === "GET") return jwks();
      if (
        endpoint === googleAuthorizationEndpoint &&
        (method === "GET" || method === "POST")
      ) {
        return authorize(request, url);
      }
      if (endpoint === tokenEndpoint && method === "POST") {
        return token(request);
      }
      if (googleOrigins.includes(url.origin)) {
        return new Response("Not found", { status: 404 });
      }
      // What `fetch` does when a host cannot be reached.
      throw new TypeError(
        `The simulated Google does not answer for ${url.origin}`,
      );
    },
  };
}
