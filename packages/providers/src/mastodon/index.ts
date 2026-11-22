import {
  type Clock,
  comparableMastodonText,
  defaultMediaLimits,
  type Fetch,
  imageTypes,
  type Limits,
} from "@pigy/core";
import { z } from "zod";
import { forGood, ProviderError, quotable, understanding } from "../errors.ts";
import {
  base64Url,
  type HttpAnswer,
  httpsUrl,
  randomToken,
  retryAfter,
  send,
  sha256,
} from "../http.ts";
import {
  type Json,
  type Provider,
  type PublishProgress,
  publishProgressSchema,
} from "../provider.ts";
import { parseInstanceDomain } from "./domain.ts";
import { htmlToText } from "./html.ts";

export { parseInstanceDomain } from "./domain.ts";

/**
 * The adapter for Mastodon, written from https://docs.joinmastodon.org:
 * methods/apps, methods/oauth, methods/instance, methods/accounts,
 * methods/statuses, api/rate-limits and entities/Error. How Mastodon
 * treats a repeated request is from its code,
 * app/services/post_status_service.rb.
 *
 * Mastodon is many servers. An account lives on one, its instance, and
 * every request goes to that instance. pigy is not known to an instance
 * until it registers itself there, which it does the first time somebody
 * connects an account of that instance. Text only so far: no media.
 */

/** pigy as an instance knows it: the OAuth client it registered there. */
const appSchema = z.strictObject({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** The redirect address it was registered with. It works with no other. */
  redirectUri: z.string().min(1),
  /** The scopes it was registered with. It can ask for no others. */
  scopes: z.array(z.string().min(1)),
});

export type MastodonApp = z.infer<typeof appSchema>;

/**
 * Where the registrations are kept, one per instance, for all users: an
 * instance should be asked once, not for every person who connects. The
 * client secret in it is a secret.
 *
 * It is a cache and nothing depends on it being right. A registration that
 * is missing, unreadable or no longer known to the instance is replaced by
 * a new one. A connection in progress and the credentials of an account
 * carry the registration they were made with, so they go on working when
 * the stored one changes.
 */
export type MastodonAppStore = {
  /** What was last put for `domain`, or undefined. */
  get(domain: string): Promise<unknown>;
  put(domain: string, app: MastodonApp): Promise<void>;
};

/** Who can see a post, in Mastodon's terms. */
export type MastodonVisibility = "public" | "unlisted" | "private" | "direct";

export type MastodonProviderOptions = {
  fetch: Fetch;
  now: Clock;
  apps: MastodonAppStore;
  /** What pigy is called on the consent page and under its posts. */
  clientName: string;
  /**
   * Who can see what is posted. Left out, each account's own default
   * applies, which is what a cross-poster should respect: the first step
   * of a post reads it, and every part is posted with it. The live
   * conformance run sets it, to keep its posts out of public timelines.
   */
  visibility?: MastodonVisibility;
  /** How long to wait for an instance to answer. 30 seconds by default. */
  timeoutMs?: number;
};

/** What a channel on Mastodon is reached with. */
const credentialsSchema = z.strictObject({
  domain: z.string().min(1),
  accessToken: z.string().min(1),
  // Of the registration the token was issued to. Revoking the token takes
  // both, also when the stored registration has changed since.
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export type MastodonCredentials = z.infer<typeof credentialsSchema>;

const pendingSchema = z.strictObject({
  state: z.string().min(1),
  domain: z.string().min(1),
  /** The domain in the handles of the instance's accounts. */
  handleDomain: z.string().min(1),
  redirectUri: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Null where the instance has no PKCE. */
  codeVerifier: z.string().min(1).nullable(),
  scopes: z.array(z.string().min(1)),
});

// What pigy reads of Mastodon's answers. Everything else is ignored, so a
// newer or a related server with more fields is fine.

/** entities/Instance, from 4.0 on. */
const instanceSchema = z.object({
  domain: z.string().min(1),
  configuration: z.object({
    statuses: z.object({
      max_characters: z.number().int().positive(),
      characters_reserved_per_url: z.number().int().nonnegative(),
      max_media_attachments: z.number().int().positive().optional(),
    }),
    // What the instance takes of media. A server that says nothing of
    // it, or says it another way, is posted to with what Mastodon ships
    // with: `defaultMediaLimits` of @pigy/core.
    media_attachments: z
      .object({
        supported_mime_types: z.array(z.string()),
        image_size_limit: z.number().int().positive(),
        image_matrix_limit: z.number().int().positive(),
        // From 4.4 on.
        description_limit: z.number().int().positive().optional(),
      })
      .optional()
      .catch(undefined),
  }),
});

/** RFC 8414 metadata, from 4.3 on. */
const oauthMetadataSchema = z.object({
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

/** entities/Application, as a registration returns it. */
const registrationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

/** entities/Token. */
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string(),
});

/** entities/Account. */
const accountSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  display_name: z.string().nullish(),
  avatar: z.unknown(),
  url: z.unknown(),
});

