import {
  type Clock,
  type ContentImage,
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
  type MediaSource,
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
 * "Carousel Posts", "Retrieve Threads Media Objects", "Delete Posts" and
 * "Troubleshooting". It was written without access to those pages, from
 * what its author knew of them, and nothing of it has met the real
 * Threads: what had to be assumed is marked GUESS, and PLAN.md section 19
 * lists what a first run has to settle. Text and images.
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
 * - Threads takes no bytes of an image. It is told an address, and
 *   fetches the image from there itself: a link of pigy's that is signed
 *   and good for a short time, `MediaSource.link`, made in the step that
 *   hands it over and put nowhere else.
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
   * Where the posts of the account stood when the delivery began, or null
   * if it had none: what a first part that was published unseen is looked
   * for after. `timestamp` is that of its newest post then. Threads says
   * a time to the second, so a post of that same second can be from
   * before the delivery or from after it began: `ids` are the posts of
   * that second that were there, the newest among them, or null where
   * that second had more posts than a step reads through: a post of that
   * second is then one that nobody can place. Null for the later parts
   * too, which are found as replies.
   */
  after: z
    .strictObject({
      timestamp: z.string(),
      ids: z.array(idSchema).nullable(),
    })
    .nullable(),
  /**
   * The items of a carousel that are made, by their containers, in the
   * order of the images of the part: for a part with several images,
   * while its container is not made yet. Left out otherwise, and by notes
   * from before pigy posted images.
   */
  items: z.array(idSchema).optional(),
  /** How often in a row the container was found not to be ready. */
  polls: z.number().int().nonnegative(),
  /**
   * How often in a row Threads said that the container was published and
   * listed no post of it.
   */
  looks: z.number().int().nonnegative(),
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
  media_type: z.string().optional(),
  is_quote_post: z.boolean().optional(),
  poll_attachment: z.unknown().optional(),
  alt_text: z.string().optional(),
  children: z
    .object({
      data: z.array(
        z.object({
          media_type: z.string().optional(),
          alt_text: z.string().optional(),
        }),
      ),
    })
    .optional(),
  text: z.string().optional(),
  permalink: z.unknown().optional(),
  timestamp: z.string().optional(),
  is_reply: z.boolean().optional(),
  is_reply_owned_by_me: z.boolean().optional(),
  replied_to: z.object({ id: idSchema }).optional(),
});

type Media = z.infer<typeof mediaSchema>;

/** A time as Threads writes one, such as "2026-11-15T10:00:00+0000". */
function timeOf(timestamp: string | undefined): number {
  return new Date(
    (timestamp ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
  ).getTime();
}

/**
 * The posts that a delivery notes before its first part, each with a
 * time that pigy can read: it is what tells the posts from before the
 * delivery from its own.
 */
const standingSchema = z.object({
  data: z.array(
    z.object({
      id: idSchema,
      timestamp: z.string().refine((value) => !Number.isNaN(timeOf(value))),
    }),
  ),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional() })
    .optional(),
});

const listSchema = z.object({
  data: z.array(mediaSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional() })
    .optional(),
});

/**
 * What the insights of a media object are: a value of each metric that was
 * asked for, over the life of the post. GUESS, PLAN.md section 19: the
 * value is the one entry of `values`, as Meta documents it for the
 * insights of a media object, and not a `total_value`, which it has for
 * those of an account.
 */
const insightsSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      values: z
        .array(z.object({ value: z.number().int().nonnegative() }))
        .min(1),
    }),
  ),
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
 * own takes them too. `threads_delete` deletes a post, and
 * `threads_manage_insights` reads its stats. An access cannot gain a
 * permission later without the person consenting again: an account that
 * was connected before pigy asked for the stats has none until it is
 * connected again, `metrics`.
 */
const scopes = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
  "threads_manage_insights",
];

/**
 * The stats of a post that pigy asks Threads for, by the names of its
 * insights of a media object, and what each is for pigy.
 */
const insights = {
  views: "views",
  likes: "likes",
  replies: "replies",
  reposts: "reposts",
  quotes: "quotes",
} as const;

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
// How many lists a step reads when it notes where the posts of an account
// stand before a delivery. Fewer than it reads when it looks for a post:
// what it could not note here, a later look can still come to, and say
// that it cannot tell.
const standingPages = 3;

// How often a step finds a container not ready and waits, and for how
// long, before it asks to be tried again later.
const maxPolls = 6;
const pollSeconds = 10;

