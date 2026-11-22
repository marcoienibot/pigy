import {
  type Clock,
  type ContentImage,
  type Fetch,
  joinLinkedInParts,
  type Limits,
  linkedInMaxCharacters,
  type PostContent,
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
  type PublishProgress,
  publishProgressSchema,
} from "../provider.ts";
import { littleText } from "./text.ts";

/**
 * The adapter for LinkedIn, for an application that posts as a member. It
 * follows LinkedIn's documentation at
 * https://learn.microsoft.com/en-us/linkedin: "Authorization Code Flow
 * (3-legged OAuth)", "Sign In with LinkedIn using OpenID Connect", "Posts
 * API", "Little Text Format" and "Error Handling". It was written without
 * access to those pages, from what its author knew of them, and nothing
 * of it has met the real LinkedIn: what had to be assumed is marked GUESS,
 * and PLAN.md section 19 lists what a first run has to settle. Text only
 * so far, with its hashtags marked and its first link previewed, and
 * members only: no media, and no pages of organizations.
 *
 * LinkedIn differs from the other networks in three ways that shape this
 * file:
 *
 * - There is one LinkedIn, and pigy is an application that its operator
 *   has registered there, with an ID and a secret. A person types nothing
 *   to connect an account.
 * - An access lasts 60 days and cannot be renewed: LinkedIn gives refresh
 *   tokens to applications that it has approved for them, which is not
 *   what anybody who runs pigy can count on. The person connects again.
 * - pigy can read no posts: that takes a permission which LinkedIn
 *   restricts. And a request to post carries no key that would make a
 *   second one harmless. So a step that posts cannot find out what a run
 *   before it did, and `repeatsSafely` is false: `publishStep` has what
 *   follows from that.
 */

/**
 * The version of LinkedIn's API that the adapter speaks, as the header
 * `LinkedIn-Version` names it: a year and a month. LinkedIn retires a
 * version about a year after it came out, so this has to be raised about
 * once a year, after reading what changed. GUESS: that this version
 * exists. PLAN.md section 19.
 */
export const linkedInApiVersion = "202610";

export type LinkedInProviderOptions = {
  fetch: Fetch;
  now: Clock;
  /** The application that the operator of this pigy has made at LinkedIn. */
  clientId: string;
  clientSecret: string;
  /** `linkedInApiVersion` unless given. */
  apiVersion?: string;
  /**
   * Who can see what is posted, in LinkedIn's terms. Everybody, unless
   * given. LinkedIn has no posts that only their author sees: the nearest
   * is `CONNECTIONS`, which a live conformance run posts with.
   */
  visibility?: "PUBLIC" | "CONNECTIONS";
  /** How long to wait for LinkedIn to answer. 30 seconds by default. */
  timeoutMs?: number;
};

