import {
  type Clock,
  type Fetch,
  type Limits,
  threadsMaxCharacters,
} from "@pigy/core";
import { z } from "zod";
import { forGood, ProviderError, quotable, understanding } from "../errors.ts";
import {
  type HttpAnswer,
  httpsUrl,
  randomToken,
  retryAfter,
  send,
} from "../http.ts";
import {
  type Json,
  type Provider,
  type PublishedPart,
  type PublishProgress,
  publishProgressSchema,
} from "../provider.ts";

/**
 * The adapter for Threads, for an app that posts text for an account. It
 * follows Meta's documentation of the Threads API at
 * https://developers.facebook.com/docs/threads: "Get Access Tokens and
 * Permissions", "Long-Lived Access Tokens", "Posts", "Reply Management",
 * "Retrieve Threads Media Objects", "Delete Posts" and "Troubleshooting".
 * It was written without access to those pages, from what its author knew
 * of them, and nothing of it has met the real Threads: what had to be
 * assumed is marked GUESS, and PLAN.md section 19 lists what a first run
 * has to settle. Text only so far.
 *
 * Threads differs from the other networks in three ways that shape this
 * file:
 *
 * - A post is published in two requests. The first makes a container of
 *   it, which publishes nothing, and the second publishes the container.
 *   A container says whether it was published, to whoever asks, which is
 *   what a step that is run again goes by.
 * - An access lasts 60 days and is renewed, but only while it lasts: a
 *   token that has ended cannot be renewed. So nothing that Threads
 *   refuses asks for a refresh, and the refresh has to come by a timer.
 * - Threads has no way for an app to give an access back.
 */

export type ThreadsProviderOptions = {
  fetch: Fetch;
  now: Clock;
  /**
   * The app that the operator of this pigy has made at Meta: the ID and
   * the secret of its Threads use case, which are not those of the Meta
   * app around it.
   */
  appId: string;
  appSecret: string;
  /** How long to wait for Threads to answer. 30 seconds by default. */
  timeoutMs?: number;
};

/** What a channel on Threads is reached with. */
const credentialsSchema = z.strictObject({
  /** The long-lived token of the account. */
  accessToken: z.string().min(1),
});

export type ThreadsCredentials = z.infer<typeof credentialsSchema>;

const pendingSchema = z.strictObject({
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

// An ID of the Graph API: a long number, kept as text.
const idSchema = z.string().regex(/^\d+$/);

/**
 * The adapter's notes between two steps of a post. None of it is secret.
 */
const stateSchema = z.strictObject({
  /**
   * The container of the next part, once a step has made it. The step
   * after that asks Threads what became of it before it publishes.
   */
  container: idSchema.nullable(),
  /**
   * The newest post of the account when the delivery began, or null if
   * it had none: where a first part that was published unseen is looked
   * for after. Null for the later parts too, which are found as replies.
   */
  after: z.strictObject({ id: idSchema, timestamp: z.string() }).nullable(),
  /** How often in a row the container was found not to be ready. */
  polls: z.number().int().nonnegative(),
});

type State = z.infer<typeof stateSchema>;

// What pigy reads of Threads' answers. Everything else is ignored.

const shortTokenSchema = z.object({ access_token: z.string().min(1) });

const longTokenSchema = z.object({
  access_token: z.string().min(1),
  /** In seconds. */
  expires_in: z.number().positive(),
});

const profileSchema = z.object({
  id: idSchema,
  username: z.string().min(1),
  name: z.string().optional(),
  threads_profile_picture_url: z.unknown().optional(),
});

const createdSchema = z.object({ id: idSchema });

const containerSchema = z.object({
  status: z.string(),
  error_message: z.string().optional(),
});

const mediaSchema = z.object({
  id: idSchema,
  text: z.string().optional(),
  permalink: z.unknown().optional(),
  timestamp: z.string().optional(),
  is_reply: z.boolean().optional(),
  is_reply_owned_by_me: z.boolean().optional(),
  replied_to: z.object({ id: idSchema }).optional(),
});

type Media = z.infer<typeof mediaSchema>;

const listSchema = z.object({
  data: z.array(mediaSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional() })
    .optional(),
});

/** An error of the Graph API, and of the one address that answers otherwise. */
const errorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      code: z.number().optional(),
      error_subcode: z.number().optional(),
      is_transient: z.boolean().optional(),
    })
    .optional(),
  error_message: z.string().optional(),
});

