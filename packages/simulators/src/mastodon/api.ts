import { apiError, bodyParams, json, text } from "./http.ts";
import {
  type App,
  atLeast,
  type Instance,
  type MastodonAccount,
  type MastodonToken,
  type State,
  type Status,
  type Visibility,
} from "./state.ts";
import { countableLength, renderContent } from "./text.ts";

/**
 * The part of Mastodon's API that pigy uses: methods/instance,
 * methods/accounts and methods/statuses of its documentation, with the
 * errors of entities/Error. Where the documentation is silent, the code it
 * links to was read: app/controllers/api/v1/statuses_controller.rb,
 * app/services/post_status_service.rb and app/models/status.rb.
 */

/** Who makes a request, by its token. */
export type Caller = {
  token: MastodonToken;
  app: App;
  /** Null for a token that stands for a client alone. */
  account: MastodonAccount | null;
};

const visibilities: readonly string[] = [
  "public",
  "unlisted",
  "private",
  "direct",
] satisfies Visibility[];

// What pigy could send and the simulated Mastodon does not have yet. It is
// refused rather than ignored, so that nothing seems to work that does not.
const notSimulated = [
  "media_ids",
  "poll",
  "scheduled_at",
  "quoted_status_id",
  "spoiler_text",
];

const idempotencyLifetimeMs = 60 * 60 * 1000;

/** `GET /api/v2/instance`: entities/Instance, as far as clients read it. */
export function showInstance(state: State, instance: Instance): Response {
  const origin = `https://${instance.domain}`;
  return json(200, {
    domain: instance.domain,
    title: instance.title,
    version: instance.version,
    source_url: "https://github.com/mastodon/mastodon",
    description: "A simulated Mastodon server.",
    usage: {
      users: {
        active_month: state.accounts
          .all()
          .filter(({ domain }) => domain === instance.domain).length,
      },
    },
    thumbnail: { url: `${origin}/packs/media/images/preview.png` },
    languages: ["en"],
    configuration: {
      urls: { streaming: `wss://${instance.domain}` },
      accounts: { max_featured_tags: 10, max_pinned_statuses: 5 },
      statuses: {
        max_characters: instance.maxCharacters,
        max_media_attachments: 4,
        characters_reserved_per_url: instance.charactersReservedPerUrl,
      },
      media_attachments: {
        supported_mime_types: ["image/jpeg", "image/png", "video/mp4"],
        image_size_limit: 16_777_216,
        image_matrix_limit: 33_177_600,
        video_size_limit: 103_809_024,
        video_frame_rate_limit: 120,
        video_matrix_limit: 8_294_400,
      },
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2_629_746,
      },
      translation: { enabled: false },
    },
    registrations: { enabled: false, approval_required: false, message: null },
    ...(atLeast(instance.version, 4, 3) && { api_versions: { mastodon: 7 } }),
    contact: { email: `admin@${instance.domain}`, account: null },
    rules: [],
  });
}

