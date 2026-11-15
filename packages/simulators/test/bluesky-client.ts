import { createHash, randomUUID } from "node:crypto";
import type { Fetch } from "@pigy/core";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { answerConsent } from "../src/world/index.ts";

/**
 * A client of atproto OAuth for the tests of the simulated Bluesky: what
 * an adapter does, written with the jose library and with no care for what
 * a real client must check. Every step can be bent, to see the simulated
 * server refuse what a real one refuses.
 */

export const clientId =
  "https://pigy.example/connect/bluesky/client-metadata.json";
export const redirectUri = "https://pigy.example/connect/bluesky/callback";
export const scope =
  "atproto repo:app.bsky.feed.post?action=create&action=delete blob:image/* blob:video/*";

const assertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/** A key pair for ES256, with its public half as a JWK. */
export async function newKey(kid?: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk: JWK = { ...(await exportJWK(publicKey)), ...(kid && { kid }) };
  return { privateKey, jwk };
}

/** A client: its key, and the document that it publishes. */
export async function newClient(overrides: Record<string, unknown> = {}) {
  const key = await newKey("key-1");
  const id = (overrides.client_id as string | undefined) ?? clientId;
  const metadata: Record<string, unknown> = {
    client_id: id,
    application_type: "web",
    client_name: "pigy",
    grant_types: ["authorization_code", "refresh_token"],
    scope,
    response_types: ["code"],
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks: { keys: [key.jwk] },
    ...overrides,
  };
  return { id, key, metadata };
}

export type TestClient = Awaited<ReturnType<typeof newClient>>;

/** The assertion that a client authenticates with at `issuer`. */
export function assertion(
  client: TestClient,
  issuer: string,
  now: Date,
  bent: {
    key?: Key;
    kid?: string;
    claims?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    iss: client.id,
    sub: client.id,
    aud: issuer,
    jti: randomUUID(),
    iat,
    exp: iat + 60,
    ...bent.claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: bent.kid ?? "key-1" })
    .sign(bent.key ?? client.key.privateKey);
}

/** A DPoP proof for a request, signed with `key`. */
export function proof(
  key: Awaited<ReturnType<typeof newKey>>,
  request: {
    method: string;
    url: string;
    now: Date;
    nonce?: string | undefined;
    accessToken?: string;
    claims?: Record<string, unknown>;
  },
): Promise<string> {
  const { origin, pathname } = new URL(request.url);
  return new SignJWT({
    jti: randomUUID(),
    htm: request.method,
    htu: origin + pathname,
    iat: Math.floor(request.now.getTime() / 1000),
    ...(request.nonce !== undefined && { nonce: request.nonce }),
    ...(request.accessToken !== undefined && {
      ath: createHash("sha256").update(request.accessToken).digest("base64url"),
    }),
    ...request.claims,
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk })
    .sign(key.privateKey);
}

/** The name of the error in an answer, if it is JSON that names one. */
async function errorOf(response: Response): Promise<string | undefined> {
  try {
    return ((await response.clone().json()) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

/** A verifier of PKCE and the challenge made from it. */
export function pkce() {
  const verifier = randomUUID() + randomUUID();
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  sub: string;
};

/** The tokens in an answer of the token endpoint. Empty if it has none. */
const tokensOf = async (response: Response) =>
  (await response
    .clone()
    .json()
    .catch(() => ({}))) as Tokens;

/**
 * What a client does with a server over time: it learns the nonce of each
 * host from the answers and sends it with the next proof.
 */
export function agent(
  fetch: Fetch,
  client: TestClient,
  now: () => Date,
  dpop: Awaited<ReturnType<typeof newKey>>,
) {
  const nonces = new Map<string, string>();

  /** Sends a request with a proof, and again if the server asks for a nonce. */
  async function send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    accessToken?: string,
  ): Promise<Response> {
    const { host } = new URL(url);
    for (let tries = 0; ; tries++) {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          ...(accessToken && { Authorization: `DPoP ${accessToken}` }),
          DPoP: await proof(dpop, {
            method: init.method,
            url,
            now: now(),
            nonce: nonces.get(host),
            ...(accessToken && { accessToken }),
          }),
        },
      });
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) nonces.set(host, nonce);
      const asked =
        (response.status === 400 || response.status === 401) &&
        (await errorOf(response)) === "use_dpop_nonce";
      if (!asked || tries > 0) return response;
    }
  }

  /** Posts a form to an OAuth endpoint, with the assertion of the client. */
  async function form(
    issuer: string,
    path: string,
    params: Record<string, string>,
  ): Promise<Response> {
    // An assertion is good once, so each try gets its own. The first try
    // is the one that learns the nonce.
    for (let tries = 0; ; tries++) {
      const { host } = new URL(issuer);
      const url = issuer + path;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          DPoP: await proof(dpop, {
            method: "POST",
            url,
            now: now(),
            nonce: nonces.get(host),
          }),
        },
        body: new URLSearchParams({
          client_id: client.id,
          client_assertion_type: assertionType,
          client_assertion: await assertion(client, issuer, now()),
          ...params,
        }).toString(),
      });
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) nonces.set(host, nonce);
      if ((await errorOf(response)) !== "use_dpop_nonce" || tries > 0) {
        return response;
      }
    }
  }

  return {
    nonces,
    send,
    form,

    /** Pushes an authorization request and returns the address to consent at. */
    async push(issuer: string, params: Record<string, string> = {}) {
      const code = pkce();
      const state = randomUUID();
      const response = await form(issuer, "/oauth/par", {
        response_type: "code",
        code_challenge: code.challenge,
        code_challenge_method: "S256",
        state,
        redirect_uri: redirectUri,
        scope,
        ...params,
      });
      const body = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { request_uri?: string };
      const url = new URL(`${issuer}/oauth/authorize`);
      url.searchParams.set("client_id", client.id);
      url.searchParams.set("request_uri", body.request_uri ?? "");
      return { response, url: url.href, state, verifier: code.verifier };
    },

    /** Exchanges a code for tokens. */
    async exchange(
      issuer: string,
      code: string,
      verifier: string,
      params: Record<string, string> = {},
    ) {
      const response = await form(issuer, "/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        ...params,
      });
      return { response, tokens: await tokensOf(response) };
    },

    /** Renews the tokens of a session. */
    async refresh(issuer: string, refreshToken: string) {
      const response = await form(issuer, "/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      return { response, tokens: await tokensOf(response) };
    },

    /** Goes through a whole connection, as the account `did`. */
    async connect(issuer: string, did: string) {
      const pushed = await this.push(issuer);
      const callback = await answerConsent(fetch, pushed.url, { account: did });
      const { tokens } = await this.exchange(
        issuer,
        callback.searchParams.get("code") ?? "",
        pushed.verifier,
      );
      return tokens;
    },

    /** Calls a method of the HTTP API of a PDS as the account of a token. */
    xrpc(
      pds: string,
      method: string,
      accessToken: string,
      body: Record<string, unknown>,
    ) {
      return send(
        `https://${pds}/xrpc/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        accessToken,
      );
    },
  };
}

export type Agent = ReturnType<typeof agent>;
