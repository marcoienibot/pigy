import {
  blueskyMaxBytes,
  blueskyMaxCharacters,
  type Clock,
  type Fetch,
  type Limits,
} from "@pigy/core";
import { z } from "zod";
import { ProviderError, quotable } from "../errors.ts";
import { publicOrigin, publicUrl } from "../host.ts";
import { type HttpAnswer, randomToken, retryAfter, send } from "../http.ts";
import {
  type Json,
  type Provider,
  type PublishProgress,
  publishProgressSchema,
} from "../provider.ts";
import {
  claims,
  didDocumentSchema,
  didDocumentUrl,
  didsInAnswer,
  dnsAnswerSchema,
  parseDid,
  parseHandle,
  pdsOf,
} from "./identity.ts";
import {
  clientAssertion,
  clientAssertionType,
  dpopProof,
  newKey,
  type PrivateJwk,
  pkce,
  privateJwkSchema,
  publicJwk,
} from "./jwt.ts";

export { parseHandle } from "./identity.ts";

/**
 * The adapter for Bluesky, written from the specifications of atproto at
 * https://atproto.com/specs ("OAuth", "Permissions", "Handle", "DID",
 * "Record Key", "TID", "HTTP API (XRPC)"), the guide to OAuth clients at
 * https://docs.bsky.app/docs/advanced-guides/oauth-client, the lexicons of
 * `com.atproto.repo` and `app.bsky.feed.post`, and the RFCs that the
 * specification of OAuth names: 9126 (pushed requests), 7636 (PKCE), 9449
 * (DPoP), 7523 (the assertion of a client), 9207 (`iss`) and 7009
 * (revocation).
 *
 * pigy is a confidential client of atproto OAuth. Its client ID is the
 * address of a document that pigy serves, which describes it and holds the
 * public keys that it signs with: `clientMetadata` makes it. An
 * authorization server reads it from there, so pigy needs no registration
 * anywhere. Every access is bound to a key of its own, which each request
 * proves with DPoP, and lasts minutes. A refresh renews it, once per
 * refresh token: the server replaces the token with every refresh.
 *
 * The OAuth is written here on the Web Crypto API, and not with a library:
 * the libraries of atproto are written for Node, and oauth4webapi, which
 * pigy signs in to Google with, reads the time from the global clock and
 * keeps the nonces of DPoP in memory of its own, where an adapter takes
 * its clock as a parameter and keeps nothing between calls.
 *
 * Text only so far: no links marked up, no mentions, no media.
 */

/** The collection that posts are records of. */
const postCollection = "app.bsky.feed.post";

/**
 * What pigy asks an account for: to write and delete its posts, and to
 * upload media, which it does not do yet. A session cannot gain a scope
 * later, so asking now spares everybody a second connection when pigy
 * posts media. Reading a post takes no scope: records are public.
 */
export const blueskyScope = [
  "atproto",
  `repo:${postCollection}?action=create&action=delete`,
  "blob:image/*",
  "blob:video/*",
].join(" ");

/** A key that pigy signs its assertions with, as a client. */
export type BlueskyClientKey = {
  /** How the client metadata names it: `kid`. */
  id: string;
  /** The key, with its private half. A secret. */
  privateKey: PrivateJwk;
};

/**
 * The client metadata document of pigy, which it serves at `clientId`:
 * "Client ID Metadata Document" of the specification. It holds the public
 * halves of `keys`, and nothing secret.
 */
export function clientMetadata({
  clientId,
  redirectUri,
  name,
  keys,
}: {
  clientId: string;
  redirectUri: string;
  /** What pigy is called on the page where a person consents. */
  name: string;
  keys: readonly BlueskyClientKey[];
}) {
  return {
    client_id: clientId,
    client_name: name,
    client_uri: new URL(clientId).origin,
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [redirectUri],
    scope: blueskyScope,
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    // In the document, not behind an address of their own: there is one
    // thing less to serve, and to cache.
    jwks: {
      keys: keys.map(({ id, privateKey }) => ({
        ...publicJwk(privateKey),
        kid: id,
        alg: "ES256",
        use: "sig",
      })),
    },
  };
}

export type BlueskyProviderOptions = {
  fetch: Fetch;
  now: Clock;
  /**
   * pigy's client ID for the callback address `redirectUri`: the address
   * of its client metadata document, at the same origin.
   */
  clientIdFor: (redirectUri: string) => string;
  /**
   * The keys of the client, the one that signs new sessions first. A
   * session is bound to the key that it began with, so a key stays here
   * for as long as a session that began with it is to last, and the
   * client metadata has the same keys. Asked for when a key is needed,
   * which is not to post: what this throws comes out of the adapter as it
   * is.
   */
  keys: () => Promise<readonly BlueskyClientKey[]>;
  /** The resolver that DNS queries go to. Cloudflare's, by default. */
  dnsResolver?: string;
  /** The directory of `did:plc`. */
  plcDirectory?: string;
  /** How long to wait for a server to answer. 30 seconds by default. */
  timeoutMs?: number;
};

