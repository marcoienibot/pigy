import {
  type Clock,
  comparableMastodonText,
  type Fetch,
  type Limits,
} from "@pigy/core";
import { z } from "zod";
import { ProviderError, quotable } from "../errors.ts";
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
   * applies, which is what a cross-poster should respect. The live
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
    }),
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

/** entities/Status. */
const statusSchema = z.object({
  id: z.string().min(1),
  url: z.unknown(),
  uri: z.unknown(),
  content: z.string(),
  in_reply_to_id: z.string().nullish(),
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
});

type Notes = z.infer<typeof notesSchema>;

// The most statuses that Mastodon lists in one answer.
const listLength = 40;

// What pigy asks an account for, besides seeing who it is. `write:media`
// is for the media that pigy does not post yet: a registration cannot gain
// a scope later, so asking now spares everybody a second connection.
const postingScopes = ["read:statuses", "write:statuses", "write:media"];

// What Mastodon says, in English whatever the language of the instance,
// when a token lacks the scope for a request.
const outsideScopes = "This action is outside the authorized scopes";

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
    { method = "GET", token, json, form, headers }: Call,
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

  /** `value` as `schema` describes it. Throws if the instance sent other. */
  function understood<Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
    domain: string,
  ): z.output<Schema> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ProviderError(
        "fail",
        `${domain} did not answer the way a Mastodon server does.`,
      );
    }
    return parsed.data;
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

  /**
   * A failure to complete a connection, as the contract wants it: for
   * good. The code of the callback is spent, or may be, so no second call
   * can do better, whatever the trouble of the instance was.
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

  /** Statuses of an account, newest first: methods/accounts, "statuses". */
  async function listStatuses(
    { domain, accessToken }: MastodonCredentials,
    accountId: string,
    query: Record<string, string>,
  ) {
    return understood(
      z.array(statusSchema),
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
   * - Its text is the text of the part. That takes the source of the
   *   status: its HTML is not the text, a mention has no domain there. The
   *   source is not the text that was sent either. Mastodon writes every
   *   mention of an account that it finds the way the account is written,
   *   and which accounts it finds, only the server knows. So the two are
   *   compared in the form of `comparableMastodonText`, in which neither
   *   the case nor the domain of a mention counts.
   *
   * That comparison lets in a status which differs from the part in the
   * case or the domain of a mention, "@ada@other.example" for
   * "@ada@mastodon.example", and in nothing else. Such a status still has
   * to fit in all the rest: the account's own, newer than this delivery, in
   * the same place, with every other character the same. Only the person
   * can have written it, by hand and since, and it reads as the part does.
   *
   * So a status that reads differently, or stands elsewhere, is never taken
   * for the one that is looked for. What can be taken for it is a status
   * with the same text in the same place that is newer than this delivery:
   * the person posted the same by hand since, or a second delivery of the
   * same text went to the account at the same time. Posting next to that
   * would make two statuses that nobody can tell apart, so taking it is
   * right too. Once pigy posts media, a status has to fit in that as well.
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
    { accountId, after }: Notes,
    replyTo: string | null,
    text: string,
  ) {
    const wanted = comparableMastodonText(text);
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
      if ((status.in_reply_to_id ?? null) !== replyTo) continue;
      const source = await sourceText(credentials, status.id);
      if (source !== null && comparableMastodonText(source) === wanted) {
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
        );
      }
      const code = params.get("code");
      if (error || !code) {
        const said = quotable(
          params.get("error_description") ?? error ?? "",
          [],
        );
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
      const { statuses } = (await readInstance(domain, accessToken))
        .configuration;
      return {
        network: "mastodon",
        maxCharacters: statuses.max_characters,
        charactersPerUrl: statuses.characters_reserved_per_url,
      };
    },

    async publishStep({ credentials, content, key, progress }) {
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
        state: noted,
      });

      const index = parts.length;
      const part = content.parts[index];
      if (!part) return stepped(parts, notes);

      // The first step of a post sends nothing. It notes whose statuses the
      // steps after it look through, and which of them were there before
      // the post. That is recorded before anything is sent, so that a step
      // which is run again, however much later, can tell what it posted.
      const replyTo = parts.at(-1)?.id ?? null;
      if (!notes) {
        const account = understood(
          accountSchema,
          await call(domain, "/api/v1/accounts/verify_credentials", {
            token: accessToken,
          }),
          domain,
        );
        const [newest] = await listStatuses(access, account.id, { limit: "1" });
        return stepped(parts, {
          accountId: account.id,
          after: replyTo ?? newest?.id ?? null,
        });
      }

      // Every step after it looks for the next part among what the account
      // has posted since. Where there is more of that than one list holds,
      // the step notes how far it has looked, and the next one goes on
      // from there. The step that gets to the end without finding the part
      // posts it, as a reply to the one before.
      const looked = await findPosted(access, notes, replyTo, part.text);
      if (looked && "lookedUpTo" in looked) {
        return stepped(parts, { ...notes, after: looked.lookedUpTo });
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
              ...(visibility && { visibility }),
            },
          }),
          domain,
        );
      return stepped(
        [
          ...parts,
          { id: status.id, url: httpsUrl(status.url) ?? httpsUrl(status.uri) },
        ],
        // The part after this one is newer than this one.
        { ...notes, after: status.id },
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
