import {
  type MetricStatus,
  type Network,
  ownParts,
  type PostStatus,
  partsFor,
  type Row,
  type Tables,
  type TargetStatus,
} from "@pigy/core";
import { type Channel, selectChannels } from "@/lib/channels";
import { networkInfo } from "@/lib/networks";

/**
 * What the Sent screen shows: the posts that were published, or are on
 * their way, each with where it went and how that went. Read from the
 * local copy, where the server reports each delivery as it goes on: a
 * target changes its status, and a part that is published gets a result.
 */

/** The statuses of a post that the Sent screen lists. */
export type SentStatus = Extract<PostStatus, "sending" | "sent" | "error">;

/** Where one part of a post was published. */
export type PublishedPart = {
  /** The ID of the part. */
  partId: string;
  /** The network's ID of the post that the part is in. */
  remoteId: string;
  /** A link to it for people, or null where there is none. */
  url: string | null;
};

/** The delivery of a post to one channel, as the screen shows it. */
export type SentTarget = {
  id: string;
  status: TargetStatus;
  /** Why it failed, for the person. Null unless it did. */
  error: string | null;
  /** When the last part was published, if every part is. */
  sentAt: number | null;
  /**
   * The channel, or null for one that was disconnected since: the target
   * stays, with an ID that names no channel.
   */
  channel: Channel | null;
  /**
   * The text that was written for this account and went there in place of
   * the post's, part after part. Null for an account that got the post's.
   */
  ownText: { id: string; text: string }[] | null;
  /**
   * The parts that are published, in the order of the text that the
   * account got: the post's, or its own.
   */
  published: PublishedPart[];
  /**
   * The delivery has failed, and can be tried again: its channel is still
   * there. A channel that needs connecting again would fail it at once,
   * so it is not offered then.
   */
  canRetry: boolean;
  /**
   * The delivery has failed, and its channel has to be connected again
   * before it can be tried again.
   */
  reconnect: boolean;
  /**
   * What people did with the post on its network, as the server last read
   * it, or null before its first read, which comes soon after the delivery
   * was sent, and for a delivery that is not sent.
   */
  stats: SentStats | null;
};

/** The kinds of count of what people did with a post, in the order shown. */
export const statNames = [
  "likes",
  "reposts",
  "replies",
  "quotes",
  "views",
] as const;

export type StatName = (typeof statNames)[number];

/** One count of what people did with a post, as it is shown. */
export type StatCount = {
  name: StatName;
  count: number;
  /** In words, as "3 likes", for whoever does not see the icon. */
  label: string;
};

/** The stats of a delivery, as the Sent screen shows them. */
export type SentStats = {
  status: MetricStatus;
  /**
   * The counts that the network has, in the order of `statNames`: none
   * where nothing was ever counted.
   */
  counts: StatCount[];
  /** When the counts were read, or null if they never were. */
  countedAt: number | null;
  /**
   * What the person should know besides the counts: why there are none,
   * or why they no longer change. Null where the counts say it all.
   */
  note: string | null;
};

/** What a count is called, one and many, on most networks. */
const statWords: Record<StatName, [one: string, many: string]> = {
  likes: ["like", "likes"],
  reposts: ["repost", "reposts"],
  replies: ["reply", "replies"],
  quotes: ["quote", "quotes"],
  views: ["view", "views"],
};

/** What Mastodon calls a repost. */
const boosts: [string, string] = ["boost", "boosts"];

/**
 * How numbers are written in `locale`, or in the language of the browser
 * where it is undefined, as the dates are, lib/time.ts: in full, grouped
 * as the language groups the digits, or `short`, as 1.2K. One of each per
 * locale, made when it is first asked for.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
function numbersIn(locale: string | undefined, short: boolean) {
  const key = `${locale ?? ""} ${short}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(
      locale,
      short ? { notation: "compact", maximumFractionDigits: 1 } : {},
    );
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * The stats of a delivery to `network`, null for one that is disconnected
 * since, as `metric` has them. The numbers are written in `locale`, or in
 * the language of the browser.
 */
export function statsOf(
  metric: Row<"metric">,
  network: Network | null,
  locale?: string,
): SentStats {
  const counts = statNames.flatMap((name): StatCount[] => {
    const count = metric[name];
    if (count === null) return [];
    const [one, many] =
      name === "reposts" && network === "mastodon" ? boosts : statWords[name];
    const written = numbersIn(locale, false).format(count);
    return [{ name, count, label: `${written} ${count === 1 ? one : many}` }];
  });
  const where = network ? networkInfo[network].label : "the network";
  let note: string | null = null;
  if (metric.status === "unavailable") note = metric.reason;
  if (metric.status === "gone") {
    note =
      counts.length > 0
        ? `The post was deleted on ${where}: these are the last stats that pigy read.`
        : `The post was deleted on ${where}.`;
  }
  return { status: metric.status, counts, countedAt: metric.countedAt, note };
}