/** What a channel on Bluesky is reached with. */
const credentialsSchema = z.strictObject({
  /** The account. */
  did: z.string().min(1),
  /** The PDS of the account: where its posts are written. */
  pds: z.string().min(1),
  /** The authorization server of the session, and its endpoints. */
  issuer: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  revocationEndpoint: z.string().min(1).nullable(),
  /**
   * The client the session was begun as, and the key of the client that
   * it is bound to. A refresh has to come from the same.
   */
  clientId: z.string().min(1),
  keyId: z.string().min(1),
  /** The key that every request of the session proves. A secret. */
  dpopKey: privateJwkSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type BlueskyCredentials = z.infer<typeof credentialsSchema>;

const pendingSchema = z.strictObject({
  state: z.string().min(1),
  handle: z.string().min(1),
  did: z.string().min(1),
  pds: z.string().min(1),
  issuer: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  revocationEndpoint: z.string().min(1).nullable(),
  redirectUri: z.string().min(1),
  clientId: z.string().min(1),
  keyId: z.string().min(1),
  codeVerifier: z.string().min(1),
  dpopKey: privateJwkSchema,
});

type Pending = z.infer<typeof pendingSchema>;

// What pigy reads of the answers. Everything else is ignored.

/** RFC 9728, the metadata of a PDS as a resource server. */
const resourceSchema = z.object({
  authorization_servers: z.array(z.string()).min(1),
});

/** RFC 8414, as atproto requires it. */
const serverSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  pushed_authorization_request_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  dpop_signing_alg_values_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  token_endpoint_auth_signing_alg_values_supported: z.array(z.string()),
});

const pushedSchema = z.object({ request_uri: z.string().min(1) });

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  refresh_token: z.string().min(1),
  scope: z.string(),
  /** The account, which atproto adds. */
  sub: z.string(),
});

/** A strong reference: a record by its address and its hash. */
const referenceSchema = z.strictObject({
  uri: z.string().min(1),
  cid: z.string().min(1),
});

/** A record, as com.atproto.repo.getRecord answers with it. */
const recordSchema = z.object({
  uri: z.string(),
  cid: z.string().min(1),
  value: z.unknown(),
});

/** What createRecord answers with. */
const writtenSchema = z.object({ uri: z.string(), cid: z.string().min(1) });

/** What pigy reads of a post. */
const postSchema = z.object({
  text: z.string(),
  reply: z.object({ parent: z.object({ uri: z.string() }) }).optional(),
});

const profileSchema = z.object({
  displayName: z.string().optional(),
  avatar: z.object({ ref: z.object({ $link: z.string() }) }).optional(),
});

/**
 * What a step of a post notes for the steps after it. It is stored with
 * the progress, as it is: record keys and hashes, which are public.
 */
const notesSchema = z.strictObject({
  /** The account that posts. */
  did: z.string().min(1),
  /**
   * The record key that the next part is written under, once a step has
   * chosen it, or null until then. It is recorded before anything is
   * written under it, so that a step which is run again looks there.
   */
  rkey: z.string().min(1).nullable(),
  /** The reference of each part that is published, in order. */
  refs: z.array(referenceSchema),
});

type Notes = z.infer<typeof notesSchema>;

// Far above any answer that pigy reads.
const maxBytes = 256 * 1024;

/**
 * When to renew an access that nobody uses, so that it does not lapse:
 * a week after its tokens were issued. GUESS: Bluesky does not say how
 * long a refresh token lasts. The specification has 180 days at most for
 * a confidential client, and the code of Bluesky's server three months.
 * The access token lasts minutes, and is not what this is about: a step
 * that finds it ended is refused, and asks for a refresh then.
 */
const refreshAfterMs = 7 * 24 * 60 * 60 * 1000;

const sortable = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * A new record key: a TID, "TID" of the specifications. 53 bits of the
 * time in microseconds and 10 random bits, in a base32 that sorts like
 * the number. Whoever makes one at the same microsecond with the same ten
 * bits makes the same, which is why they are random.
 *
 * A TID grows, as the specification wants it: it is later than `after`,
 * the key of the part before, also where the clock says otherwise. So the
 * parts of a thread sort in their order in the repository.
 */
