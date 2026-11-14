import type { Clock, Fetch } from "@pigy/core";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { GoogleConnection } from "./config.ts";

/**
 * Sign-in with Google: the OpenID Connect authorization code flow with PKCE,
 * state and nonce. oauth4webapi does the protocol work and the validation.
 * This file only puts its calls in order. It always addresses Google's real
 * hosts: `google.fetch` decides what answers.
 */

const issuer = new URL("https://accounts.google.com");

/** What has to survive from the redirect to Google until the callback. */
export const signInFlowSchema = z.object({
  /** Ties the callback to the browser that started the sign-in. */
  state: z.string().min(1),
  /** Ties the ID token to this sign-in. */
  nonce: z.string().min(1),
  /** Proves to Google that the code is redeemed by whoever asked for it. */
  codeVerifier: z.string().min(1),
});

type SignInFlow = z.infer<typeof signInFlowSchema>;

// The claims of Google's ID token that pigy reads. The token itself has been
// validated by oauth4webapi by the time this is applied.
const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
  // Google may leave the name out.
  name: z.string().optional(),
});

type GoogleIdentity = {
  /** Google's permanent ID of the account. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
};

function requestOptions(fetch: Fetch) {
  return {
    // oauth4webapi spells "no body" as `body: undefined`, which the type of
    // `fetch` does not allow.
    [oauth.customFetch]: (
      url: string,
      {
        body,
        ...init
      }: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) => fetch(url, body === undefined ? init : { ...init, body }),
  };
}

async function discover(fetch: Fetch): Promise<oauth.AuthorizationServer> {
  const response = await oauth.discoveryRequest(issuer, requestOptions(fetch));
  return oauth.processDiscoveryResponse(issuer, response);
}

/** The address at Google to send the browser to, and what to remember. */
export async function beginSignIn(
  google: GoogleConnection,
  redirectUri: string,
): Promise<{ url: URL; flow: SignInFlow }> {
  const as = await discover(google.fetch);
  if (!as.authorization_endpoint) {
    throw new Error(
      "Google's discovery document has no authorization endpoint",
    );
  }
  const flow = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    codeVerifier: oauth.generateRandomCodeVerifier(),
  };
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(flow.codeVerifier),
    code_challenge_method: "S256",
    // Always ask which account to use. Without it Google silently picks the
    // one that is signed in, and somebody who was refused with that account
    // could never try another.
    prompt: "select_account",
  }).toString();
  return { url, flow };
}

/**
 * Finishes the sign-in that `flow` started with the parameters Google sent
 * to `callbackUrl`. Throws unless everything checks out: the state, the code
 * exchange, and the ID token with its signature, issuer, audience, expiry
 * and nonce.
 */
export async function completeSignIn(
  google: GoogleConnection,
  redirectUri: string,
  callbackUrl: URL,
  flow: SignInFlow,
  now: Clock,
): Promise<GoogleIdentity> {
  const options = requestOptions(google.fetch);
  const as = await discover(google.fetch);
  const client: oauth.Client = {
    client_id: google.clientId,
    // oauth4webapi reads the system clock. This shifts it to `now`.
    [oauth.clockSkew]: Math.round((now().getTime() - Date.now()) / 1000),
  };

  const parameters = oauth.validateAuthResponse(
    as,
    client,
    callbackUrl,
    flow.state,
  );
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.ClientSecretPost(google.clientSecret),
    parameters,
    redirectUri,
    flow.codeVerifier,
    options,
  );
  const result = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    response,
    { expectedNonce: flow.nonce, requireIdToken: true },
  );
  // OpenID Connect lets a client skip the signature of an ID token that it
  // got straight from the token endpoint, and oauth4webapi does skip it
  // there. Checking it anyway costs one request for Google's keys.
  await oauth.validateApplicationLevelSignature(as, response, options);

  const claims = identitySchema.parse(oauth.getValidatedIdTokenClaims(result));
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified,
    name: claims.name,
  };
}