/**
 * entities/CredentialAccount: an account as its own token sees it, with
 * what decides who sees its statuses.
 */
const ownAccountSchema = accountSchema.extend({
  /** There, and true, only when moderators have limited the account. */
  limited: z.boolean().optional(),
  /** The visibility of a status that names none: the person's setting. */
  source: z.object({ privacy: z.string().min(1) }),
});

/** entities/MediaAttachment, as far as pigy reads it. */
const mediaSchema = z.object({
  id: z.string().min(1),
  /** Null while the instance works on the file. */
  url: z.string().nullish(),
  description: z.string().nullish(),
});

/** entities/Status. */
const statusSchema = z.object({
  id: z.string().min(1),
  url: z.unknown(),
  uri: z.unknown(),
  content: z.string(),
  in_reply_to_id: z.string().nullish(),
  media_attachments: z.array(mediaSchema).optional(),
});

/**
 * entities/Status in a list, with what a status can have besides its text.
 * A list that leaves any of it open is not understood, and nothing is
 * taken from it or posted after it.
 */
const listedStatusSchema = statusSchema.extend({
  visibility: z.string(),
  /** Empty where there is no content warning. */
  spoiler_text: z.string(),
  media_attachments: z.array(mediaSchema),
  // Null or left out where there is none. Mastodon has quotes from 4.5 on.
  poll: z.unknown().optional(),
  quote: z.unknown().optional(),
});

/** entities/StatusSource. */
const sourceSchema = z.object({ text: z.string() });

/**
 * What a step of a post notes for the steps after it. It is stored with the
 * progress, as it is, so there is no secret in it.
 */
const notesSchema = z.strictObject({
  /** The account that posts, by its ID on the instance. */
  accountId: z.string().min(1),
  /**
   * The status after which the next part is looked for, or null if the
   * account had none: none of the account's statuses up to this one is the
   * next part. It starts as the newest status that the account had before
   * anything was sent, and moves on to each part that is published.
   */
  after: z.string().min(1).nullable(),
  /**
   * Who sees the parts, in the instance's terms, settled before anything
   * is sent: every part is posted with it, and no status with another is
   * taken for a part.
   */
  visibility: z.string().min(1),
  /**
   * The domains of the instance itself: the one it is reached at and the
   * one in the handles of its accounts. A mention that names one of them
   * is saved without it.
   */
  ownDomains: z.array(z.string().min(1)),
  /**
   * The images that were uploaded for the part that is next, by the
   * instance's IDs of them, in the order of the part: recorded image by
   * image, before the status that names them is posted. Left out by a
   * part without images, and by notes from before pigy posted any.
   */
  media: z
    .strictObject({
      /** Which part they are for, counted from 0. */
      part: z.number().int().nonnegative(),
      ids: z.array(z.string().min(1)),
    })
    .optional(),
});

type Notes = z.infer<typeof notesSchema>;

// The most statuses that Mastodon lists in one answer.
const listLength = 40;

// What pigy asks an account for, besides seeing who it is. `write:media`
// is for the images of a post.
const postingScopes = ["read:statuses", "write:statuses", "write:media"];

// What Mastodon says, in English whatever the language of the instance,
// when a token lacks the scope for a request.
const outsideScopes = "This action is outside the authorized scopes";

// How long a step waits for an instance that still works on a file,
// before it asks again, in seconds.
const mediaWaitSeconds = 2;

// Far above any answer that pigy reads. The largest is the description of
// an instance, with its rules in many languages.
const maxBytes = 1024 * 1024;