/**
 * A count in as few characters as it takes, in `locale`, or in the
 * language of the browser: 950, 1.2K, 3M.
 */
export function compactCount(count: number, locale?: string): string {
  return numbersIn(locale, true).format(count);
}

export type SentPost = {
  id: string;
  status: SentStatus;
  /**
   * The text of the post, part after part: its own, which went to every
   * account that no other text was written for.
   */
  parts: { id: string; text: string }[];
  /**
   * What the post is called: the first part of its own text, or, where
   * that has nothing in it because every account got a text of its own,
   * the first part with something in it of the first such text. Empty
   * only for a post without any text.
   */
  title: string;
  /**
   * When the post was published: when the first of its targets was asked
   * for. A target that is tried again is asked for anew, so a post whose
   * every target was tried again counts from then.
   */
  publishedAt: number;
  /** In the order of their channels, those that are gone last. */
  targets: SentTarget[];
};

function isSent(status: PostStatus): status is SentStatus {
  return status === "sending" || status === "sent" || status === "error";
}

/**
 * The posts of the Sent screen, the one published last first, with their
 * numbers written in `locale`, or in the language of the browser.
 */
export function selectSent(tables: Tables, locale?: string): SentPost[] {
  const parts = new Map<string, Row<"post_part">[]>();
  for (const part of tables.post_part.values()) {
    const of = parts.get(part.postId) ?? [];
    of.push(part);
    parts.set(part.postId, of);
  }
  const targets = new Map<string, Row<"post_target">[]>();
  for (const target of tables.post_target.values()) {
    const of = targets.get(target.postId) ?? [];
    of.push(target);
    targets.set(target.postId, of);
  }
  const results = new Map<string, Row<"target_part_result">[]>();
  for (const result of tables.target_part_result.values()) {
    const of = results.get(result.targetId) ?? [];
    of.push(result);
    results.set(result.targetId, of);
  }
  // The place of each channel in the list of channels.
  const order = new Map(
    selectChannels(tables).map((channel, index) => [channel.id, index]),
  );

  const posts: SentPost[] = [];
  for (const post of tables.post.values()) {
    if (!isSent(post.status)) continue;
    const all = parts.get(post.id) ?? [];
    const ordered = ownParts(all);
    const ofPost = targets.get(post.id) ?? [];
    const asked = ofPost.flatMap(({ queuedAt }) =>
      queuedAt === null ? [] : [queuedAt],
    );
    const sentTo = ofPost
      .map((target): SentTarget => {
        const channel = tables.channel.get(target.channelId) ?? null;
        const metric = tables.metric.get(target.id);
        const failed =
          target.status === "error" || target.status === "uncertain";
        // What this account got, which its results are in the order of.
        const got = partsFor(all, target.id);
        const position = new Map(got.map((part, index) => [part.id, index]));
        return {
          id: target.id,
          status: target.status,
          error: target.error,
          sentAt: target.sentAt,
          channel,
          ownText: got.some((part) => part.targetId === target.id)
            ? got.map(({ id, text }) => ({ id, text }))
            : null,
          published: (results.get(target.id) ?? [])
            // A result of a part that is not in the text has no place
            // to be shown in.
            .filter((result) => position.has(result.partId))
            .sort(
              (a, b) =>
                (position.get(a.partId) ?? 0) - (position.get(b.partId) ?? 0),
            )
            .map(({ partId, remoteId, url }) => ({ partId, remoteId, url })),
          canRetry:
            failed && channel !== null && channel.status !== "needs_reconnect",
          reconnect: failed && channel?.status === "needs_reconnect",
          stats: metric
            ? statsOf(metric, channel?.network ?? null, locale)
            : null,
        };
      })
      .sort(
        (a, b) =>
          (order.get(a.channel?.id ?? "") ?? Number.POSITIVE_INFINITY) -
            (order.get(b.channel?.id ?? "") ?? Number.POSITIVE_INFINITY) ||
          (a.id < b.id ? -1 : 1),
      );
    const hasText = ({ text }: { text: string }) => text.trim() !== "";
    posts.push({
      id: post.id,
      status: post.status,
      parts: ordered.map(({ id, text }) => ({ id, text })),
      title:
        (ordered[0] && hasText(ordered[0])
          ? ordered[0]
          : sentTo.flatMap(({ ownText }) => ownText ?? []).find(hasText)
        )?.text ?? "",
      publishedAt: asked.length > 0 ? Math.min(...asked) : post.updatedAt,
      targets: sentTo,
    });
  }
  return posts.sort(
    (a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? 1 : -1),
  );
}

/** How a status is shown: its word, and the colour that goes with it. */
export type StatusWords = {
  label: string;
  tone: "busy" | "good" | "bad" | "unsure";
};