const authorizationHost = "threads.net";
const apiHost = "graph.threads.net";
const version = "v1.0";

/**
 * What pigy asks a person for. `threads_basic` is in every request, and
 * `threads_content_publish` posts. A thread is a chain of replies, and
 * Meta documents replying, and reading replies, with permissions of their
 * own: GUESS, PLAN.md section 19, that a reply to a post of the account's
 * own takes them too. `threads_delete` deletes a post. An access cannot
 * gain a permission later without the person consenting again.
 */
const scopes = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
];

// Far above any answer that pigy reads.
const maxBytes = 1024 * 1024;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * How long after it was issued a token is renewed. Threads renews one
 * that is a day old and has not ended, and a token lasts 60 days: a week
 * leaves more than seven weeks to try again in when Threads is out of
 * reach.
 */
const refreshAfterMs = 7 * dayMs;

// How many posts one list of Threads holds at most, and how many lists a
// step reads when it looks for a post.
const pageSize = 100;
const maxPages = 5;

// How often a step finds a container not ready and waits, and for how
// long, before it asks to be tried again later.
const maxPolls = 6;
const pollSeconds = 10;

/** `value` as `schema` describes it. Fails if Threads sent other. */
const understood = understanding(
  (who) => `${who} did not answer the way pigy expects it to.`,
);

type Call = {
  method?: "GET" | "POST" | "DELETE";
  /** The parameters: in the address, or as a form for a `POST`. */
  params?: Record<string, string>;
  /** The access token of an account, for a request made in its name. */
  token?: string;
  /** What the request carries that must not show up in a message. */
  secrets?: readonly string[];
};