/** What a channel on LinkedIn is reached with. */
const credentialsSchema = z.strictObject({
  accessToken: z.string().min(1),
  /** The ID of the member, which is who a post names as its author. */
  memberId: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

export type LinkedInCredentials = z.infer<typeof credentialsSchema>;

const pendingSchema = z.strictObject({
  state: z.string().min(1),
  redirectUri: z.string().min(1),
});

// What names an image of the Images API.
const imageUrn = /^urn:li:image:[A-Za-z0-9_-]+$/;

/**
 * The adapter's notes between two steps of a post. None of it is secret:
 * the URN of an image says nothing that lets anybody at it.
 */
const notesSchema = z.strictObject({
  /**
   * The images of the post that are uploaded, by their URNs, in the order
   * of the content: those of the first part, then those of the second,
   * and so on. Recorded image by image, before the post that names them.
   */
  images: z.array(z.string().regex(imageUrn)),
  /**
   * How often in a row the step that posts found an image that LinkedIn
   * was still working on.
   */
  waits: z.number().int().nonnegative(),
});

type Notes = z.infer<typeof notesSchema>;

/** The notes of a progress, or undefined if they are not the adapter's. */
function notesOf(state: Json | undefined): Notes | undefined {
  // Progress from before pigy posted images to LinkedIn has none.
  if (state === null || state === undefined) return { images: [], waits: 0 };
  return notesSchema.safeParse(state).data;
}

/** The images of a post, those of every part in the order of the parts. */
const imagesOf = (content: PostContent): ContentImage[] =>
  content.parts.flatMap(({ media }) => media ?? []);

// What pigy reads of LinkedIn's answers. Everything else is ignored.

const tokenSchema = z.object({
  access_token: z.string().min(1),
  /** In seconds. */
  expires_in: z.number().positive(),
  // LinkedIn's documentation shows answers with and without these two.
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/** The claims of OpenID Connect that say who a member is. */
const userinfoSchema = z.object({
  sub: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.unknown().optional(),
});

/** What `initializeUpload` answers: where the bytes go, and the image. */
const initializedSchema = z.object({
  value: z.object({
    uploadUrl: z.string(),
    image: z.string().regex(imageUrn),
  }),
});

/** How an image stands: `WAITING_UPLOAD`, `PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED`. */
const imageStatusSchema = z.object({ status: z.string() });

const authorizationHost = "www.linkedin.com";
const apiHost = "api.linkedin.com";

// What pigy asks a member for: who they are, and to post for them.
// `w_member_social` covers the media of a post too.
const scopes = ["openid", "profile", "w_member_social"];

// Far above any answer that pigy reads.
const maxBytes = 256 * 1024;

/**
 * The hosts that LinkedIn may name for the bytes of an image. The token of
 * the member goes there with them, so no other host is sent anything.
 * GUESS: the Images API names an address under `www.linkedin.com`, and the
 * API before it named one under `api.linkedin.com`.
 */
const uploadHosts = ["www.linkedin.com", "api.linkedin.com"];

// How long the step that posts waits for an image that LinkedIn is still
// working on, in seconds, and how often in a row, before it asks to be
// tried again later: a minute.
const imageWaitSeconds = 5;
const maxImageWaits = 12;

const dayMs = 24 * 60 * 60 * 1000;

// What names a post: the URN of a share or of a post of the older kind.
const postUrn = /^urn:li:(?:share|ugcPost):\d+$/;
// How LinkedIn refuses a post that repeats one, with the one it repeats:
// the whole message, so that nothing which a message only quotes is taken
// for it.
const duplicateOf =
  /^Content is a duplicate of (urn:li:(?:share|ugcPost):\d+)$/;

type Call = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** The access token of a member, for a request made in their name. */
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  /** The bytes of an image, as a body of their own. */
  bytes?: { data: Uint8Array; type: string };
  headers?: Record<string, string>;
  /** What the request carries that must not show up in a message. */
  secrets?: readonly string[];
};

/**
 * What gives the first link of a post its preview: an article, "Posts
 * API", "Article Post Creation". LinkedIn reads no page for a post of an
 * application, so a link in the text is a link and nothing more unless
 * the post says what its preview shows. The caller has read the page
 * where it could, and hands over what it found as the card of the part
 * that the link is in: the first card of the content is that of the first
 * link of the post, `cardLinks` of `@pigy/core`.
 *
 * Without a card the post goes out without `content`, as text with a
 * link. A page that names no title has a card all the same, headed by
 * its host: `cardOf` of card.ts gives every card a title, so such a
 * page is previewed under the name of its host. LinkedIn requires a
 * title of an article and refuses the whole post without one, so a card
 * whose title is blank, which pigy's own reading never makes and the
 * type of a card does not rule out, is not sent: the contract says that
 * a post is not kept back for its card. No picture: an article takes one
 * that was uploaded before, and pigy does not read the picture of a page.
 */
function articleOf(content: PostContent) {
  const card = content.parts.find((part) => part.card)?.card;
  if (!card || card.title.trim() === "") return {};
  return {
    content: {
      article: {
        source: card.url,
        title: card.title,
        ...(card.description && { description: card.description }),
      },
    },
  };
}

/**
 * What gives a post its images: "Posts API", one image as `media` and
 * several as `multiImage`, each by its URN and with what it shows. The
 * URNs are those of `images`, in their order.
 */
function imagesContent(urns: readonly string[], images: ContentImage[]) {
  const named = urns.map((id, index) => {
    const alt = images[index]?.alt ?? "";
    return { id, ...(alt !== "" && { altText: alt }) };
  });
  const [one] = named;
  return {
    content:
      named.length === 1 && one
        ? { media: one }
        : { multiImage: { images: named } },
  };
}

/** `value` as `schema` describes it. Throws if LinkedIn sent other. */
const understood = understanding(
  (who) => `${who} did not answer the way pigy expects it to.`,
);

export function createLinkedInProvider({
  fetch,
  now,
  clientId,
  clientSecret,
  apiVersion = linkedInApiVersion,
  visibility = "PUBLIC",
  timeoutMs = 30_000,
}: LinkedInProviderOptions): Provider {
  /** Sends a request to LinkedIn and returns the answer as it is. */
  function request(
    host: string,
    path: string,
    { method = "GET", token, json, form, bytes, headers }: Call,
  ): Promise<HttpAnswer> {
    return send(
      fetch,
      "LinkedIn",
      `https://${host}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
          ...(json !== undefined && { "Content-Type": "application/json" }),
          ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...(bytes && { "Content-Type": bytes.type }),
          ...headers,
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        ...(form && { body: new URLSearchParams(form).toString() }),
        ...(bytes && { body: bytes.data as Uint8Array<ArrayBuffer> }),
      },
      { timeoutMs, maxBytes },
    );
  }

  /** What LinkedIn says in an answer that refuses, without a secret. */
  function saidIn({ json }: HttpAnswer, { token, secrets = [] }: Call) {
    const body = z
      .object({
        // The API says `message`, the OAuth endpoints the other two.
        message: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .safeParse(json).data;
    return quotable(
      body?.message ?? body?.error_description ?? body?.error ?? "",
      [...secrets, clientSecret, ...(token ? [token] : [])],
    );
  }

  /** What an answer that is not a success means for the caller. */
  function failure(answer: HttpAnswer, call: Call): ProviderError {
    const { status, headers } = answer;
    if (status === 429) {
      const today = now();
      return new ProviderError(
        "retry",
        "LinkedIn is limiting how often pigy may ask today.",
        {
          status,
          // LinkedIn's limits are per day, and name no time: a day of
          // LinkedIn's begins at midnight UTC.
          retryAt:
            retryAfter(headers, today) ??
            new Date((Math.floor(today.getTime() / dayMs) + 1) * dayMs),
        },
      );
    }
    if (status >= 500) {
      return new ProviderError(
        "retry",
        `LinkedIn is having trouble (HTTP ${status}).`,
        { status, retryAt: retryAfter(headers, now()) },
      );
    }
    // Only an answer to the member's own token says anything about the
    // access to the account.
    if (call.token && status === 401) {
      return new ProviderError(
        "reconnect",
        "LinkedIn no longer accepts the access that pigy was given to this account. An access to LinkedIn lasts 60 days.",
        { status },
      );
    }
    if (status === 426) {
      return new ProviderError(
        "fail",
        "LinkedIn has retired the version of its API that this pigy speaks. Whoever runs this pigy has to update it.",
        { status },
      );
    }
    const said = saidIn(answer, call);
    return new ProviderError(
      "fail",
      said
        ? `LinkedIn refused the request: ${said}`
        : `LinkedIn refused the request (HTTP ${status}).`,
      { status },
    );
  }

  /** The JSON that LinkedIn answers a request with. Throws otherwise. */
  async function call(host: string, path: string, options: Call = {}) {
    const answer = await request(host, path, options);
    if (answer.status < 200 || answer.status >= 300) {
      throw failure(answer, options);
    }
    return answer.json;
  }

  /** What every request to the versioned API says of itself. */
  const versioned = {
    "LinkedIn-Version": apiVersion,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  function parseCredentials(credentials: Json): LinkedInCredentials {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      throw new ProviderError(
        "reconnect",
        "pigy has lost its access to this LinkedIn account.",
      );
    }
    return parsed.data;
  }

  /** The address of a post for people. */
  const postUrl = (id: string) => `https://www.linkedin.com/feed/update/${id}/`;

  /**
   * Uploads `bytes` as an image of the member and returns its URN: asks
   * LinkedIn for an image, and puts the bytes at the address that it
   * names, with the token of the member. The address is a secret for as
   * long as it takes bytes, so it goes nowhere else, and out of every
   * message.
   */
  async function upload(
    { accessToken, memberId }: LinkedInCredentials,
    image: ContentImage,
    bytes: Uint8Array,
  ): Promise<string> {
    const { value } = understood(
      initializedSchema,
      await call(apiHost, "/rest/images?action=initializeUpload", {
        method: "POST",
        token: accessToken,
        headers: versioned,
        json: {
          initializeUploadRequest: { owner: `urn:li:person:${memberId}` },
        },
      }),
      "LinkedIn",
    );
    let address: URL | undefined;
    try {
      address = new URL(value.uploadUrl);
    } catch {
      address = undefined;
    }
    if (address?.protocol !== "https:" || !uploadHosts.includes(address.host)) {
      throw new ProviderError(
        "fail",
        "LinkedIn named an address for the image that is not its own.",
      );
    }
    await call(address.host, `${address.pathname}${address.search}`, {
      method: "PUT",
      token: accessToken,
      bytes: { data: bytes, type: image.type },
      secrets: [value.uploadUrl, ...address.searchParams.values()],
    });
    return value.image;
  }

  /**
   * How the images `urns` stand at LinkedIn, together: all of them
   * available, one or more still being worked on, or one that LinkedIn
   * no longer has. Throws for one that LinkedIn could not take.
   */
  async function imagesStanding(
    accessToken: string,
    urns: readonly string[],
  ): Promise<"available" | "processing" | "gone"> {
    let standing: "available" | "processing" = "available";
    for (const [index, urn] of urns.entries()) {
      const asked: Call = { token: accessToken, headers: versioned };
      const answer = await request(
        apiHost,
        // A URN in an address has its colons encoded.
        `/rest/images/${encodeURIComponent(urn)}`,
        asked,
      );
      if (answer.status === 404) return "gone";
      if (answer.status < 200 || answer.status >= 300) {
        throw failure(answer, asked);
      }
      const { status } = understood(imageStatusSchema, answer.json, "LinkedIn");
      if (status === "PROCESSING_FAILED") {
        throw new ProviderError(
          "fail",
          urns.length === 1
            ? "LinkedIn could not take the image of the post."
            : `LinkedIn could not take image ${index + 1} of the post.`,
        );
      }
      // Still working on it, or waiting for bytes that it has been sent,
      // or a status that pigy does not know: none of them is posted yet.
      if (status !== "AVAILABLE") standing = "processing";
    }
    return standing;
  }

  return {
    network: "linkedin",
    // A step cannot look, and records nothing that a later one could go
    // on from: there is nothing to keep of a delivery that another has
    // passed.
    tellsDeliveriesApart: false,
    // To be settled by a live run, PLAN.md section 19: LinkedIn does not
    // document whether a member who consents a second time is handed a
    // new token or the one that the application has, nor whether taking
    // one back ends the others. Until then pigy gives back only an access
    // that a channel held. Wrong this way round, a token that nobody
    // holds stands until its 60 days are over. Wrong the other way round,
    // a channel that works would lose its access to tidy up after a
    // connection that failed.
    accessPerConnection: false,
    // LinkedIn lets pigy neither look for a post nor send a request that
    // is carried out once: `publishStep`.
    repeatsSafely: false,

    async beginConnect({ redirectUri }) {
      const state = randomToken();
      const url = new URL(
        `https://${authorizationHost}/oauth/v2/authorization`,
      );
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: scopes.join(" "),
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
      // The two ways in which LinkedIn says that the member said no: on
      // the page where they sign in, and on the one where they consent.
      if (
        error === "user_cancelled_login" ||
        error === "user_cancelled_authorize"
      ) {
        throw new ProviderError(
          "fail",
          "The connection was declined at LinkedIn.",
          { declined: true },
        );
      }
      const code = params.get("code");
      if (error || !code) {
        // The callback is the word of whoever sent the browser back.
        const said = quotable(params.get("error_description") ?? error ?? "", [
          clientSecret,
          flow.state,
          ...(code ? [code] : []),
        ]);
        throw new ProviderError(
          "fail",
          `LinkedIn did not connect the account${said ? `: ${said}` : "."}`,
        );
      }

      // From here on the code is spent, or may be: every failure is for
      // good, and the person begins again.
      try {
        const issuedAt = now();
        const token = understood(
          tokenSchema,
          await call(authorizationHost, "/oauth/v2/accessToken", {
            method: "POST",
            form: {
              grant_type: "authorization_code",
              code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: flow.redirectUri,
            },
            secrets: [code],
          }),
          "LinkedIn",
        );
        // LinkedIn has been seen to list scopes with commas between them,
        // and its documentation has spaces.
        const granted = token.scope?.split(/[\s,]+/);
        if (
          (token.token_type !== undefined &&
            token.token_type.toLowerCase() !== "bearer") ||
          (granted && !scopes.every((scope) => granted.includes(scope)))
        ) {
          throw new ProviderError(
            "fail",
            "LinkedIn did not give pigy the access it needs to post.",
          );
        }
        const member = understood(
          userinfoSchema,
          await call(apiHost, "/v2/userinfo", { token: token.access_token }),
          "LinkedIn",
        );
        const name =
          member.name ||
          [member.given_name, member.family_name].filter(Boolean).join(" ") ||
          "LinkedIn member";
        const credentials: LinkedInCredentials = {
          accessToken: token.access_token,
          memberId: member.sub,
        };
        return {
          account: {
            id: member.sub,
            // LinkedIn gives an application nothing else to address a
            // member by: no handle, and no address of the profile.
            handle: name,
            name,
            avatarUrl: httpsUrl(member.picture),
            profileUrl: null,
          },
          access: {
            credentials,
            // Nothing renews it: the person connects again.
            refreshAt: null,
            expiresAt: new Date(issuedAt.getTime() + token.expires_in * 1000),
          },
        };
      } catch (failure) {
        throw forGood(failure);
      }
    },

    async disconnect(credentials) {
      const { accessToken } = parseCredentials(credentials);
      await call(authorizationHost, "/oauth/v2/revoke", {
        method: "POST",
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          token: accessToken,
        },
        secrets: [accessToken],
      });
    },

    async limits(credentials): Promise<Limits> {
      // The same for every member. The credentials are read all the same:
      // limits are of an account that pigy can reach.
      parseCredentials(credentials);
      return { network: "linkedin", maxCharacters: linkedInMaxCharacters };
    },

    /**
     * A step that uploads an image can be run again: it uploads another,
     * and the one that the run before it uploaded is in no post. Every
     * other step may post.
     */
    stepRepeatsSafely({ content, progress }) {
      if (progress === null) return imagesOf(content).length > 0;
      const recorded = publishProgressSchema.safeParse(progress).data;
      const notes = notesOf(recorded?.state);
      if (!recorded || !notes) return false;
      // Published: the step sends nothing.
      if (recorded.parts.length > 0) return true;
      return notes.images.length < imagesOf(content).length;
    },

    /**
     * One step for each image of the post, and one for the whole post:
     * LinkedIn has no threads of an author's own, so the parts are joined
     * into one post, with the images of every part, and every part is
     * published with it, under its ID.
     *
     * An image is uploaded in a step of its own, which asks LinkedIn for
     * an image of the member and puts the bytes at the address that it
     * names: the address is a secret for as long as it takes bytes, so
     * the two requests are one step, and nothing of the address is
     * recorded. The URN of the image is. Such a step can be run again,
     * which `stepRepeatsSafely` says: it uploads another image, and the
     * one before is in no post. So an upload whose answer was lost, or
     * that was cut off, is tried again and does not end the delivery.
     *
     * The step that posts asks LinkedIn first how each image stands, and
     * waits for one that LinkedIn is still working on. An image that
     * LinkedIn no longer has, which it may drop when it is in no post
     * for long (GUESS), makes the images begin anew: nothing was posted
     * with it. Then it posts, with the images in place of the preview of
     * a link: a post has one content.
     *
     * That step records nothing before it sends, because nothing would
     * help a later run: LinkedIn lets pigy read no posts and takes no key
     * of pigy's making. So the step cannot be run again safely, which the
     * adapter says with `repeatsSafely`, and it is truthful about what it
     * does not know: a request to post that ends without a clear answer,
     * because none came or because LinkedIn failed, is `uncertain` and
     * never `retry`. Only a refusal that says that nothing was posted
     * asks for another try: an answer with a status from 400 to 499,
     * also one that is too long for pigy to read.
     *
     * One thing LinkedIn does tell: it refuses a post of the same member
     * with the same text as one that it has, for some minutes, and names
     * the one that it has. Whose that post is, the refusal does not say:
     * the member may have written it by hand, or published it from
     * elsewhere. So the step takes it for its own only where an attempt
     * before this one may have sent, `mayHaveSentBefore` of the request:
     * within those minutes that is how a delivery that a person tries
     * again comes by the post of the attempt before. A delivery of which
     * no attempt may have sent has sent nothing that the refusal could
     * mean, and fails, with a link to the post that LinkedIn has, in a
     * second attempt as in a first.
     *
     * What is left: an attempt that may have sent and has not, after
     * which the member posts the same text in another way and tries the
     * delivery again within those minutes, takes that post. LinkedIn would
     * not publish the text a second time whatever pigy did.
     */
    async publishStep({
      credentials,
      content,
      progress,
      mayHaveSentBefore,
      media,
    }) {
      const { accessToken, memberId } = parseCredentials(credentials);
      const recorded =
        progress === null ? null : publishProgressSchema.safeParse(progress);
      const notes = notesOf(recorded?.data?.state);
      if ((recorded && !recorded.success) || !notes) {
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }
      const published = (id: string): PublishProgress => ({
        // Every part is in the one post.
        parts: content.parts.map(() => ({ id, url: postUrl(id) })),
        done: true,
        waitSeconds: 0,
        state: null,
      });
      // Published by an attempt before this one: a joined post is there
      // whole or not at all.
      const [part] = recorded?.data.parts ?? [];
      if (part) return published(part.id);

      /** The progress of a step that has posted nothing. */
      const stepped = (state: Notes, waitSeconds = 0): PublishProgress => ({
        parts: [],
        done: false,
        waitSeconds,
        state,
      });
      const images = imagesOf(content);
      if (notes.images.length > images.length) {
        throw new ProviderError(
          "fail",
          "pigy cannot read how far it had come with this post.",
        );
      }
      const next = images[notes.images.length];
      if (next) {
        if (!media) {
          throw new ProviderError(
            "fail",
            "pigy cannot read the images of this post.",
          );
        }
        const urn = await upload(
          { accessToken, memberId },
          next,
          await media.read(next.id),
        );
        return stepped({ images: [...notes.images, urn], waits: 0 });
      }
      if (images.length > 0) {
        const standing = await imagesStanding(accessToken, notes.images);
        if (standing === "gone") return stepped({ images: [], waits: 0 });
        if (standing === "processing") {
          if (notes.waits >= maxImageWaits) {
            throw new ProviderError(
              "retry",
              "LinkedIn is still working on an image of the post.",
            );
          }
          return stepped(
            { ...notes, waits: notes.waits + 1 },
            imageWaitSeconds,
          );
        }
      }

      const call: Call = {
        method: "POST",
        token: accessToken,
        headers: versioned,
        json: {
          author: `urn:li:person:${memberId}`,
          commentary: littleText(joinLinkedInParts(content)),
          // The images win over the preview of a link: a post has one
          // content, and somebody put the images there.
          ...(images.length > 0
            ? imagesContent(notes.images, images)
            : articleOf(content)),
          visibility,
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        },
      };
      const unknown = (how: string, cause?: unknown) =>
        new ProviderError(
          "uncertain",
          `${how}, so pigy cannot tell whether the post is on LinkedIn, and LinkedIn gives it no way to look. Look at the account before you try again.`,
          { cause },
        );
      // From here on the request is out, or may be. Whatever leaves it
      // without an answer that says what became of it is `uncertain`:
      // only a refusal that pigy has read says that nothing was posted.
      let answer: HttpAnswer;
      try {
        answer = await request(apiHost, "/rest/posts", call);
      } catch (error) {
        // What is no failure of a network is passed on as it is.
        if (!(error instanceof ProviderError)) throw error;
        // A refusal is one by its status, whatever comes with it: an
        // answer from 400 to 499 that is too long for `send` to hand out
        // says as clearly that nothing was posted as one that pigy reads.
        // It goes the way of its status, a 429 the way of a 429. What
        // `send` kept back with it is all that is missing: what LinkedIn
        // said, and the time that it may have named for the next try.
        const { status: refusal } = error;
        if (refusal !== undefined && refusal >= 400 && refusal < 500) {
          throw failure(
            {
              status: refusal,
              headers: new Headers(),
              json: undefined,
              text: "",
            },
            call,
          );
        }
        // No answer came, or one that `send` does not hand out and that
        // is no refusal: too long to read, or one that sends pigy
        // elsewhere. LinkedIn may have taken the post all the same.
        throw unknown(
          error.kind === "retry"
            ? "LinkedIn did not answer"
            : "LinkedIn answered in a way that pigy cannot read",
          error,
        );
      }
      const { status } = answer;
      if (status >= 200 && status < 300) {
        const id = answer.headers.get("x-restli-id") ?? "";
        if (!postUrn.test(id)) {
          throw unknown("LinkedIn took the post and did not say which it is");
        }
        return published(id);
      }
      // A server that fails says nothing of how far it got, and neither
      // does a status that is no refusal.
      if (status < 400 || status >= 500) {
        throw unknown(
          `LinkedIn failed while it took the post (HTTP ${status})`,
        );
      }
      if (status === 422) {
        const said = z.object({ message: z.string() }).safeParse(answer.json);
        const duplicate = said.data?.message.match(duplicateOf)?.[1];
        if (duplicate) {
          if (mayHaveSentBefore) return published(duplicate);
          throw new ProviderError(
            "fail",
            `LinkedIn already has a post with this text, and did not publish it a second time: ${postUrl(duplicate)}`,
            { status },
          );
        }
      }
      throw failure(answer, call);
    },

    async deletePost(credentials, id) {
      const { accessToken } = parseCredentials(credentials);
      if (!postUrn.test(id)) {
        throw new ProviderError("fail", "This is not a post on LinkedIn.");
      }
      const call: Call = {
        method: "DELETE",
        token: accessToken,
        headers: { ...versioned, "X-RestLi-Method": "DELETE" },
      };
      const answer = await request(
        apiHost,
        // A URN in an address has its colons encoded.
        `/rest/posts/${encodeURIComponent(id)}`,
        call,
      );
      // Gone already is what was asked for. LinkedIn answers a post that
      // was deleted before like one that it deletes now.
      if (answer.status === 404) return;
      if (answer.status < 200 || answer.status >= 300) {
        throw failure(answer, call);
      }
    },
  };
}