/** entities/Account. */
function accountJson(state: State, account: MastodonAccount) {
  const origin = `https://${account.domain}`;
  return {
    id: account.id,
    username: account.username,
    acct: account.username,
    display_name: account.name,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: "2026-01-01T00:00:00.000Z",
    note: "",
    url: `${origin}/@${account.username}`,
    uri: `${origin}/users/${account.username}`,
    avatar: `${origin}/avatars/original/missing.png`,
    avatar_static: `${origin}/avatars/original/missing.png`,
    header: `${origin}/headers/original/missing.png`,
    header_static: `${origin}/headers/original/missing.png`,
    followers_count: 0,
    following_count: 0,
    statuses_count: state.statuses
      .all()
      .filter(({ accountId }) => accountId === account.id).length,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
}

/** `GET /api/v1/accounts/verify_credentials`: whose token this is. */
export function verifyCredentials(state: State, account: MastodonAccount) {
  return json(200, {
    ...accountJson(state, account),
    source: {
      privacy: "public",
      sensitive: false,
      language: "en",
      note: "",
      fields: [],
      follow_requests_count: 0,
    },
  });
}

/**
 * entities/Status. With `source`, the text as it was sent takes the place
 * of the HTML, as in the answer to a deletion.
 */
function statusJson(state: State, status: Status, source = false) {
  const account = state.accounts.get(status.accountId);
  const app = state.apps.get(status.appId);
  const parent = status.replyToId
    ? state.statuses.get(status.replyToId)
    : undefined;
  return {
    id: status.id,
    created_at: new Date(status.createdAt).toISOString(),
    in_reply_to_id: status.replyToId,
    in_reply_to_account_id: parent?.accountId ?? null,
    sensitive: false,
    spoiler_text: "",
    visibility: status.visibility,
    language: "en",
    uri: `https://${status.domain}/users/${account?.username}/statuses/${status.id}`,
    url: status.url,
    replies_count: state.statuses
      .all()
      .filter(({ replyToId }) => replyToId === status.id).length,
    reblogs_count: 0,
    favourites_count: 0,
    edited_at: null,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    ...(source
      ? { text: status.text }
      : { content: renderContent(status.text) }),
    reblog: null,
    application: app ? { name: app.name, website: app.website } : null,
    account: account ? accountJson(state, account) : null,
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };
}

/**
 * Whether `account` may see `status`. Everybody sees what is public or
 * unlisted. The rest is seen by its author. Mastodon also shows it to
 * followers and to who is mentioned, which the simulation has none of.
 *
 * GUESS: a status with the visibility "direct" that mentions nobody is
 * accepted like any other and seen by its author alone. The documentation
 * does not say what Mastodon does with one.
 */
function visibleTo(status: Status, account: MastodonAccount | null): boolean {
  return (
    status.visibility === "public" ||
    status.visibility === "unlisted" ||
    status.accountId === account?.id
  );
}

/** The status with this ID on this instance, if there is one. */
function findStatus(state: State, instance: Instance, id: string) {
  const status = state.statuses.get(id);
  return status?.domain === instance.domain ? status : undefined;
}

/** `POST /api/v1/statuses`: posts a status. */
export async function createStatus(
  state: State,
  instance: Instance,
  request: Request,
  { account, app }: Caller & { account: MastodonAccount },
): Promise<Response> {
  const params = await bodyParams(request);
  const unsupported = notSimulated.find((name) => params[name] !== undefined);
  if (unsupported) {
    return apiError(
      422,
      `The simulated Mastodon does not have ${unsupported} yet`,
    );
  }

  // What is replied to is looked up before anything else.
  const replyToId = text(params, "in_reply_to_id") ?? null;
  if (replyToId !== null) {
    const parent = findStatus(state, instance, replyToId);
    if (!parent || !visibleTo(parent, account)) {
      return apiError(
        404,
        "The post you are trying to reply to does not appear to exist.",
      );
    }
  }

  // A request with the key of an earlier one is answered with what that
  // one made, for an hour, whatever else it says.
  const now = state.world.now().getTime();
  const key = request.headers.get("Idempotency-Key");
  const keyId = `${account.id}/${key}`;
  if (key) {
    const earlier = state.idempotency.get(keyId);
    if (earlier && earlier.expiresAt > now) {
      const made = state.statuses.get(earlier.statusId);
      // GUESS, from the code, which the documentation does not cover: a
      // status that was deleted since is looked up and not found.
      return made
        ? json(200, statusJson(state, made))
        : apiError(404, "Record not found");
    }
  }

  // Mastodon stores, and counts, the text without the whitespace around
  // it. This is what Ruby's `strip` removes.
  const body = (typeof params.status === "string" ? params.status : "").replace(
    /^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g,
    "",
  );
  const visibility = text(params, "visibility") ?? "public";
  const errors: string[] = [];
  if (body.trim() === "") errors.push("Text can't be blank");
  if (
    countableLength(body, instance.charactersReservedPerUrl) >
    instance.maxCharacters
  ) {
    errors.push(`Text character limit of ${instance.maxCharacters} exceeded`);
  }
  if (!visibilities.includes(visibility)) {
    errors.push("Visibility is not included in the list");
  }
  if (errors.length > 0) {
    return apiError(422, `Validation failed: ${errors.join(", ")}`);
  }

  const id = state.nextId();
  const status: Status = {
    network: "mastodon",
    id,
    domain: instance.domain,
    accountId: account.id,
    text: body,
    replyToId,
    createdAt: now,
    url: `https://${instance.domain}/@${account.username}/${id}`,
    visibility: visibility as Visibility,
    appId: app.clientId,
  };
  state.statuses.put(id, status);
  if (key) {
    state.idempotency.put(keyId, {
      statusId: id,
      expiresAt: now + idempotencyLifetimeMs,
    });
  }
  return json(200, statusJson(state, status));
}

/** `GET /api/v1/statuses/:id`: one status. */
export function showStatus(
  state: State,
  instance: Instance,
  id: string,
  caller: Caller | undefined,
): Response {
  const status = findStatus(state, instance, id);
  if (!status || !visibleTo(status, caller?.account ?? null)) {
    return apiError(404, "Record not found");
  }
  return json(200, statusJson(state, status));
}

/** `DELETE /api/v1/statuses/:id`: deletes a status of one's own. */
export function deleteStatus(
  state: State,
  instance: Instance,
  id: string,
  { account }: Caller & { account: MastodonAccount },
): Response {
  const status = findStatus(state, instance, id);
  // Somebody else's status is as good as none.
  if (!status || status.accountId !== account.id) {
    return apiError(404, "Record not found");
  }
  // The answer is the status as it was, with its text for a new draft.
  const answer = json(200, statusJson(state, status, true));
  state.statuses.delete(id);
  // From the code: the replies stay, and no longer say what they reply to.
  for (const reply of state.statuses.all()) {
    if (reply.replyToId === id) {
      state.statuses.put(reply.id, { ...reply, replyToId: null });
    }
  }
  return answer;
}
