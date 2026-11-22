import { webPageAt } from "../web/index.ts";
import { apiError, bodyParams, json, text } from "./http.ts";
import {
  attachable,
  mediaJson,
  mediaLimits,
  supportedImageTypes,
} from "./media.ts";
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
import {
  countableLength,
  findEntities,
  type Mentioned,
  renderContent,
  rewriteMentions,
} from "./text.ts";

/**
 * The part of Mastodon's API that pigy uses: methods/instance,
 * methods/accounts and methods/statuses of its documentation, with the
 * errors of entities/Error. Where the documentation is silent, the code it
 * links to was read: app/controllers/api/v1/statuses_controller.rb,
 * app/controllers/api/v1/accounts/statuses_controller.rb,
 * app/services/post_status_service.rb,
 * app/services/process_mentions_service.rb,
 * app/lib/account_statuses_filter.rb, app/models/concerns/paginable.rb and
 * app/models/status.rb.
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
  "poll",
  "scheduled_at",
  "quoted_status_id",
  "spoiler_text",
];

const idempotencyLifetimeMs = 60 * 60 * 1000;

// How many statuses a list holds: 20 unless the request asks, 40 at most.
const defaultListLength = 20;
const longestList = 40;

// The filters of a list of statuses that the simulated Mastodon does not
// have. `exclude_reblogs` is not among them: there are no boosts here, so
// there is nothing to leave out.
const listFiltersNotSimulated = [
  "pinned",
  "tagged",
  "only_media",
  "exclude_replies",
];

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
        max_media_attachments: mediaLimits.maxAttachments,
        characters_reserved_per_url: instance.charactersReservedPerUrl,
      },
      media_attachments: {
        supported_mime_types: [...supportedImageTypes, "video/mp4"],
        // From 4.4 on.
        ...(atLeast(instance.version, 4, 4) && {
          description_limit: mediaLimits.descriptionLimit,
        }),
        image_size_limit: mediaLimits.imageSizeLimit,
        image_matrix_limit: mediaLimits.imageMatrixLimit,
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
    // Only an account that is limited has the attribute.
    ...(account.limited && { limited: true }),
  };
}

/** `GET /api/v1/accounts/verify_credentials`: whose token this is. */
export function verifyCredentials(state: State, account: MastodonAccount) {
  return json(200, {
    ...accountJson(state, account),
    source: {
      privacy: account.privacy ?? "public",
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
  const found = findEntities(status.text, (name, domain) =>
    mentionedAccount(state, status.domain, name, domain),
  );
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
      : {
          content: renderContent(status.text, status.domain, (name, domain) =>
            mentionedAccount(state, status.domain, name, domain),
          ),
        }),
    reblog: null,
    application: app ? { name: app.name, website: app.website } : null,
    account: account ? accountJson(state, account) : null,
    media_attachments: state.media
      .all()
      .filter(({ statusId }) => statusId === status.id)
      // In the order that the status named them in.
      .sort(
        (a, b) =>
          (status.images ?? []).findIndex(({ blob }) => blob === a.blob) -
          (status.images ?? []).findIndex(({ blob }) => blob === b.blob),
      )
      .map(mediaJson),
    mentions: found.mentions,
    // A tag is kept in lower case, whatever way it was written.
    tags: [...new Set(found.tags.map((name) => name.toLowerCase()))].map(
      (name) => ({
        name,
        url: `https://${status.domain}/tags/${encodeURIComponent(name)}`,
      }),
    ),
    emojis: [],
    card: status.card
      ? {
          // entities/PreviewCard, for a link.
          url: status.card.url,
          title: status.card.title,
          description: status.card.description,
          type: "link",
          author_name: "",
          author_url: "",
          provider_name: "",
          provider_url: "",
          html: "",
          width: 0,
          height: 0,
          image: null,
          embed_url: "",
          blurhash: null,
        }
      : null,
    poll: null,
  };
}

/**
 * The account that a mention on the instance `own` names, as that
 * instance has it, or undefined if it finds none: see `mentionedAcct`.
 */
function mentionedAccount(
  state: State,
  own: string,
  username: string,
  domain = own,
): Mentioned | undefined {
  const account = state.accounts
    .all()
    .find(
      (known) =>
        known.username.toLowerCase() === username.toLowerCase() &&
        known.domain === domain.toLowerCase(),
    );
  if (!account) return undefined;
  return {
    id: account.id,
    username: account.username,
    acct:
      account.domain === own
        ? account.username
        : `${account.username}@${account.domain}`,
    url: `https://${account.domain}/@${account.username}`,
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

/**
 * How Mastodon writes the account that a mention on `instance` names, or
 * undefined if it finds none. Names and domains are compared without
 * regard to case, and a mention with the instance's own domain, or with
 * none, is of one of its own accounts. From
 * app/services/process_mentions_service.rb and the scopes `with_username`
 * and `with_domain` of app/models/account.rb.
 *
 * An account on another instance of the world is found too. Mastodon asks
 * the other server for it, with WebFinger, which may also answer with
 * another domain than the one that was typed. The world has no such
 * aliases.
 */
function mentionedAcct(
  state: State,
  instance: Instance,
  username: string,
  domain = instance.domain,
): string | undefined {
  return mentionedAccount(state, instance.domain, username, domain)?.acct;
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

  // Mastodon stores, and counts, the text with its mentions rewritten and
  // without the whitespace around it. This is what Ruby's `strip` removes.
  const body = rewriteMentions(
    typeof params.status === "string" ? params.status : "",
    (username, domain) => mentionedAcct(state, instance, username, domain),
  ).replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, "");
  // From the code: a status that names no visibility gets the one that the
  // account has set, and "public" becomes "unlisted" for an account that
  // is limited.
  const asked = text(params, "visibility") ?? account.privacy ?? "public";
  const visibility = asked === "public" && account.limited ? "unlisted" : asked;
  // The files are looked up before the text is judged: a status with a
  // file needs no text.
  const attached = attachable(state, instance, account, params.media_ids);
  if (attached instanceof Response) return attached;
  const errors: string[] = [];
  if (body.trim() === "" && attached.length === 0) {
    errors.push("Text can't be blank");
  }
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

  const found = findEntities(body, (name, domain) =>
    mentionedAccount(state, instance.domain, name, domain),
  );
  const firstLink = found.entities.find(({ kind }) => kind === "link");
  // The web of a simulated world is the simulated web: a link that leads
  // anywhere else has no page that could be read.
  // From the code: a status with a file has no card.
  const firstPage =
    attached.length === 0 && firstLink && webPageAt(firstLink.target);
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
    entities: found.entities,
    // Mastodon reads the page of the first link of a status and shows
    // what it says of itself. It does so a moment after it has taken the
    // status. GUESS: here the card is there at once, which a client that
    // reads the status again later cannot tell apart.
    card: firstPage
      ? {
          url: firstPage.url,
          title: firstPage.ogTitle ?? firstPage.title ?? "",
          description: firstPage.ogDescription ?? firstPage.description ?? "",
        }
      : null,
    ...(attached.length > 0 && {
      images: attached.map(
        ({ blob, type, width, height, size, description }) => ({
          blob,
          type,
          width,
          height,
          size,
          alt: description,
        }),
      ),
    }),
  };
  state.statuses.put(id, status);
  for (const media of attached) {
    state.media.put(media.id, { ...media, statusId: id });
  }
  if (key) {
    state.idempotency.put(keyId, {
      statusId: id,
      expiresAt: now + idempotencyLifetimeMs,
    });
  }
  return json(200, statusJson(state, status));
}

/**
 * `GET /api/v1/accounts/:id/statuses`: what an account has posted, newest
 * first. Its author gets all of it, everybody else what they may see.
 *
 * `max_id` and `since_id` bound the list from above and below. `min_id`
 * does what `since_id` does and turns the choice around: of what lies
 * above it, the list holds the oldest, not the newest. That is what lets a
 * client walk forward from a status it knows. Mastodon also names the
 * neighbouring lists in a `Link` header, which this leaves out.
 */
export function listStatuses(
  state: State,
  instance: Instance,
  accountId: string,
  query: URLSearchParams,
  caller: Caller | undefined,
): Response {
  const account = state.accounts.get(accountId);
  if (account?.domain !== instance.domain) {
    return apiError(404, "Record not found");
  }
  const unsupported = listFiltersNotSimulated.find((name) => query.has(name));
  if (unsupported) {
    return apiError(
      422,
      `The simulated Mastodon does not have ${unsupported} yet`,
    );
  }
  const bounds: Record<string, bigint | undefined> = {};
  for (const name of ["max_id", "since_id", "min_id"]) {
    const value = query.get(name);
    if (!value) continue;
    // Mastodon's IDs are numbers. What it makes of anything else is not
    // simulated.
    if (!/^[0-9]+$/.test(value)) {
      return apiError(
        422,
        `The simulated Mastodon takes only a number as ${name}`,
      );
    }
    bounds[name] = BigInt(value);
  }
  // From the code: the number is read the way Ruby's `to_i` reads it,
  // without its sign, and anything that is no number is 0.
  const asked = query.get("limit");
  const limit =
    asked === null
      ? defaultListLength
      : Math.min(Math.abs(Number.parseInt(asked, 10) || 0), longestList);

  const { max_id: below, since_id: since, min_id: after } = bounds;
  const above = after ?? since;
  const oldestFirst = state.statuses
    .all()
    .filter(
      (status) =>
        status.accountId === account.id &&
        visibleTo(status, caller?.account ?? null) &&
        (above === undefined || BigInt(status.id) > above) &&
        (below === undefined || BigInt(status.id) < below),
    )
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const listed =
    after === undefined
      ? oldestFirst.reverse().slice(0, limit)
      : oldestFirst.slice(0, limit).reverse();
  return json(
    200,
    listed.map((status) => statusJson(state, status)),
  );
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

/**
 * `GET /api/v1/statuses/:id/source`: the text of a status as it was
 * written, which is how Mastodon stores it: entities/StatusSource.
 */
export function showSource(
  state: State,
  instance: Instance,
  id: string,
  caller: Caller | undefined,
): Response {
  const status = findStatus(state, instance, id);
  if (!status || !visibleTo(status, caller?.account ?? null)) {
    return apiError(404, "Record not found");
  }
  return json(200, { id: status.id, text: status.text, spoiler_text: "" });
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
  // Its files go with it.
  for (const media of state.media.all()) {
    if (media.statusId === id) state.media.delete(media.id);
  }
  // From the code: the replies stay, and no longer say what they reply to.
  for (const reply of state.statuses.all()) {
    if (reply.replyToId === id) {
      state.statuses.put(reply.id, { ...reply, replyToId: null });
    }
  }
  return answer;
}