// How often a step looks again for the post of a container that Threads
// says it has published, and how long it waits in between, before it
// says that it cannot find it: GUESS, PLAN.md section 19, that the lists
// of Threads can be some seconds behind what it has published.
const maxLooks = 3;
const lookSeconds = 10;

/**
 * What a post has to say of itself to be taken for a part that pigy
 * published: the images of the part, the same in number and each saying
 * what it shows as the part does, or none, and nothing else. A photo, a
 * video, a quote or a poll that a person posted with the same words is
 * none of pigy's own. `media_type`, `is_quote_post` and `children` are
 * documented. GUESS, PLAN.md section 19: that a post says a poll with
 * `poll_attachment`, that it says what an image shows with `alt_text`,
 * and what each item of a carousel shows when `children` is asked for
 * with the fields of an item in braces, and that a field which a post has
 * nothing for is left out and not refused.
 */
const shapeFields =
  "media_type,is_quote_post,poll_attachment,alt_text,children{media_type,alt_text}";

const shaped = (media: Media, images: readonly ContentImage[]) => {
  if (media.is_quote_post === true || media.poll_attachment != null) {
    return false;
  }
  const [one] = images;
  if (!one) return media.media_type === "TEXT_POST";
  if (images.length === 1) {
    return media.media_type === "IMAGE" && (media.alt_text ?? "") === one.alt;
  }
  const items = media.children?.data ?? [];
  return (
    media.media_type === "CAROUSEL_ALBUM" &&
    items.length === images.length &&
    items.every(
      (item, index) =>
        (item.media_type ?? "IMAGE") === "IMAGE" &&
        (item.alt_text ?? "") === images[index]?.alt,
    )
  );
};

/**
 * What Threads says went wrong with a container, without an address: a
 * container of an image has the link that Threads fetched it from, which
 * is good for whoever has it until it expires.
 */