/** A time as Threads writes one, such as "2026-11-15T10:00:00+0000". */
function timeOf(timestamp: string | undefined): number {
  return new Date(
    (timestamp ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
  ).getTime();
}

export function createThreadsProvider({
  fetch,
  now,
  appId,
  appSecret,
  timeoutMs = 30_000,
}: ThreadsProviderOptions): Provider {
  /** Sends a request to Threads and returns the answer as it is. */
  function request(
    path: string,
    { method = "GET", params = {}, token }: Call,
  ): Promise<HttpAnswer> {
    // Documented: the token of a request is its parameter `access_token`.
    const all = new URLSearchParams({
      ...params,
      ...(token && { access_token: token }),
    }).toString();
    const form = method === "POST";
    return send(
      fetch,
      "Threads",
      `https://${apiHost}${path}${form || !all ? "" : `?${all}`}`,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
        },
        ...(form && { body: all }),
      },
      { timeoutMs, maxBytes },
    );
  }

  /** What Threads says in an answer that refuses, without a secret. */
  function saidIn({ json }: HttpAnswer, { token, secrets = [] }: Call) {
    const body = errorSchema.safeParse(json).data;
    return quotable(body?.error?.message ?? body?.error_message ?? "", [
      ...secrets,
      appSecret,
      ...(token ? [token] : []),
    ]);
  }

  /** What an answer that is not a success means for the caller. */
  function failure(answer: HttpAnswer, call: Call): ProviderError {
    const { status, headers } = answer;
    const error = errorSchema.safeParse(answer.json).data?.error;
    const code = error?.code;
    // The codes with which the Graph API says that it was asked too
    // often: by the app, by the account, and at this address.
    if (
      status === 429 ||
      (code !== undefined && [4, 17, 32, 613].includes(code))
    ) {
      return new ProviderError(
        "retry",
        "Threads is limiting how often pigy may ask.",
        { status, retryAt: retryAfter(headers, now()) },
      );
    }
    if (status >= 500 || error?.is_transient === true || code === 2) {
      return new ProviderError(
        "retry",
        `Threads is having trouble (HTTP ${status}).`,
        { status, retryAt: retryAfter(headers, now()) },
      );
    }
    // Only an answer to the account's own token says anything about the
    // access to the account. 190 is the code of a token that the Graph
    // API does not take: it has ended, was taken back, or is none. A
    // token that has ended is not renewed, so none of them asks for a
    // refresh.
    if (call.token && (code === 190 || status === 401)) {
      return new ProviderError(
        "reconnect",
        "Threads no longer accepts the access that pigy was given to this account.",
        { status },
      );
    }
    const said = saidIn(answer, call);
    return new ProviderError(
      "fail",
      said
        ? `Threads refused the request: ${said}`
        : `Threads refused the request (HTTP ${status}).`,
      { status },
    );
  }

  const succeeded = ({ status }: HttpAnswer) => status >= 200 && status < 300;

  /** The JSON that Threads answers a request with. Throws otherwise. */
  async function call(path: string, options: Call = {}) {
    const answer = await request(path, options);
    if (!succeeded(answer)) throw failure(answer, options);
    return answer.json;
  }

  /**
   * Whether Threads says in `answer` that it has nothing under the ID
   * that it was asked for: what it says of a post that was deleted.
   */
  function gone(answer: HttpAnswer): boolean {
    const error = errorSchema.safeParse(answer.json).data?.error;
    return error?.code === 100 && error.error_subcode === 33;
  }

  function parseCredentials(credentials: Json): ThreadsCredentials {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      throw new ProviderError(
        "reconnect",
        "pigy has lost its access to this Threads account.",
      );
    }
    return parsed.data;
  }

  /** The access that a long-lived token is, issued at `issuedAt`. */
  function accessOf(token: z.infer<typeof longTokenSchema>, issuedAt: Date) {
    const credentials: ThreadsCredentials = { accessToken: token.access_token };
    const lifetimeMs = token.expires_in * 1000;
    return {
      credentials,
      refreshAt: new Date(
        issuedAt.getTime() +
          // Never before the day is over that a token has to be old, and
          // well before its end where Threads names a shorter life.
          Math.max(dayMs + 60_000, Math.min(refreshAfterMs, lifetimeMs / 2)),
      ),
      expiresAt: new Date(issuedAt.getTime() + lifetimeMs),
    };
  }

  /** The part that a post is, with the link that Threads has for it. */
  const partOf = ({ id, permalink }: Media): PublishedPart => ({
    id,
    url: httpsUrl(permalink),
  });

  /**
   * The posts of a list of Threads, newest first, up to the first that
   * `until` says to stop before, or to the end of the list. Undefined if
   * the list goes on beyond what a step is willing to read.
   */
  async function listed(
    path: string,
    token: string,
    fields: string,
    until: (media: Media) => boolean,
  ): Promise<Media[] | undefined> {
    const found: Media[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const { data, paging } = understood(
        listSchema,
        await call(path, {
          token,
          params: {
            fields,
            limit: String(pageSize),
            ...(after !== undefined && { after }),
          },
        }),
        "Threads",
      );
      for (const media of data) {
        if (until(media)) return found;
        found.push(media);
      }
      after = paging?.cursors?.after;
      // A list ends with a page that is empty, or that names no next.
      if (data.length === 0 || after === undefined) return found;
    }
    return undefined;
  }

  return {
    network: "threads",
    // A container is the delivery's own, and says whether it was
    // published. But which post it became is found by looking through
    // what the account has posted since the delivery began, where a post
    // of a later delivery that reads the same can be: when the person has
    // deleted the delivery's own, that one would be taken for it.
    tellsDeliveriesApart: false,
    // Every connection is handed a token of its own, as far as is known,
    // but there is nothing that pigy could call to end one: a caller has
    // nothing to gain from asking.
    accessPerConnection: false,
    // A step that publishes asks Threads first what became of its
    // container, and publishes only one that was not published.
    repeatsSafely: true,

    async beginConnect({ redirectUri }) {
      const state = randomToken();
      const url = new URL(`https://${authorizationHost}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        // Documented: separated by commas.
        scope: scopes.join(","),
        response_type: "code",
        state,
      }).toString();
      const pending: z.infer<typeof pendingSchema> = { state, redirectUri };
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
      if (
        error === "access_denied" &&
        params.get("error_reason") === "user_denied"
      ) {
        throw new ProviderError(
          "fail",
          "The connection was declined at Threads.",
          { declined: true },
        );
      }
      // Documented: Threads ends the address of the callback with `#_`,
      // which is no part of the code. A browser keeps it to itself, and
      // whatever hands it on all the same is forgiven.
      const code = params.get("code")?.replace(/#_$/, "");
      if (error || !code) {
        // The callback is the word of whoever sent the browser back.
        const said = quotable(params.get("error_description") ?? error ?? "", [
          appSecret,
          flow.state,
          ...(code ? [code] : []),
        ]);
        throw new ProviderError(
          "fail",
          `Threads did not connect the account${said ? `: ${said}` : "."}`,
        );
      }

      // From here on the code is spent, or may be: every failure is for
      // good, and the person begins again. A token that was handed out
      // by then and is not kept ends by itself: nothing can end it.
      try {
        const short = understood(
          shortTokenSchema,
          await call("/oauth/access_token", {
            method: "POST",
            params: {
              client_id: appId,
              client_secret: appSecret,
              grant_type: "authorization_code",
              redirect_uri: flow.redirectUri,
              code,
            },
            secrets: [code],
          }),
          "Threads",
        );
        // What the code was exchanged for lasts an hour. This is what
        // lasts, and what is renewed.
        const issuedAt = now();
        const long = understood(
          longTokenSchema,
          await call("/access_token", {
            params: {
              grant_type: "th_exchange_token",
              client_secret: appSecret,
              access_token: short.access_token,
            },
            secrets: [short.access_token],
          }),
          "Threads",
        );
        // The answer to the code names the account too, as a number that
        // can be larger than a program reads one exactly. This is the ID
        // as text.
        const profile = understood(
          profileSchema,
          await call(`/${version}/me`, {
            token: long.access_token,
            params: {
              fields: "id,username,name,threads_profile_picture_url",
            },
            secrets: [short.access_token],
          }),
          "Threads",
        );
        return {
          account: {
            id: profile.id,
            handle: `@${profile.username}`,
            name: profile.name || profile.username,
            avatarUrl: httpsUrl(profile.threads_profile_picture_url),
            profileUrl: `https://www.threads.com/@${encodeURIComponent(profile.username)}`,
          },
          access: accessOf(long, issuedAt),
        };
      } catch (failure) {
        throw forGood(failure);
      }
    },

    /**
     * Renews the token, for 60 days from now. Threads does that for a
     * token that is a day old and has not ended, and for no other: once
     * the 60 days are over, only the person can connect the account
     * again. So the caller's timer is what keeps a channel, and nothing
     * that Threads refuses is cured by this.
     */
    async refresh(credentials) {
      const { accessToken } = parseCredentials(credentials);
      const issuedAt = now();
      const renewed = understood(
        longTokenSchema,
        await call("/refresh_access_token", {
          token: accessToken,
          params: { grant_type: "th_refresh_token" },
        }),
        "Threads",
      );
      return accessOf(renewed, issuedAt);
    },

    async disconnect(credentials) {
      parseCredentials(credentials);
      // Meta documents no way for an app to give a token of Threads
      // back, and none to remove itself from an account. Saying so is
      // what lets a caller tell the person where to do it themselves.
      throw new ProviderError(
        "fail",
        "Threads gives pigy no way to give its access back. It ends by itself after 60 days at most, or when pigy is removed in the settings of the account.",
      );
    },

    async limits(credentials): Promise<Limits> {
      // The same for every account. The credentials are read all the
      // same: limits are of an account that pigy can reach.
      parseCredentials(credentials);
      return { network: "threads", maxCharacters: threadsMaxCharacters };
    },

    /**
     * Two steps per part, each with one request that changes something:
     *
     * 1. Make a container of the part, as a reply to the part before it.
     *    Nothing is published by that. For the first part the step notes
     *    before, which post was the account's newest.
     * 2. Ask Threads for the status of the container, and go by it:
     *    - `FINISHED`: publish it.
     *    - `PUBLISHED`: a run before this one published it, and its answer
     *      was lost. Publish nothing, and find the post: a later part
     *      among the replies to the part before it, the first part among
     *      what the account has posted since the delivery began.
     *    - `IN_PROGRESS`: wait, and ask again in the next step.
     *    - `EXPIRED`, which a container is a day after it was made: make
     *      a new one, which the next step publishes.
     *    - Not there any more: look for the post as for `PUBLISHED`, and
     *      make a new container only if the account has no such post.
     *
     * A step that is run again therefore publishes nothing twice: it asks
     * first, and publishes no container that was published. A container
     * that was made twice, because the answer to the first was lost, is
     * one that nobody publishes.
     */
    async publishStep({ credentials, content, progress }) {
      const { accessToken: token } = parseCredentials(credentials);
      const recorded =
        progress === null
          ? null
          : publishProgressSchema.safeParse(progress).data;
      const state =
        recorded?.state == null
          ? null
          : stateSchema.safeParse(recorded.state).data;
      if (recorded === undefined || state === undefined) {
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }
      const parts = recorded?.parts ?? [];
      const index = parts.length;
      const text = content.parts[index]?.text;
      if (text === undefined) {
        return { parts, done: true, waitSeconds: 0, state: null };
      }
      const before = parts[index - 1];

      /** Makes a container of the part, for the next step to publish. */
      const contain = async (
        after: State["after"],
      ): Promise<PublishProgress> => {
        const { id } = understood(
          createdSchema,
          await call(`/${version}/me/threads`, {
            method: "POST",
            token,
            params: {
              media_type: "TEXT",
              text,
              ...(before && { reply_to_id: before.id }),
            },
          }),
          "Threads",
        );
        return {
          parts,
          done: false,
          waitSeconds: 0,
          state: { container: id, after, polls: 0 } satisfies State,
        };
      };

      /** The progress with the part in it. */
      const published = (part: PublishedPart): PublishProgress => {
        const done = index + 1 === content.parts.length;
        return {
          parts: [...parts, part],
          done,
          waitSeconds: 0,
          state: done
            ? null
            : ({ container: null, after: null, polls: 0 } satisfies State),
        };
      };

      if (!state || state.container === null) {
        if (before) return contain(null);
        // The first part: where the posts of the account stand, so that a
        // step which has to look for the part looks at nothing older.
        const { data } = understood(
          listSchema,
          await call(`/${version}/me/threads`, {
            token,
            params: { fields: "id,timestamp", limit: "1" },
          }),
          "Threads",
        );
        const [newest] = data;
        return contain(
          newest ? { id: newest.id, timestamp: newest.timestamp ?? "" } : null,
        );
      }

      /**
       * The part as a run before this one published it, if it is among
       * what the account has posted: a later part among the replies to
       * the part before it, the first part among what the account has
       * posted since the delivery began.
       */
      const find = async (): Promise<PublishedPart | undefined> => {
        const fields = "id,text,permalink,timestamp,is_reply_owned_by_me";
        const since = state.after;
        const sinceTime = timeOf(since?.timestamp);
        const candidates = before
          ? await listed(
              `/${version}/${before.id}/replies`,
              token,
              fields,
              () => false,
            )
          : await listed(
              `/${version}/me/threads`,
              token,
              fields,
              // Nothing from before the delivery, whatever it reads like:
              // the list is looked through up to the post that was the
              // newest then, or, if that one is gone, to the first that
              // is older.
              (media) =>
                since !== null &&
                (media.id === since.id || timeOf(media.timestamp) < sinceTime),
            );
        // The oldest that reads like the part: the deliveries to an
        // account run one after the other, so what a later one has posted
        // is newer than what this container became.
        const found = candidates?.findLast(
          (media) =>
            media.text?.trim() === text.trim() &&
            (!before || media.is_reply_owned_by_me === true),
        );
        return found && partOf(found);
      };

      const asked: Call = {
        token,
        params: { fields: "status,error_message" },
      };
      const answer = await request(`/${version}/${state.container}`, asked);
      // Threads no longer has the container. That says nothing of whether
      // it was published before it went: GUESS, PLAN.md section 19, that
      // Threads forgets a container at some time. So the step looks, as
      // for one that says that it was published, and makes a new one only
      // if the account has no such post.
      const status = gone(answer)
        ? "GONE"
        : succeeded(answer)
          ? understood(containerSchema, answer.json, "Threads")
          : undefined;
      if (status === undefined) throw failure(answer, asked);
      if (status === "GONE") {
        const part = await find();
        return part ? published(part) : contain(state.after);
      }
      switch (status.status) {
        case "FINISHED": {
          const { id } = understood(
            createdSchema,
            await call(`/${version}/me/threads_publish`, {
              method: "POST",
              token,
              params: { creation_id: state.container },
            }),
            "Threads",
          );
          // The part is published, and this only asks for its link: a
          // step that failed here would have to look for a post whose ID
          // it had. So a link that cannot be read is left out.
          let permalink: unknown;
          try {
            ({ permalink } = understood(
              mediaSchema,
              await call(`/${version}/${id}`, {
                token,
                params: { fields: "id,permalink" },
              }),
              "Threads",
            ));
          } catch (error) {
            if (!(error instanceof ProviderError)) throw error;
          }
          return published(partOf({ id, permalink }));
        }
        case "PUBLISHED": {
          const part = await find();
          if (part) return published(part);
          // Threads has published it, so the step never publishes it
          // again, however often it is run: the post was deleted or
          // changed since, or Threads does not list it.
          throw new ProviderError(
            "uncertain",
            `Threads says that it has published ${
              content.parts.length > 1 ? `part ${index + 1}` : "the post"
            }, and pigy cannot find it among the posts of the account: it may have been deleted or changed there. pigy does not post it a second time. To post it again, publish it anew.`,
          );
        }
        case "IN_PROGRESS": {
          if (state.polls >= maxPolls) {
            throw new ProviderError(
              "retry",
              "Threads is still preparing the post.",
            );
          }
          return {
            parts,
            done: false,
            waitSeconds: pollSeconds,
            state: { ...state, polls: state.polls + 1 } satisfies State,
          };
        }
        case "EXPIRED":
          // Nobody published it within its day, and nobody can now.
          return contain(state.after);
        default: {
          const said = quotable(status.error_message ?? "", [token]);
          throw new ProviderError(
            "fail",
            `Threads could not prepare the post${said ? `: ${said}` : "."}`,
          );
        }
      }
    },

    async readPost(credentials, id) {
      const { accessToken: token } = parseCredentials(credentials);
      if (!idSchema.safeParse(id).success) return null;
      const options: Call = {
        token,
        params: { fields: "id,text,permalink,is_reply,replied_to" },
      };
      const answer = await request(`/${version}/${id}`, options);
      if (gone(answer)) return null;
      if (!succeeded(answer)) throw failure(answer, options);
      const media = understood(mediaSchema, answer.json, "Threads");
      return {
        id: media.id,
        url: httpsUrl(media.permalink),
        text: media.text ?? "",
        replyToId: media.replied_to?.id ?? null,
      };
    },

    async deletePost(credentials, id) {
      const { accessToken: token } = parseCredentials(credentials);
      if (!idSchema.safeParse(id).success) {
        throw new ProviderError("fail", "This is not a post on Threads.");
      }
      const options: Call = { method: "DELETE", token };
      const answer = await request(`/${version}/${id}`, options);
      // Gone already is what was asked for.
      if (gone(answer)) return;
      if (!succeeded(answer)) throw failure(answer, options);
    },
  };
}