/** What each status of a delivery is called on screen. */
export const targetStatusWords: Record<TargetStatus, StatusWords> = {
  // Never on the Sent screen: the post of such a target is a draft.
  pending: { label: "Chosen", tone: "busy" },
  queued: { label: "Waiting", tone: "busy" },
  sending: { label: "Sending", tone: "busy" },
  sent: { label: "Sent", tone: "good" },
  error: { label: "Failed", tone: "bad" },
  uncertain: { label: "Unknown", tone: "unsure" },
};

/**
 * What a status of a delivery means, said under the target where the
 * status alone does not say it: PLAN.md section 5.
 *
 * A delivery that nobody knows the end of comes with the reason, which
 * says that pigy cannot tell and asks the person to look at the account
 * first: every such reason does. What is said under it is then only what
 * the reason does not say, and not the same again in other words.
 */
export function targetExplanation(target: SentTarget): string | null {
  switch (target.status) {
    case "queued":
      return "Waits its turn: posts to one account go out one after the other.";
    case "uncertain": {
      // The network of a channel where pigy can neither look for a post
      // nor ask a second time without posting twice, if it is one.
      const blind =
        target.channel && networkInfo[target.channel.network].cannotLook
          ? networkInfo[target.channel.network].label
          : null;
      const advice = `If the post is there, do not try again, or it ${blind ? "may be" : "is"} posted twice.`;
      if (target.error) return advice;
      const why = blind ? `, and ${blind} gives it no way to look` : "";
      return `pigy cannot tell whether this post reached the account${why}. Look at the account first: ${advice.charAt(0).toLowerCase()}${advice.slice(1)}`;
    }
    default:
      return null;
  }
}

/** What a post is called on the screen, by its status and its targets. */
export function postStatusWords(post: SentPost): StatusWords {
  switch (post.status) {
    case "sending":
      return { label: "Sending", tone: "busy" };
    case "sent":
      return { label: "Sent", tone: "good" };
    case "error": {
      const has = (status: TargetStatus) =>
        post.targets.some((target) => target.status === status);
      // Nothing is known to have failed: what is wrong with the post is
      // that nobody knows where a delivery of it ended.
      if (!has("error") && has("uncertain")) {
        return { label: "Unknown", tone: "unsure" };
      }
      // Some of its targets may have arrived: they say which.
      return has("sent")
        ? { label: "Partly sent", tone: "bad" }
        : { label: "Failed", tone: "bad" };
    }
  }
}

/**
 * What the time of a post is the time of, in a word that goes before it:
 * "Published 5m ago". It is the time at which the post was asked to be
 * sent, and that is when it was published only if something of it was. A
 * post of which nothing is known to be anywhere is not said to be
 * published.
 */
export function postTimeWord(post: SentPost): string {
  const somewhere = post.targets.some(
    ({ status, published }) => status === "sent" || published.length > 0,
  );
  if (somewhere) return "Published";
  return post.status === "sending" ? "Started" : "Tried";
}

/**
 * What a delivery has published, as the posts that it made on the
 * network: one for each part on most networks, and one for all of them on
 * a network that joins the parts of a thread into one post, as LinkedIn
 * does. `first` and `last` are the parts that a post holds, counted from
 * one.
 */
export type PublishedPost = {
  remoteId: string;
  url: string | null;
  first: number;
  last: number;
};

export function publishedPosts(published: PublishedPart[]): PublishedPost[] {
  const posts: PublishedPost[] = [];
  for (const [index, { remoteId, url }] of published.entries()) {
    const before = posts.at(-1);
    // The parts of one post follow each other.
    if (before?.remoteId === remoteId) before.last = index + 1;
    else posts.push({ remoteId, url, first: index + 1, last: index + 1 });
  }
  return posts;
}

/**
 * What the Sent screen says over the text that was written for the
 * account of `target`: that it got one, and what the network made of a
 * text of several parts, a thread or, where it has none, one post.
 */
export function ownTextHeading({
  status,
  ownText,
  channel,
}: Pick<SentTarget, "status" | "ownText" | "channel">): string {
  const parts = ownText?.length ?? 0;
  const got = `${status === "sent" ? "Got" : "Gets"} a text of its own`;
  if (parts < 2) return `${got}:`;
  // An account that is disconnected has no network to ask: its text is
  // called what it was written as.
  return channel && networkInfo[channel.network].thread === "joined"
    ? `${got}, ${parts} parts as one post:`
    : `${got}, a thread of ${parts} parts:`;
}

/**
 * Whether a post can be deleted from pigy. Not while it is being sent: the
 * server refuses that, because a post that is deleted in the middle would
 * leave posts on the networks that pigy knows nothing of.
 */
export function canDelete(post: SentPost): boolean {
  return post.status !== "sending";
}