function newTid(now: Date, after: string | undefined): string {
  let earliest = BigInt(now.getTime()) * 1000n;
  if (after) {
    let before = 0n;
    for (const char of after)
      before = before * 32n + BigInt(sortable.indexOf(char));
    if (before >> 10n >= earliest) earliest = (before >> 10n) + 1n;
  }
  const [random = 0] = crypto.getRandomValues(new Uint16Array(1));
  let value = (earliest << 10n) | BigInt(random & 0x3ff);
  let text = "";
  for (let index = 0; index < 13; index++) {
    text = sortable[Number(value & 31n)] + text;
    value >>= 5n;
  }
  return text;
}

/** The record that `uri` names, an AT URI, or null if it is none. */
function parseRecordUri(uri: string) {
  const [, did = "", collection = "", rkey = ""] =
    /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri) ?? [];
  return did && parseDid(did) ? { did, collection, rkey } : null;
}

/** Where a post is shown to people: Bluesky's own app. */
const postUrl = (did: string, rkey: string) =>
  `https://bsky.app/profile/${did}/post/${rkey}`;

type Call = {
  method?: "GET" | "POST";
  /** A body, as JSON. */
  json?: unknown;
  /** A body, as a form. OAuth takes its parameters this way. */
  form?: Record<string, string>;
  /** What the request carries that must not show up in a message. */
  secrets?: readonly string[];
};

/**
 * The nonces that the servers of a session have handed out, by origin.
 * They are kept for the requests of one call of the adapter, and the
 * first request of the next learns them anew: an adapter keeps nothing
 * between calls.
 */
type Nonces = Map<string, string>;

/** An answer, and the host that gave it, for the messages to name. */
type Answer = HttpAnswer & { host: string };

/** The error that an answer names, in the body or in `WWW-Authenticate`. */
function errorOf({ headers, json }: Answer): string | undefined {
  const body = z.object({ error: z.string() }).safeParse(json).data;
  if (body) return body.error;
  return /error="([^"]+)"/.exec(headers.get("WWW-Authenticate") ?? "")?.[1];
}