type Call = {
  method?: "GET" | "POST" | "DELETE";
  /** The access token of an account, for a request made in its name. */
  token?: string;
  /** A body, as JSON. */
  json?: unknown;
  /** A body, as a form. OAuth takes its parameters this way. */
  form?: Record<string, string>;
  /** A body in several parts, one of them a file: an upload. */
  upload?: FormData;
  headers?: Record<string, string>;
  /** What the request carries that must not show up in a message. */
  secrets?: readonly string[];
};

/**
 * The time in an `X-RateLimit-Reset` header, or undefined. Mastodon writes
 * it with six digits after the second, which is more than every runtime
 * reads.
 */
function rateLimitReset(headers: Headers): Date | undefined {
  const value = headers.get("X-RateLimit-Reset");
  if (!value) return undefined;
  const date = new Date(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Whether the status with the ID `id` is newer than the one with the ID
 * `other`. Mastodon's IDs are numbers that grow with time, written as
 * strings of any length. They are compared as its documentation says,
 * api/guidelines: the longer one is the greater, and of two that are
 * equally long, the one that sorts later.
 */
function isNewer(id: string, other: string): boolean {
  return id.length > other.length || (id.length === other.length && id > other);
}

/** `value` as `schema` describes it. Throws if the instance sent other. */
const understood = understanding(
  (domain) => `${domain} did not answer the way a Mastodon server does.`,
);

export function createMastodonProvider({
  fetch,
  now,
  apps,
  clientName,
  visibility,
  timeoutMs = 30_000,
}: MastodonProviderOptions): Provider {
  /** Sends a request to an instance and returns the answer as it is. */
  function request(
    domain: string,
    path: string,
    { method = "GET", token, json, form, upload, headers }: Call,
  ): Promise<HttpAnswer> {
    return send(
      fetch,
      domain,
      `https://${domain}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
          ...(json !== undefined && { "Content-Type": "application/json" }),
          ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...headers,
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        ...(form && { body: new URLSearchParams(form).toString() }),
        // Without a type of its own: the runtime writes it, with the
        // boundary between the parts.
        ...(upload && { body: upload }),
      },
      { timeoutMs, maxBytes },
    );
  }

  /** What an answer that is not a success means for the caller. */
  function failure(
    domain: string,
    { status, headers, json }: HttpAnswer,
    { token, secrets = [] }: Call,
  ): ProviderError {
    const body = z
      .object({
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .safeParse(json);
    const { error, error_description: description } = body.data ?? {};
    const said = quotable(description ?? error ?? "", [
      ...secrets,
      ...(token ? [token] : []),
    ]);

    if (status === 429) {
      return new ProviderError(
        "retry",
        `${domain} is limiting how often pigy may ask.`,
        {
          status,
          retryAt: rateLimitReset(headers) ?? retryAfter(headers, now()),
        },
      );
    }
    if (status >= 500) {
      return new ProviderError(
        "retry",
        `${domain} is having trouble (HTTP ${status}).`,
        { status, retryAt: retryAfter(headers, now()) },
      );
    }
    // Only an answer to the account's own token says anything about the
    // account's access. A 401 for a request without one is about the
    // request.
    if (
      token &&
      (status === 401 || (status === 403 && error === outsideScopes))
    ) {
      return new ProviderError(
        "reconnect",
        `${domain} no longer accepts the access that pigy was given to this account.`,
        { status },
      );
    }
    return new ProviderError(
      "fail",
      said
        ? `${domain} refused the request: ${said}`
        : `${domain} refused the request (HTTP ${status}).`,
      { status },
    );
  }

  /** The JSON that an instance answers a request with. Throws otherwise. */
  async function call(domain: string, path: string, options: Call = {}) {
    const answer = await request(domain, path, options);
    if (answer.status < 200 || answer.status >= 300) {
      throw failure(domain, answer, options);
    }
    return answer.json;
  }

  /**
   * The image of a part as the instance has it, or null if it has none
   * under this ID: methods/media, "Get media attachment". An image that
   * is in no status is deleted after a while, and one that is in a status
   * is not found here either.
   */
  async function readMedia(
    { domain, accessToken }: MastodonCredentials,
    id: string,
  ): Promise<{ ready: boolean } | null> {
    const answer = await request(
      domain,
      `/api/v1/media/${encodeURIComponent(id)}`,
      { token: accessToken },
    );
    if (answer.status === 404) return null;
    // 206 while the instance works on the file.
    if (answer.status !== 200 && answer.status !== 206) {
      throw failure(domain, answer, { token: accessToken });
    }
    const media = understood(mediaSchema, answer.json, domain);
    return { ready: answer.status === 200 && typeof media.url === "string" };
  }

  async function readInstance(domain: string, token?: string) {
    try {
      return understood(
        instanceSchema,
        // The token is for instances that answer nobody without one.
        await call(domain, "/api/v2/instance", token ? { token } : {}),
        domain,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) {
        throw new ProviderError(
          "fail",
          `${domain} is not a Mastodon server that pigy can post to. It takes Mastodon 4.0 or later.`,
          { status: 404 },
        );
      }
      throw error;
    }
  }

  /**
   * What the instance says about its OAuth, or null if it says nothing,
   * as Mastodon before 4.3.
   */
  async function readOAuthMetadata(domain: string) {
    const answer = await request(
      domain,
      "/.well-known/oauth-authorization-server",
      {},
    );
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw failure(domain, answer, {});
    return oauthMetadataSchema.safeParse(answer.json).data ?? null;
  }

  /**
   * Whether the instance still knows a registration. Mastodon before 4.3
   * removed registrations that nobody used, and an admin can remove one.
   * It is asked with a token request of the client's own, which is also
   * what kept those older versions from removing it.
   */
  async function isKnown(domain: string, app: MastodonApp): Promise<boolean> {
    const options: Call = {
      method: "POST",
      form: {
        grant_type: "client_credentials",
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: app.redirectUri,
        // Named, because the default is a scope that pigy does not
        // register.
        scope: "read:statuses",
      },
      secrets: [app.clientSecret],
    };
    const answer = await request(domain, "/oauth/token", options);
    if (answer.status >= 200 && answer.status < 300) return true;
    const error = failure(domain, answer, options);
    if (error.kind === "retry") throw error;
    // Only this answer says that the client is gone. Any other refusal says
    // nothing about the registration: a server that gives no such tokens
    // can still know the client.
    const refusal = z.object({ error: z.string() }).safeParse(answer.json);
    return refusal.data?.error !== "invalid_client";
  }

  /** The registration to connect with, made now if there is none to use. */
  async function appFor(
    domain: string,
    redirectUri: string,
    scopes: string[],
  ): Promise<MastodonApp> {
    const stored = appSchema.safeParse(await apps.get(domain)).data;
    if (
      stored &&
      stored.redirectUri === redirectUri &&
      scopes.every((scope) => stored.scopes.includes(scope)) &&
      (await isKnown(domain, stored))
    ) {
      return stored;
    }
    const registration = understood(
      registrationSchema,
      await call(domain, "/api/v1/apps", {
        method: "POST",
        json: {
          client_name: clientName,
          // One address, as a string: a list is only understood from 4.3 on.
          redirect_uris: redirectUri,
          scopes: scopes.join(" "),
          website: new URL(redirectUri).origin,
        },
      }),
      domain,
    );
    const app: MastodonApp = {
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      redirectUri,
      scopes,
    };
    if (!(await isKnown(domain, app))) {
      throw new ProviderError(
        "fail",
        `${domain} does not accept the registration it has just given pigy.`,
      );
    }
    await apps.put(domain, app);
    return app;
  }

  /** Statuses of an account, newest first: methods/accounts, "statuses". */
  async function listStatuses(
    { domain, accessToken }: MastodonCredentials,
    accountId: string,
    query: Record<string, string>,
  ) {
    return understood(
      z.array(listedStatusSchema),
      await call(
        domain,
        `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${new URLSearchParams(query)}`,
        { token: accessToken },
      ),
      domain,
    );
  }

  /** The text of a status as it was written, or null if the status is gone. */
  async function sourceText(
    { domain, accessToken }: MastodonCredentials,
    id: string,
  ): Promise<string | null> {
    try {
      return understood(
        sourceSchema,
        await call(
          domain,
          `/api/v1/statuses/${encodeURIComponent(id)}/source`,
          {
            token: accessToken,
          },
        ),
        domain,
      ).text;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Looks for the status that an earlier run of a step has posted for a
   * part. A step does this before it posts, because it cannot know whether
   * it is the first run: an earlier one may have posted the part and lost
   * the answer.
   *
   * The status is the one that fits in everything a step sends:
   *
   * - It is the account's own, and newer than what the notes name: the
   *   part before this one, or for the first part the newest status that
   *   the account had before anything was sent. So nothing from before
   *   this delivery is taken for it, however alike.
   * - It replies to the part before this one, or to nothing if this is the
   *   first.
   * - It is seen by whom the notes say, which is what every part is posted
   *   with. A status for the account alone is not the post that everybody
   *   was to see.
   * - It has nothing besides its text and its images: no poll, no quote
   *   and no content warning, because a step posts none of them. And it
   *   has the images of its part, which are the very files that the steps
   *   before uploaded: the instance gave each an ID, the notes have them,
   *   and a file is in one status. A status with other images, or with
   *   none where the part has some, is not the part.
   * - Its text is the text of the part. That takes the source of the
   *   status: its HTML is not the text, a mention has no domain there. The
   *   source is not the text that was sent either. Mastodon writes every
   *   mention of an account that it finds the way the account is written,
   *   and which accounts it finds, only the server knows. So the two are
   *   compared in the form of `comparableMastodonText`, in which the case
   *   of a mention does not count, and neither does the domain of one that
   *   names the instance itself.
   *
   * That comparison lets in a status which differs from the part in the
   * case of a mention, or in naming the instance where the part does not,
   * "@ada" for "@Ada@mastodon.example" on mastodon.example, and in nothing
   * else. Both are the same account. A mention of the same name on another
   * instance is somebody else, and such a status is not taken.
   *
   * So a status that reads differently, stands elsewhere, is seen by
   * others or has more than text is never taken for the one that is looked
   * for. What can be taken for it is a status that is the same in all of
   * that and newer than this delivery. The caller runs the deliveries to
   * an account one after the other, as the contract of `publishStep` asks,
   * so that is no post of another delivery: the person has posted the same
   * since, by hand or with another app. Posting next to that would make
   * two statuses that nobody can tell apart, so taking it is right.
   *
   * It holds only under that rule. Two deliveries that begin together with
   * the same first part note the same status, and the second takes the
   * first part of the other for its own: it replies to it, and deleting
   * either delivery deletes it. A status says nothing of the request that
   * made it, so nothing here can tell the two apart. Only a first part is
   * at stake. A later one replies to the part before it, which no other
   * delivery has.
   *
   * Not found is a status that somebody has edited or deleted since. The
   * part is then posted again.
   *
   * One call reads one list of statuses. It returns the status, or the
   * status up to which it has looked in vain, or null when there is
   * nothing left to look at.
   */
  async function findPosted(
    credentials: MastodonCredentials,
    { accountId, after, visibility, ownDomains }: Notes,
    replyTo: string | null,
    text: string,
    /** The IDs of the images that the part was uploaded as, in order. */
    mediaIds: readonly string[],
  ) {
    const wanted = comparableMastodonText(text, ownDomains);
    // `min_id` lists the statuses that follow one, where `since_id` would
    // list the newest. "0" is below every ID: the account had no status.
    const cursor = after ?? "0";
    const statuses = await listStatuses(credentials, accountId, {
      min_id: cursor,
      limit: String(listLength),
      exclude_reblogs: "true",
    });
    // Mastodon lists what follows `after`, and nothing else. A server that
    // does not know `min_id` lists the account's newest statuses whatever
    // it is asked, among them those from before the post. Those are never
    // looked at: one of them could read like the part.
    const newer = statuses
      .filter(({ id }) => after === null || isNewer(id, after))
      .sort((a, b) => (isNewer(a.id, b.id) ? 1 : -1));
    const newest = newer.at(-1);
    // The end: nothing is newer than what has been looked at.
    if (!newest) return null;
    for (const status of newer) {
      if (
        (status.in_reply_to_id ?? null) !== replyTo ||
        status.visibility !== visibility ||
        status.spoiler_text !== "" ||
        status.media_attachments.length !== mediaIds.length ||
        status.media_attachments.some(({ id }, at) => id !== mediaIds[at]) ||
        (status.poll ?? null) !== null ||
        (status.quote ?? null) !== null
      ) {
        continue;
      }
      const source = await sourceText(credentials, status.id);
      if (
        source !== null &&
        comparableMastodonText(source, ownDomains) === wanted
      ) {
        return { status };
      }
    }
    return { lookedUpTo: newest.id };
  }

  function parseCredentials(credentials: Json): MastodonCredentials {
    const parsed = credentialsSchema.safeParse(credentials);
    if (
      !parsed.success ||
      // The domain decides where the token is sent.
      parseInstanceDomain(parsed.data.domain) !== parsed.data.domain
    ) {
      throw new ProviderError(
        "reconnect",
        "pigy has lost its access to this Mastodon account.",
      );
    }
    return parsed.data;
  }

  return {
    network: "mastodon",
    // A step looks for its status among what the account has posted since
    // the delivery began: `publishStep`. A status of another delivery
    // that reads the same is among them.
    tellsDeliveriesApart: false,
    // Mastodon gives out the token that the account has with the same
    // registration and scopes already, to every connection: `disconnect`
    // revokes that one token, under all of them.
    accessPerConnection: false,
    // A step that is run again looks for what the run before it has
    // published, and takes that: `publishStep`.
    repeatsSafely: true,

    async beginConnect({ redirectUri, identifier }) {
      const domain = parseInstanceDomain(identifier ?? "");
      if (!domain) {
        throw new ProviderError(
          "fail",
          "Enter the address of your Mastodon server, such as mastodon.social.",
        );
      }
      // Asked first, to tell a person who mistyped before sending them
      // anywhere.
      const instance = await readInstance(domain);
      const oauth = await readOAuthMetadata(domain);
      const scopes = [
        // The narrowest scope that says who the account is. Older servers
        // have only the wider one.
        oauth?.scopes_supported?.includes("profile")
          ? "profile"
          : "read:accounts",
        ...postingScopes,
      ];
      const app = await appFor(domain, redirectUri, scopes);

      const state = randomToken();
      const codeVerifier = oauth?.code_challenge_methods_supported?.includes(
        "S256",
      )
        ? randomToken()
        : null;
      const url = new URL(`https://${domain}/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: app.clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        ...(codeVerifier && {
          code_challenge: base64Url(await sha256(codeVerifier)),
          code_challenge_method: "S256",
        }),
      }).toString();

      const pending: z.infer<typeof pendingSchema> = {
        state,
        domain,
        // The instance may write its accounts with another domain than the
        // one it is reached at.
        handleDomain: parseInstanceDomain(instance.domain) ?? domain,
        redirectUri,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        codeVerifier,
        scopes,
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
      const { domain, clientId, clientSecret, codeVerifier } = flow;
      const error = params.get("error");
      if (error === "access_denied") {
        throw new ProviderError(
          "fail",
          `The connection was declined at ${domain}.`,
          { declined: true },
        );
      }
      const code = params.get("code");
      if (error || !code) {
        // The callback is the word of whoever sent the browser back, and
        // may repeat what the connection is made with. Its state is part
        // of that: it is what the callback was believed for.
        const said = quotable(params.get("error_description") ?? error ?? "", [
          clientSecret,
          flow.state,
          ...(codeVerifier ? [codeVerifier] : []),
          ...(code ? [code] : []),
        ]);
        throw new ProviderError(
          "fail",
          `${domain} did not connect the account${said ? `: ${said}` : "."}`,
        );
      }

      // From here on the code is spent, or may be: every failure is for
      // good, and the person begins again.
      try {
        const token = understood(
          tokenSchema,
          await call(domain, "/oauth/token", {
            method: "POST",
            form: {
              grant_type: "authorization_code",
              code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: flow.redirectUri,
              ...(codeVerifier && { code_verifier: codeVerifier }),
            },
            secrets: [
              clientSecret,
              code,
              ...(codeVerifier ? [codeVerifier] : []),
            ],
          }),
          domain,
        );
        const granted = token.scope.split(" ");
        if (
          token.token_type.toLowerCase() !== "bearer" ||
          // A scope is also granted by the one above it: "write" for
          // "write:statuses".
          !flow.scopes.every(
            (scope) =>
              granted.includes(scope) ||
              granted.includes(scope.split(":")[0] ?? ""),
          )
        ) {
          throw new ProviderError(
            "fail",
            `${domain} did not give pigy the access it needs to post.`,
          );
        }

        const account = understood(
          accountSchema,
          await call(domain, "/api/v1/accounts/verify_credentials", {
            token: token.access_token,
          }),
          domain,
        );
        const credentials: MastodonCredentials = {
          domain,
          accessToken: token.access_token,
          clientId,
          clientSecret,
        };
        return {
          account: {
            // Mastodon's IDs are unique within an instance only.
            id: `${account.id}@${domain}`,
            handle: `@${account.username}@${flow.handleDomain}`,
            name: account.display_name || account.username,
            avatarUrl: httpsUrl(account.avatar),
            profileUrl: httpsUrl(account.url),
          },
          // A token of Mastodon's lasts until somebody revokes it.
          access: { credentials, refreshAt: null, expiresAt: null },
        };
      } catch (failure) {
        throw forGood(failure);
      }
    },

    async disconnect(credentials) {
      const { domain, accessToken, clientId, clientSecret } =
        parseCredentials(credentials);
      await call(domain, "/oauth/revoke", {
        method: "POST",
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          token: accessToken,
        },
        secrets: [clientSecret, accessToken],
      });
    },

    async limits(credentials): Promise<Limits> {
      const { domain, accessToken } = parseCredentials(credentials);
      const { statuses, media_attachments: media } = (
        await readInstance(domain, accessToken)
      ).configuration;
      const types = imageTypes.filter((type) =>
        media?.supported_mime_types.includes(type),
      );
      const shipped = defaultMediaLimits.mastodon;
      return {
        network: "mastodon",
        maxCharacters: statuses.max_characters,
        charactersPerUrl: statuses.characters_reserved_per_url,
        // Only where the instance says what it takes, and takes a JPEG,
        // which is what pigy makes of an image that it does not take.
        ...(media &&
          types.includes("image/jpeg") && {
            media: {
              maxImages: statuses.max_media_attachments ?? shipped.maxImages,
              maxImageBytes: media.image_size_limit,
              maxImagePixels: media.image_matrix_limit,
              imageTypes: types,
              // A GIF that moves is a video there, which moves.
              animated: types.includes("image/gif"),
              maxAltLength: media.description_limit ?? shipped.maxAltLength,
              maxAspectRatio: null,
            },
          }),
      };
    },

    async publishStep({ credentials, content, key, progress, media }) {
      const access = parseCredentials(credentials);
      const { domain, accessToken } = access;
      const recorded =
        progress === null ? null : publishProgressSchema.safeParse(progress);
      const state = recorded?.data?.state ?? null;
      const notes = state === null ? null : notesSchema.safeParse(state).data;
      if ((recorded && !recorded.success) || notes === undefined) {
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }
      const parts = recorded?.data.parts ?? [];
      const stepped = (
        published: PublishProgress["parts"],
        noted: Notes | null,
      ): PublishProgress => ({
        parts: published,
        done: published.length >= content.parts.length,
        waitSeconds: 0,
        // As it is stored: without what is left out.
        state: noted && (JSON.parse(JSON.stringify(noted)) as Json),
      });

      const index = parts.length;
      const part = content.parts[index];
      if (!part) return stepped(parts, notes);

      // The first step of a post sends nothing. It notes whose statuses the
      // steps after it look through, which of them were there before the
      // post, and who is to see the parts. That is recorded before anything
      // is sent, so that a step which is run again, however much later, can
      // tell what it posted.
      const replyTo = parts.at(-1)?.id ?? null;
      if (!notes) {
        const account = understood(
          ownAccountSchema,
          await call(domain, "/api/v1/accounts/verify_credentials", {
            token: accessToken,
          }),
          domain,
        );
        const [newest] = await listStatuses(access, account.id, { limit: "1" });
        const instance = await readInstance(domain, accessToken);
        const handleDomain = parseInstanceDomain(instance.domain) ?? domain;
        // Left to itself, Mastodon posts with what the account has set. A
        // step names it all the same, so that all parts are posted alike
        // and it knows what it is looking for.
        const intended = visibility ?? account.source.privacy;
        return stepped(parts, {
          accountId: account.id,
          after: replyTo ?? newest?.id ?? null,
          // Mastodon makes "unlisted" of what a limited account posts as
          // "public", app/services/post_status_service.rb. A step that
          // looked for a public status would not find its own.
          visibility:
            intended === "public" && account.limited ? "unlisted" : intended,
          ownDomains: [...new Set([domain, handleDomain])],
        });
      }

      // Every step after it looks for the next part among what the account
      // has posted since. Where there is more of that than one list holds,
      // the step notes how far it has looked, and the next one goes on
      // from there. The step that gets to the end without finding the part
      // posts it, as a reply to the one before.
      //
      // A part with images takes steps before that: one for each image,
      // which uploads it and notes the ID that the instance gave it.
      // Nothing is looked for until all of them are noted. The status of
      // the part names those IDs, so no run can have posted it before
      // the notes had them all, and a status is the part's only if it
      // has exactly those files. A step that uploads and is run again
      // uploads a second file, which is in no status and which the
      // instance deletes by itself after a day: nobody sees it.
      const images = part.media ?? [];
      const uploaded = notes.media?.part === index ? notes.media.ids : [];
      const next = images[uploaded.length];
      if (next) {
        if (!media) {
          throw new ProviderError(
            "fail",
            "pigy cannot read the images of this post.",
          );
        }
        const form = new FormData();
        form.set(
          "file",
          new Blob([(await media.read(next.id)) as Uint8Array<ArrayBuffer>], {
            type: next.type,
          }),
          `image.${next.type.slice("image/".length)}`,
        );
        if (next.alt !== "") form.set("description", next.alt);
        // 200 for a file that the instance has done with, 202 for one
        // that it works on still. Either way it has an ID.
        const file = understood(
          mediaSchema,
          await call(domain, "/api/v2/media", {
            method: "POST",
            token: accessToken,
            upload: form,
          }),
          domain,
        );
        return stepped(parts, {
          ...notes,
          media: { part: index, ids: [...uploaded, file.id] },
        });
      }
      const looked = await findPosted(
        access,
        notes,
        replyTo,
        part.text,
        uploaded,
      );
      if (looked && "lookedUpTo" in looked) {
        return stepped(parts, { ...notes, after: looked.lookedUpTo });
      }
      if (!looked?.status && uploaded.length > 0) {
        // The files have to be there still, and the instance done with
        // them: a status that names one that is not is refused. One that
        // is gone, because the delivery is taken up a day after it was
        // uploaded, is uploaded again, and so are the others of the part:
        // the notes begin anew.
        let ready = true;
        for (const id of uploaded) {
          const file = await readMedia(access, id);
          if (!file) {
            const { media: _, ...rest } = notes;
            return stepped(parts, rest);
          }
          ready &&= file.ready;
        }
        if (!ready) {
          return { ...stepped(parts, notes), waitSeconds: mediaWaitSeconds };
        }
      }
      const status =
        looked?.status ??
        understood(
          statusSchema,
          await call(domain, "/api/v1/statuses", {
            method: "POST",
            token: accessToken,
            headers: {
              // Mastodon answers a second request with the same key with
              // the status that the first one made. It keeps a key for an
              // hour, and only once the status is saved, so the key is not
              // what makes a step safe to run again: looking first is. The
              // key is a second guard for that hour, should a look miss a
              // status that is there. It is hashed, so that it is a valid
              // header whatever the caller's key, and tells the instance
              // nothing.
              "Idempotency-Key": base64Url(await sha256(`${key}\n${index}`)),
            },
            json: {
              status: part.text,
              ...(replyTo !== null && { in_reply_to_id: replyTo }),
              visibility: notes.visibility,
              ...(uploaded.length > 0 && { media_ids: uploaded }),
            },
          }),
          domain,
        );
      return stepped(
        [
          ...parts,
          { id: status.id, url: httpsUrl(status.url) ?? httpsUrl(status.uri) },
        ],
        // The part after this one is newer than this one, and has
        // images of its own.
        (({ media: _, ...rest }) => ({ ...rest, after: status.id }))(notes),
      );
    },

    async readPost(credentials, id) {
      const { domain, accessToken } = parseCredentials(credentials);
      let status: z.infer<typeof statusSchema>;
      try {
        status = understood(
          statusSchema,
          await call(domain, `/api/v1/statuses/${encodeURIComponent(id)}`, {
            token: accessToken,
          }),
          domain,
        );
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null;
        throw error;
      }
      return {
        id: status.id,
        url: httpsUrl(status.url) ?? httpsUrl(status.uri),
        text: htmlToText(status.content),
        replyToId: status.in_reply_to_id ?? null,
        images: (status.media_attachments ?? []).map(({ description }) => ({
          alt: description ?? "",
        })),
      };
    },

    async deletePost(credentials, id) {
      const { domain, accessToken } = parseCredentials(credentials);
      try {
        await call(domain, `/api/v1/statuses/${encodeURIComponent(id)}`, {
          method: "DELETE",
          token: accessToken,
        });
      } catch (error) {
        // Gone already, which is what was asked for.
        if (error instanceof ProviderError && error.status === 404) return;
        throw error;
      }
    },
  };
}