const withoutAddresses = (said: string) =>
  said.replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "an address");

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
    // The code 1 is an error that the Graph API has no better word for,
    // "possibly temporary". GUESS: that nothing which pigy asks for is
    // refused with it for good. Asking again is safe: a step looks at
    // its container before it publishes.
    if (
      status >= 500 ||
      error?.is_transient === true ||
      code === 1 ||
      code === 2
    ) {
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
     *    before, where the posts of the account stand. A container of a
     *    part with one image names it by a signed link, which Threads
     *    fetches. A part with several is a carousel: one step makes a
     *    container of each image, an item of the carousel, which replies
     *    to nothing and has no text, and notes it, and the container of
     *    the part is made of the items when Threads has them ready.
     * 2. Ask Threads for the status of the container, and go by it:
     *    - `FINISHED`: publish it. If Threads refuses, ask for the status
     *      once more and go by that: the container may be published.
     *    - `PUBLISHED`: a run before this one published it, and its answer
     *      was lost. Publish nothing, and find the post: a later part
     *      among the replies to the part before it, the first part among
     *      what the account has posted since the delivery began. Only a
     *      post of plain text is taken. One that is not listed is looked
     *      for a few times more, and is `uncertain` then.
     *    - `IN_PROGRESS`: wait, and ask again in the next step.
     *    - `EXPIRED`, which a container is a day after it was made, and
     *      not there any more: look for the post as for `PUBLISHED`, and
     *      make a new container, which the next step publishes, only if
     *      the account has no such post. Where the step cannot tell,
     *      because there is more to read than it reads, it is
     *      `uncertain`.
     *
     * A step that is run again therefore publishes nothing twice: it asks
     * first, and publishes no container that was published. A container
     * that was made twice, because the answer to the first was lost, is
     * one that nobody publishes.
     */
    async publishStep({ credentials, content, progress, media }) {
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
      const images = content.parts[index]?.media ?? [];
      const before = parts[index - 1];

      /** Where the images are read from: at a link, for Threads to fetch. */
      const source = (): MediaSource => {
        if (!media) {
          throw new ProviderError(
            "fail",
            "pigy cannot hand the images of this post to Threads.",
          );
        }
        return media;
      };

      /**
       * Makes a container with `params`, and returns its ID. `link` is
       * the address of an image in it, which no message may repeat.
       */
      const make = async (
        params: Record<string, string>,
        link?: string,
      ): Promise<string> =>
        understood(
          createdSchema,
          await call(`/${version}/me/threads`, {
            method: "POST",
            token,
            params,
            ...(link !== undefined && { secrets: [link] }),
          }),
          "Threads",
        ).id;

      /**
       * Makes the container of the part, for the next step to publish: of
       * its text, of its one image with its text, or of the items of its
       * carousel, `items`, with its text.
       */
      const contain = async (
        after: State["after"],
        items: readonly string[] = [],
      ): Promise<PublishProgress> => {
        const reply = before ? { reply_to_id: before.id } : {};
        const withText = text === "" ? {} : { text };
        const [image] = images;
        let id: string;
        if (!image) {
          id = await make({ media_type: "TEXT", text, ...reply });
        } else if (images.length === 1) {
          // Made now, for this request: it is good for minutes, and goes
          // nowhere else.
          const link = await source().link(image.id);
          id = await make(
            {
              media_type: "IMAGE",
              image_url: link,
              ...(image.alt !== "" && { alt_text: image.alt }),
              ...withText,
              ...reply,
            },
            link,
          );
        } else {
          id = await make({
            media_type: "CAROUSEL",
            children: items.join(","),
            ...withText,
            ...reply,
          });
        }
        return {
          parts,
          done: false,
          waitSeconds: 0,
          state: { container: id, after, polls: 0, looks: 0 } satisfies State,
        };
      };

      /** Makes the container of an item of a carousel: one image. */
      const item = async (image: ContentImage): Promise<string> => {
        const link = await source().link(image.id);
        return make(
          {
            media_type: "IMAGE",
            image_url: link,
            is_carousel_item: "true",
            ...(image.alt !== "" && { alt_text: image.alt }),
          },
          link,
        );
      };

      /**
       * What Threads says of the container `id`: its status, or "GONE"
       * for one that it no longer has. GUESS, PLAN.md section 19, that
       * Threads forgets a container at some time.
       */
      const statusOf = async (id: string) => {
        const asked: Call = {
          token,
          params: { fields: "status,error_message" },
        };
        const answer = await request(`/${version}/${id}`, asked);
        if (gone(answer)) return { status: "GONE", error_message: undefined };
        if (!succeeded(answer)) throw failure(answer, asked);
        return understood(containerSchema, answer.json, "Threads");
      };

      /** Fails for a container that Threads could not prepare. */
      const unprepared = (said: string | undefined) => {
        const quoted = withoutAddresses(quotable(said ?? "", [token]));
        return new ProviderError(
          "fail",
          `Threads could not prepare the post${quoted ? `: ${quoted}` : "."}`,
        );
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
            : ({
                container: null,
                after: null,
                polls: 0,
                looks: 0,
              } satisfies State),
        };
      };

      /**
       * Where the posts of the account stand, before the first request of
       * the first part that makes something: so that a step which has to
       * look for the part takes nothing from before.
       */
      const standing = async (): Promise<State["after"]> => {
        // One list is nearly always enough for the newest second of
        // them. Where a list ends within that second, the second may go
        // on in the next one, and the step reads on, a few lists at most:
        // a post of that second which it did not note would pass for one
        // that came after the delivery began.
        const noted: { id: string; timestamp: string; time: number }[] = [];
        let newest: (typeof noted)[number] | undefined;
        let whole = false;
        let after: string | undefined;
        for (let page = 0; page < standingPages && !whole; page++) {
          const { data, paging } = understood(
            standingSchema,
            await call(`/${version}/me/threads`, {
              token,
              params: {
                fields: "id,timestamp",
                limit: String(pageSize),
                ...(after !== undefined && { after }),
              },
            }),
            "Threads",
          );
          for (const media of data) {
            const post = { ...media, time: timeOf(media.timestamp) };
            noted.push(post);
            if (!newest || post.time > newest.time) newest = post;
          }
          after = paging?.cursors?.after;
          // The second is read whole once a list has a post from before
          // it, or the lists have ended.
          whole =
            data.length === 0 ||
            after === undefined ||
            data.some(
              ({ timestamp }) => timeOf(timestamp) < (newest?.time ?? 0),
            );
        }
        const { time, timestamp } = newest ?? {};
        return timestamp === undefined
          ? null
          : {
              timestamp,
              ids: whole
                ? noted.filter((post) => post.time === time).map(({ id }) => id)
                : null,
            };
      };

      if (!state || state.container === null) {
        const items = state?.items ?? [];
        // Noted once for the first part, before its first request that
        // makes something: the first item of a carousel, or its
        // container. A later part is found as a reply.
        const after = before
          ? null
          : items.length > 0
            ? (state?.after ?? null)
            : await standing();
        if (images.length < 2) return contain(after);
        const next = images[items.length];
        if (next) {
          return {
            parts,
            done: false,
            waitSeconds: 0,
            state: {
              container: null,
              items: [...items, await item(next)],
              after,
              polls: 0,
              looks: 0,
            } satisfies State,
          };
        }
        // Every item is made. Threads takes a carousel only of items that
        // it has ready: GUESS, PLAN.md section 19.
        let ready = true;
        for (const id of items) {
          const { status, error_message } = await statusOf(id);
          if (status === "FINISHED") continue;
          if (status === "IN_PROGRESS") {
            ready = false;
            continue;
          }
          // Expired, or no longer known: the items are made anew. No
          // post was made of them, so the part begins anew.
          if (status === "EXPIRED" || status === "GONE") {
            return {
              parts,
              done: false,
              waitSeconds: 0,
              state: {
                container: null,
                items: [],
                after,
                polls: 0,
                looks: 0,
              } satisfies State,
            };
          }
          throw unprepared(error_message);
        }
        if (!ready) {
          const polls = state?.polls ?? 0;
          if (polls >= maxPolls) {
            throw new ProviderError(
              "retry",
              "Threads is still preparing the images of the post.",
            );
          }
          return {
            parts,
            done: false,
            waitSeconds: pollSeconds,
            state: {
              container: null,
              items,
              after,
              polls: polls + 1,
              looks: 0,
            },
          };
        }
        return contain(after, items);
      }
      const container = state.container;
      const which = content.parts.length > 1 ? `part ${index + 1}` : "the post";

      /**
       * The part as a run before this one published it, if it is among
       * what the account has posted: a later part among the replies to
       * the part before it, the first part among what the account has
       * posted since the delivery began. "none" if the account has no
       * such post, and "unknown" if that cannot be told: the list goes on
       * beyond what a step reads, or has a post without a time, or a post
       * that reads like the part is of the second in which the delivery
       * began, of which the step could not note every post. The two are
       * not the same to a caller that would publish after "none".
       */
      const find = async (): Promise<PublishedPart | "none" | "unknown"> => {
        const fields = `id,text,permalink,timestamp,is_reply_owned_by_me,${shapeFields}`;
        const since = state.after;
        const sinceTime = timeOf(since?.timestamp);
        let unreadable = false;
        const listedPosts = before
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
              // the list is looked through up to the first post that is
              // older than the newest was when the delivery began.
              (media) => {
                if (since === null) return false;
                const time = timeOf(media.timestamp);
                if (Number.isNaN(time)) unreadable = true;
                return unreadable || time < sinceTime;
              },
            );
        if (listedPosts === undefined || unreadable) return "unknown";
        const candidates = listedPosts.filter(
          (media) =>
            // A post of images says no text where it has none.
            (media.text ?? "").trim() === text.trim() &&
            shaped(media, images) &&
            // A post of the second in which the delivery began that was
            // there before it: the times of Threads do not tell it from
            // one that came after.
            !since?.ids?.includes(media.id) &&
            (!before || media.is_reply_owned_by_me === true),
        );
        // That second had more posts than the step noted, and one of it
        // reads like the part: from before the delivery, or its own.
        if (
          since?.ids === null &&
          candidates.some(({ timestamp }) => timeOf(timestamp) === sinceTime)
        ) {
          return "unknown";
        }
        // The oldest that reads like the part: the deliveries to an
        // account run one after the other, so what a later one has posted
        // is newer than what this container became.
        const found = candidates.at(-1);
        return found ? partOf(found) : "none";
      };

      const cannotTell = () =>
        new ProviderError(
          "uncertain",
          `pigy cannot tell whether Threads has published ${which}: it could not look through enough of ${
            before
              ? "the replies to the part before it"
              : "what the account has posted"
          } to know. pigy does not post it a second time. Look at the account, and to post it again, publish it anew.`,
        );

      /**
       * The same for a container that Threads says it has published.
       * There is nothing to doubt then, and nothing to publish anew: that
       * would be a second post.
       */
      const cannotFind = () =>
        new ProviderError(
          "uncertain",
          `Threads says that it has published ${which}. pigy could not look through enough of the account to find it, and does not post it a second time: look at the account.`,
        );

      /**
       * What to do about a container that Threads says it has published:
       * a run before this one published it, and its answer was lost.
       * Nothing is published, however often the step is run.
       */
      const wasPublished = async (): Promise<PublishProgress> => {
        const part = await find();
        if (part === "unknown") throw cannotFind();
        if (part !== "none") return published(part);
        // Not listed yet, perhaps: the step looks again a few times.
        if (state.looks < maxLooks) {
          return {
            parts,
            done: false,
            waitSeconds: lookSeconds,
            state: {
              container: state.container,
              after: state.after,
              polls: state.polls,
              looks: state.looks + 1,
            } satisfies State,
          };
        }
        // The post was deleted or changed since, or Threads does not
        // list it.
        throw new ProviderError(
          "uncertain",
          `Threads says that it has published ${which}, and pigy cannot find it among the posts of the account: it may have been deleted or changed there. pigy does not post it a second time. To post it again, publish it anew.`,
        );
      };

      /**
       * What to do about a container that nobody can publish any more,
       * which says nothing of whether it was published while it could
       * be: look, and make a new one only if the account has no such
       * post. Where that cannot be told, a new container would be a
       * second post if the first one is there.
       */
      const mayBePublished = async (): Promise<PublishProgress> => {
        const part = await find();
        if (part === "unknown") throw cannotTell();
        if (part !== "none") return published(part);
        // The items of a carousel have expired with it, or are gone: they
        // are made anew first.
        if (images.length >= 2) {
          return {
            parts,
            done: false,
            waitSeconds: 0,
            state: {
              container: null,
              items: [],
              after: state.after,
              polls: 0,
              looks: 0,
            } satisfies State,
          };
        }
        return contain(state.after);
      };

      /** Waits for a container that Threads is still preparing. */
      const waiting = (): PublishProgress => {
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
          state: {
            container: state.container,
            after: state.after,
            polls: state.polls + 1,
            looks: state.looks,
          } satisfies State,
        };
      };

      /** What Threads says of the container of the part. */
      const statusNow = () => statusOf(container);

      const status = await statusNow();
      switch (status.status) {
        case "FINISHED": {
          const publishing: Call = {
            method: "POST",
            token,
            params: { creation_id: container },
          };
          const answer = await request(
            `/${version}/me/threads_publish`,
            publishing,
          );
          if (!succeeded(answer)) {
            const refusal = failure(answer, publishing);
            if (refusal.kind !== "fail") throw refusal;
            // A refusal is no word on where the container stands: GUESS,
            // PLAN.md section 19, that Threads refuses to publish one
            // that is published, as one that is not ready. Another
            // request may have published it meanwhile, or Threads said
            // too early that it was ready. So the step asks once more,
            // and goes by that.
            const after = await statusNow();
            if (after.status === "PUBLISHED") return wasPublished();
            if (after.status === "IN_PROGRESS") return waiting();
            throw refusal;
          }
          const { id } = understood(createdSchema, answer.json, "Threads");
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
        case "PUBLISHED":
          return wasPublished();
        case "IN_PROGRESS":
          return waiting();
        // Nobody published it within its day, as far as its status says,
        // and nobody can now. The status of an old container is not
        // relied on for more: GUESS, PLAN.md section 19, that one which
        // was published says so for good.
        case "EXPIRED":
        case "GONE":
          return mayBePublished();
        default:
          throw unprepared(status.error_message);
      }
    },

    async readPost(credentials, id) {
      const { accessToken: token } = parseCredentials(credentials);
      if (!idSchema.safeParse(id).success) return null;
      const options: Call = {
        token,
        params: {
          fields: `id,text,permalink,is_reply,replied_to,media_type,alt_text,children{alt_text}`,
        },
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
        images:
          media.media_type === "IMAGE"
            ? [{ alt: media.alt_text ?? "" }]
            : (media.children?.data ?? []).map((item) => ({
                alt: item.alt_text ?? "",
              })),
      };
    },

    async metrics(credentials, id) {
      const { accessToken: token } = parseCredentials(credentials);
      if (!idSchema.safeParse(id).success) return null;
      const options: Call = {
        token,
        params: { metric: Object.values(insights).join(",") },
      };
      const answer = await request(`/${version}/${id}/insights`, options);
      if (gone(answer)) return null;
      // The code 10 is a permission that the token lacks: here the one to
      // read stats, which an account that was connected before pigy
      // asked for it does not have. Nothing but a new connection gives
      // it, and the post itself is fine.
      if (errorSchema.safeParse(answer.json).data?.error?.code === 10) {
        throw new ProviderError(
          "fail",
          "Threads lets pigy read the stats of this account once it is connected again.",
          { status: answer.status },
        );
      }
      if (!succeeded(answer)) throw failure(answer, options);
      const { data } = understood(insightsSchema, answer.json, "Threads");
      const insight = (name: string) =>
        data.find((metric) => metric.name === name)?.values[0]?.value ?? null;
      return {
        views: insight(insights.views),
        likes: insight(insights.likes),
        replies: insight(insights.replies),
        reposts: insight(insights.reposts),
        quotes: insight(insights.quotes),
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