export function createBlueskyProvider({
  fetch,
  now,
  clientIdFor,
  keys,
  dnsResolver = "cloudflare-dns.com",
  plcDirectory = "plc.directory",
  timeoutMs = 30_000,
}: BlueskyProviderOptions): Provider {
  /** Sends a request and returns the answer as it is. */
  async function request(
    url: string,
    { method = "GET", json, form }: Call,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
    const { host } = new URL(url);
    const answer = await send(
      fetch,
      host,
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(json !== undefined && { "Content-Type": "application/json" }),
          ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...headers,
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        ...(form && { body: new URLSearchParams(form).toString() }),
      },
      { timeoutMs, maxBytes },
    );
    return { ...answer, host };
  }

  /**
   * The time to try again after a 429. Bluesky sends `RateLimit-Reset`,
   * which its servers write as the time of the reset in seconds since the
   * epoch, where the draft that they follow has the seconds that are left.
   * GUESS: both are taken, the larger number for a time.
   */
  function rateLimitReset(headers: Headers): Date | undefined {
    const value = Number(headers.get("RateLimit-Reset") ?? "");
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value > 1_000_000_000
      ? new Date(value * 1000)
      : new Date(now().getTime() + value * 1000);
  }

  /**
   * What an answer that is not a success means for the caller. `token`
   * is the access token that the request was made with, if any: only an
   * answer to it says anything about the account's access.
   */
  function failure(
    answer: Answer,
    { secrets = [] }: Call,
    token?: string,
  ): ProviderError {
    const { status, headers, json, host } = answer;
    const body = z
      .object({
        error: z.string().optional(),
        message: z.string().optional(),
        error_description: z.string().optional(),
      })
      .safeParse(json).data;
    const said = quotable(
      body?.message ?? body?.error_description ?? body?.error ?? "",
      [...secrets, ...(token ? [token] : [])],
    );
    if (status === 429) {
      return new ProviderError(
        "retry",
        `${host} is limiting how often pigy may ask.`,
        {
          status,
          retryAt: retryAfter(headers, now()) ?? rateLimitReset(headers),
        },
      );
    }
    if (status >= 500) {
      return new ProviderError(
        "retry",
        `${host} is having trouble (HTTP ${status}).`,
        { status, retryAt: retryAfter(headers, now()) },
      );
    }
    if (errorOf(answer) === "use_dpop_nonce") {
      // The server wants another nonce after the one try with the nonce
      // that it handed out: it has turned to a new one in between. Nothing
      // is wrong with the request, and nothing with the access, which a
      // refresh would renew for nothing. The next call learns the nonce
      // anew.
      return new ProviderError(
        "retry",
        `${host} asked pigy for a new proof once more.`,
        { status },
      );
    }
    if (token && status === 401 && errorOf(answer) !== "invalid_dpop_proof") {
      // An access token that has ended, which is every few minutes, or
      // one that was revoked: the server does not tell the two apart in a
      // way that is documented. A refresh does: it renews the one and is
      // refused for the other.
      return new ProviderError(
        "refresh",
        "Bluesky refused the access token of this account.",
        { status },
      );
    }
    if (token && status === 403) {
      return new ProviderError(
        "reconnect",
        "Bluesky no longer lets pigy post for this account. Connect it again.",
        { status },
      );
    }
    return new ProviderError(
      "fail",
      said
        ? `${host} refused the request: ${said}`
        : `${host} refused the request (HTTP ${status}).`,
      { status },
    );
  }

  /** `value` as `schema` describes it. Throws if the server sent other. */
  function understood<Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
    what: string,
  ): z.output<Schema> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ProviderError(
        "fail",
        `${what} did not answer the way atproto has it.`,
      );
    }
    return parsed.data;
  }

  /** The JSON that a server answers with. Throws otherwise. */
  async function call(url: string, options: Call = {}): Promise<unknown> {
    const answer = await request(url, options);
    if (answer.status < 200 || answer.status >= 300) {
      throw failure(answer, options);
    }
    return answer.json;
  }

  /**
   * Sends a request with a DPoP proof of `key`, and once more if the
   * server asks for a nonce: it hands one out with the refusal, and the
   * request was not carried out. `form` is made anew for each try, because
   * what it holds may be good once, as the assertion of a client is.
   */
  async function withProof(
    url: string,
    key: PrivateJwk,
    nonces: Nonces,
    options: Call & { accessToken?: string },
    form?: () => Promise<Record<string, string>>,
  ): Promise<Answer> {
    const { origin } = new URL(url);
    for (let tries = 1; ; tries++) {
      const { method = "GET", accessToken } = options;
      const proof = await dpopProof(key, {
        method,
        url,
        now: now(),
        nonce: nonces.get(origin),
        accessToken,
      });
      const answer = await request(
        url,
        { ...options, ...(form && { form: await form() }) },
        {
          DPoP: proof,
          ...(accessToken && { Authorization: `DPoP ${accessToken}` }),
        },
      );
      const nonce = answer.headers.get("DPoP-Nonce");
      if (nonce) nonces.set(origin, nonce);
      const asked =
        (answer.status === 400 || answer.status === 401) &&
        errorOf(answer) === "use_dpop_nonce";
      if (!asked || !nonce || tries > 1) return answer;
    }
  }

  /** The key of the client named `id`, or undefined if it has none. */
  const keyById = async (id: string) =>
    (await keys()).find((key) => key.id === id);

  /**
   * Posts a form to an endpoint of the authorization server, as the
   * client, with an assertion signed by `keyId` and a proof of `dpopKey`.
   */
  async function asClient(
    session: {
      issuer: string;
      clientId: string;
      keyId: string;
      dpopKey: PrivateJwk;
    },
    endpoint: string,
    params: Record<string, string>,
    secrets: readonly string[],
  ): Promise<Answer> {
    const key = await keyById(session.keyId);
    if (!key) {
      throw new ProviderError(
        "reconnect",
        "pigy no longer has the key that this connection to Bluesky was made with. Connect the account again.",
      );
    }
    return withProof(
      endpoint,
      session.dpopKey,
      new Map(),
      { method: "POST", secrets },
      async () => ({
        ...params,
        client_id: session.clientId,
        client_assertion_type: clientAssertionType,
        client_assertion: await clientAssertion(
          key.privateKey,
          key.id,
          session.clientId,
          session.issuer,
          now(),
        ),
      }),
    );
  }

  /** The DID that `handle` says it belongs to. */
  async function resolveHandle(handle: string): Promise<string> {
    // By the DNS first, which a Worker can ask only over HTTPS: a TXT
    // record of `_atproto.<handle>`.
    const query = `https://${dnsResolver}/dns-query?${new URLSearchParams({ name: `_atproto.${handle}`, type: "TXT" })}`;
    const dns = await request(query, {}, { Accept: "application/dns-json" });
    if (dns.status !== 200) throw failure(dns, {});
    const viaDns = [
      ...new Set(
        didsInAnswer(understood(dnsAnswerSchema, dns.json, dnsResolver)),
      ),
    ];
    if (viaDns.length > 1) {
      throw new ProviderError(
        "fail",
        `The handle ${handle} names more than one account.`,
      );
    }
    if (viaDns[0]) return viaDns[0];
    // Then by the file that the host of the handle serves: the DID, and
    // nothing else.
    const notFound = (options: { status?: number; cause?: unknown }) =>
      new ProviderError(
        "fail",
        `pigy found no Bluesky account with the handle ${handle}.`,
        options,
      );
    const file = await request(
      `https://${handle}/.well-known/atproto-did`,
      {},
      { Accept: "text/plain" },
    ).catch((error: unknown) => {
      // No answer. With nothing in the DNS either, the handle is most
      // likely mistyped. The cause stays, for a caller to tell a host that
      // cannot exist from one that is down.
      if (error instanceof ProviderError && error.kind === "retry") {
        throw notFound({ cause: error });
      }
      throw error;
    });
    const did = file.status === 200 ? file.text.trim() : "";
    if (!did) throw notFound({ status: file.status });
    return did;
  }

  /** The document of `did`. */
  async function didDocument(did: string) {
    const url = didDocumentUrl(did, plcDirectory);
    const document = understood(
      didDocumentSchema,
      await call(url),
      new URL(url).host,
    );
    if (document.id !== did) {
      throw new ProviderError(
        "fail",
        `The document of ${did} is that of another account.`,
      );
    }
    return document;
  }

  /** The authorization server of the accounts of `pds`, and its endpoints. */
  async function authorizationServer(pds: string) {
    const resource = understood(
      resourceSchema,
      await call(`${pds}/.well-known/oauth-protected-resource`),
      new URL(pds).host,
    );
    // Whoever controls the PDS names it, and pigy sends requests there.
    const issuer = publicOrigin(resource.authorization_servers[0]);
    if (!issuer) {
      throw new ProviderError(
        "fail",
        `${new URL(pds).host} names no authorization server that pigy can use.`,
      );
    }
    const server = understood(
      serverSchema,
      await call(`${issuer}/.well-known/oauth-authorization-server`),
      new URL(issuer).host,
    );
    // Where pigy sends the person, the code and the tokens: public hosts
    // alone, as for everything that somebody else names.
    const endpoints = {
      authorization: publicUrl(server.authorization_endpoint),
      token: publicUrl(server.token_endpoint),
      pushed: publicUrl(server.pushed_authorization_request_endpoint),
      revocation:
        server.revocation_endpoint === undefined
          ? null
          : publicUrl(server.revocation_endpoint),
    };
    if (
      // The server has to be the one that the PDS names: the issuer is its
      // origin, RFC 8414 section 3.3.
      server.issuer !== issuer ||
      !endpoints.authorization ||
      !endpoints.token ||
      !endpoints.pushed ||
      (server.revocation_endpoint !== undefined && !endpoints.revocation) ||
      !server.dpop_signing_alg_values_supported.includes("ES256") ||
      !server.token_endpoint_auth_methods_supported.includes(
        "private_key_jwt",
      ) ||
      !server.token_endpoint_auth_signing_alg_values_supported.includes(
        "ES256",
      ) ||
      (server.scopes_supported && !server.scopes_supported.includes("atproto"))
    ) {
      throw new ProviderError(
        "fail",
        `${new URL(issuer).host} is not an authorization server that pigy can use.`,
      );
    }
    return {
      issuer,
      authorizationEndpoint: endpoints.authorization,
      tokenEndpoint: endpoints.token,
      pushedEndpoint: endpoints.pushed,
      revocationEndpoint: endpoints.revocation,
    };
  }

  /**
   * A failure to complete a connection, as the contract wants it: for
   * good. The code of the callback is spent, or may be.
   */
  function forGood(error: unknown): unknown {
    if (!(error instanceof ProviderError) || error.kind === "fail") {
      return error;
    }
    return new ProviderError(
      "fail",
      `${error.message} Connect the account again.`,
      { status: error.status, cause: error },
    );
  }

  /**
   * The tokens in an answer of the token endpoint, for the account `did`.
   * What atproto has a client check: the type of the tokens, that they
   * are the account's, and that they have the scopes that pigy asked for.
   */
  function tokensOf(answer: Answer, did: string, secrets: string[]) {
    if (answer.status !== 200) throw failure(answer, { secrets });
    const tokens = understood(tokenSchema, answer.json, "Bluesky");
    const granted = tokens.scope.split(" ");
    if (tokens.token_type.toLowerCase() !== "dpop") {
      throw new ProviderError(
        "fail",
        "Bluesky gave pigy tokens that are not bound to its key.",
      );
    }
    if (tokens.sub !== did) {
      throw new ProviderError(
        "fail",
        "Bluesky gave pigy the access to another account than the one that was asked for.",
      );
    }
    // GUESS: the server answers with the scopes as they were asked for.
    if (!blueskyScope.split(" ").every((scope) => granted.includes(scope))) {
      throw new ProviderError(
        "fail",
        "Bluesky did not give pigy the access it needs to post.",
      );
    }
    return tokens;
  }

  /** The access that `tokens` give, as a caller keeps it. */
  function accessOf(
    session: Omit<BlueskyCredentials, "accessToken" | "refreshToken">,
    tokens: z.infer<typeof tokenSchema>,
  ) {
    const credentials: BlueskyCredentials = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
    return {
      credentials,
      refreshAt: new Date(now().getTime() + refreshAfterMs),
      // Bluesky does not say when a session ends. A confidential client's
      // may have no end.
      expiresAt: null,
    };
  }

  function parseCredentials(credentials: Json): BlueskyCredentials {
    const parsed = credentialsSchema.safeParse(credentials);
    if (
      !parsed.success ||
      // The servers decide where the tokens are sent.
      publicOrigin(parsed.data.pds) !== parsed.data.pds ||
      publicOrigin(parsed.data.issuer) !== parsed.data.issuer ||
      !parseDid(parsed.data.did)
    ) {
      throw new ProviderError(
        "reconnect",
        "pigy has lost its access to this Bluesky account.",
      );
    }
    return parsed.data;
  }

  /** Calls a method of the HTTP API of the account's PDS, as the account. */
  async function xrpc(
    credentials: BlueskyCredentials,
    nonces: Nonces,
    method: string,
    body: unknown,
  ): Promise<unknown> {
    const { pds, accessToken, dpopKey } = credentials;
    const options: Call = { method: "POST", json: body };
    const answer = await withProof(`${pds}/xrpc/${method}`, dpopKey, nonces, {
      ...options,
      accessToken,
    });
    if (answer.status < 200 || answer.status >= 300) {
      throw failure(answer, options, accessToken);
    }
    return answer.json;
  }

  /**
   * A record of the repository of `did` at `pds`, or null if there is
   * none. Records are public: no token is sent.
   */
  async function getRecord(
    pds: string,
    did: string,
    collection: string,
    rkey: string,
  ) {
    const answer = await request(
      `${pds}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection, rkey })}`,
      {},
    );
    if (answer.status === 400 && errorOf(answer) === "RecordNotFound") {
      return null;
    }
    if (answer.status !== 200) throw failure(answer, {});
    return understood(recordSchema, answer.json, new URL(pds).host);
  }

  /** The name and the picture of an account, from its profile. */
  async function profileOf(did: string, pds: string, handle: string) {
    const record = await getRecord(pds, did, "app.bsky.actor.profile", "self");
    // A new account has no profile yet.
    const profile = profileSchema.safeParse(record?.value).data;
    const avatar = profile?.avatar?.ref.$link;
    return {
      name: profile?.displayName?.trim() || handle,
      // The picture is a blob of the account's repository, which its PDS
      // serves to anybody.
      avatarUrl: avatar
        ? `${pds}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did, cid: avatar })}`
        : null,
    };
  }

  return {
    network: "bluesky",

    async beginConnect({ redirectUri, identifier }) {
      const handle = parseHandle(identifier ?? "");
      if (!handle) {
        throw new ProviderError(
          "fail",
          "Enter the handle of your Bluesky account, such as alice.bsky.social.",
        );
      }
      const [key] = await keys();
      if (!key) {
        throw new ProviderError(
          "fail",
          "This pigy has no key to sign its requests to Bluesky with.",
        );
      }
      const resolved = await resolveHandle(handle);
      const did = parseDid(resolved);
      if (!did) {
        throw new ProviderError(
          "fail",
          `The handle ${handle} names an account of a kind that pigy does not know.`,
        );
      }
      const document = await didDocument(did);
      // A handle is the account's only if the account claims it in turn.
      if (!claims(document, handle)) {
        throw new ProviderError(
          "fail",
          `The account that ${handle} names does not claim that handle.`,
        );
      }
      const pds = pdsOf(document);
      if (!pds) {
        throw new ProviderError(
          "fail",
          `The account ${handle} names no server that pigy can post to.`,
        );
      }
      const server = await authorizationServer(pds);
      const { issuer } = server;

      const state = randomToken();
      const code = await pkce();
      const dpopKey = await newKey();
      const clientId = clientIdFor(redirectUri);
      const session = { issuer, clientId, keyId: key.id, dpopKey };
      const answer = await asClient(
        session,
        server.pushedEndpoint,
        {
          response_type: "code",
          redirect_uri: redirectUri,
          scope: blueskyScope,
          state,
          code_challenge: code.challenge,
          code_challenge_method: "S256",
          // The account that was resolved: the server signs in no other.
          login_hint: handle,
        },
        [],
      );
      if (answer.status !== 201 && answer.status !== 200) {
        throw failure(answer, {});
      }
      const pushed = understood(pushedSchema, answer.json, "Bluesky");
      const url = new URL(server.authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        request_uri: pushed.request_uri,
      }).toString();

      const pending: Pending = {
        state,
        handle,
        did,
        pds,
        issuer,
        tokenEndpoint: server.tokenEndpoint,
        revocationEndpoint: server.revocationEndpoint,
        redirectUri,
        clientId,
        keyId: key.id,
        codeVerifier: code.verifier,
        dpopKey,
      };
      return { url: url.href, state, pending };
    },

    async completeConnect({ pending, params }) {
      const flow = pendingSchema.safeParse(pending).data;
      // The state ties the callback to the browser that began. Without the
      // match, nothing else in the callback can be believed.
      if (!flow || params.get("state") !== flow.state) {
        throw new ProviderError(
          "fail",
          "This is not the answer to a connection that pigy began. Start again.",
        );
      }
      const error = params.get("error");
      if (error === "access_denied") {
        throw new ProviderError("fail", "The connection was declined.", {
          declined: true,
        });
      }
      const code = params.get("code");
      // What the callback says is the word of whoever sent the browser
      // back, and may repeat what the connection is made with.
      const secrets = [
        flow.state,
        flow.codeVerifier,
        flow.dpopKey.d,
        ...(code ? [code] : []),
      ];
      if (error || !code) {
        const said = quotable(
          params.get("error_description") ?? error ?? "",
          secrets,
        );
        throw new ProviderError(
          "fail",
          `Bluesky did not connect the account${said ? `: ${said}` : "."}`,
        );
      }
      // RFC 9207: the callback names the server that answered. One that
      // names another may be an answer of that other server, sent to pigy
      // to have its code redeemed here.
      if (params.get("iss") !== flow.issuer) {
        throw new ProviderError(
          "fail",
          "The answer of Bluesky does not come from the server that pigy asked.",
        );
      }

      // From here on the code is spent, or may be: every failure is for
      // good, and the person begins again.
      try {
        const answer = await asClient(
          flow,
          flow.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: flow.redirectUri,
            code_verifier: flow.codeVerifier,
          },
          secrets,
        );
        const tokens = tokensOf(answer, flow.did, secrets);
        // The account was resolved when the connection began, minutes
        // ago, which the specification allows as a cache: it has a client
        // keep what it resolved for an authorization for less than ten
        // minutes, and a connection that has begun is kept for ten.
        const profile = await profileOf(flow.did, flow.pds, flow.handle);
        const { access } = {
          access: accessOf(
            {
              did: flow.did,
              pds: flow.pds,
              issuer: flow.issuer,
              tokenEndpoint: flow.tokenEndpoint,
              revocationEndpoint: flow.revocationEndpoint,
              clientId: flow.clientId,
              keyId: flow.keyId,
              dpopKey: flow.dpopKey,
            },
            tokens,
          ),
        };
        return {
          account: {
            // The DID is the account. The handle can change.
            id: flow.did,
            handle: `@${flow.handle}`,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            profileUrl: `https://bsky.app/profile/${flow.did}`,
          },
          access,
        };
      } catch (failed) {
        throw forGood(failed);
      }
    },

    async refresh(credentials) {
      const session = parseCredentials(credentials);
      const secrets = [
        session.accessToken,
        session.refreshToken,
        session.dpopKey.d,
      ];
      const answer = await asClient(
        session,
        session.tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: session.refreshToken },
        secrets,
      );
      if (answer.status !== 200) {
        const error = errorOf(answer);
        // RFC 6749 section 5.2: the refresh token is invalid, has expired,
        // was revoked or was issued to another client. The server will not
        // renew: the session was revoked, it has ended, the refresh token
        // was used before, or the key of the client that it is bound to is
        // gone. Only a new connection helps. Every other refusal leaves the
        // refresh token as it was.
        if (error === "invalid_grant") {
          throw new ProviderError(
            "reconnect",
            "Bluesky no longer renews pigy's access to this account. Connect it again.",
            { status: answer.status },
          );
        }
        // The session was begun with pigy's client metadata, so the server
        // could read it then. That it cannot now is most likely a reading
        // that failed, which can be over a moment later.
        if (error === "invalid_client_metadata") {
          throw new ProviderError(
            "retry",
            "Bluesky could not read pigy's client metadata.",
            { status: answer.status },
          );
        }
      }
      const tokens = tokensOf(answer, session.did, secrets);
      const { accessToken: _, refreshToken: __, ...rest } = session;
      return accessOf(rest, tokens);
    },

    async disconnect(credentials) {
      const session = parseCredentials(credentials);
      if (!session.revocationEndpoint) {
        throw new ProviderError(
          "fail",
          `${new URL(session.issuer).host} has no way for pigy to give the access back.`,
        );
      }
      const secrets = [session.accessToken, session.refreshToken];
      // The refresh token stands for the whole session: revoking it ends
      // the access tokens of the session too, RFC 7009 section 2.1.
      const answer = await asClient(
        session,
        session.revocationEndpoint,
        { token: session.refreshToken, token_type_hint: "refresh_token" },
        secrets,
      );
      if (answer.status !== 200) throw failure(answer, { secrets });
    },

    async limits(credentials): Promise<Limits> {
      // The same for every account: the schema of a post sets them.
      parseCredentials(credentials);
      return {
        network: "bluesky",
        maxCharacters: blueskyMaxCharacters,
        maxBytes: blueskyMaxBytes,
      };
    },

    async publishStep({ credentials, content, progress }) {
      const access = parseCredentials(credentials);
      const recorded =
        progress === null ? null : publishProgressSchema.safeParse(progress);
      const state = recorded?.data?.state ?? null;
      const noted = state === null ? null : notesSchema.safeParse(state).data;
      if ((recorded && !recorded.success) || noted === undefined) {
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }
      const notes: Notes = noted ?? { did: access.did, rkey: null, refs: [] };
      // The parts that are published are on the account that the post was
      // begun on. Credentials of another account, connected since, would
      // write the rest of the thread elsewhere.
      if (notes.did !== access.did) {
        throw new ProviderError(
          "fail",
          "The channel is connected to another Bluesky account than the one this post was begun on.",
        );
      }
      const parts = recorded?.data.parts ?? [];
      const stepped = (
        published: PublishProgress["parts"],
        next: Notes,
      ): PublishProgress => ({
        parts: published,
        done: published.length >= content.parts.length,
        waitSeconds: 0,
        state: next,
      });
      const index = parts.length;
      const part = content.parts[index];
      if (!part || notes.refs.length !== index) {
        if (!part) return stepped(parts, notes);
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }

      // Two steps for each part. The first chooses the key of its record
      // and sends nothing, so that the key is recorded before anything is
      // written under it.
      if (notes.rkey === null) {
        const before = notes.refs.at(-1);
        return stepped(parts, {
          ...notes,
          rkey: newTid(now(), before && parseRecordUri(before.uri)?.rkey),
        });
      }

      // The second writes the record under that key, unless it is there:
      // a run of this step before may have written it and lost the
      // answer, a moment or days ago. Writing under a key that has a
      // record is refused, but in no way that is documented, so the step
      // looks first. Nobody else writes under a key that pigy has made up.
      const { rkey } = notes;
      const uri = `at://${access.did}/${postCollection}/${rkey}`;
      const [root, parent] = [notes.refs[0], notes.refs.at(-1)];
      const found = await getRecord(
        access.pds,
        access.did,
        postCollection,
        rkey,
      );
      let reference: z.infer<typeof referenceSchema>;
      if (found) {
        // A record that says something else is not this part's.
        const post = postSchema.safeParse(found.value).data;
        if (
          post?.text !== part.text ||
          (post.reply?.parent.uri ?? null) !== (parent?.uri ?? null)
        ) {
          throw new ProviderError(
            "fail",
            "Bluesky has another post under the key that pigy chose for this one.",
          );
        }
        reference = { uri, cid: found.cid };
      } else {
        const nonces: Nonces = new Map();
        const written = understood(
          writtenSchema,
          await xrpc(access, nonces, "com.atproto.repo.createRecord", {
            repo: access.did,
            collection: postCollection,
            rkey,
            record: {
              $type: postCollection,
              text: part.text,
              // When it is written. A step that is run again does not
              // write the same record a second time, it finds the first,
              // so this need not be recorded before.
              createdAt: now().toISOString(),
              ...(root && parent && { reply: { root, parent } }),
            },
          }),
          "Bluesky",
        );
        if (written.uri !== uri) {
          throw new ProviderError(
            "fail",
            "Bluesky wrote the post under another key than pigy chose.",
          );
        }
        reference = { uri, cid: written.cid };
      }
      return stepped([...parts, { id: uri, url: postUrl(access.did, rkey) }], {
        ...notes,
        rkey: null,
        refs: [...notes.refs, reference],
      });
    },

    async readPost(credentials, id) {
      const { pds, did } = parseCredentials(credentials);
      const record = parseRecordUri(id);
      if (!record || record.did !== did) return null;
      const found = await getRecord(pds, did, record.collection, record.rkey);
      const post = postSchema.safeParse(found?.value).data;
      if (!post) return null;
      return {
        id,
        url: postUrl(did, record.rkey),
        text: post.text,
        replyToId: post.reply?.parent.uri ?? null,
      };
    },

    async deletePost(credentials, id) {
      const access = parseCredentials(credentials);
      const record = parseRecordUri(id);
      if (!record || record.did !== access.did) {
        throw new ProviderError(
          "fail",
          "This is not a post of the account that pigy can delete.",
        );
      }
      // "Delete a repository record, or ensure it doesn't exist": a post
      // that is gone is fine.
      await xrpc(access, new Map(), "com.atproto.repo.deleteRecord", {
        repo: access.did,
        collection: record.collection,
        rkey: record.rkey,
      });
    },
  };
}
