import {
  inReadingOrder,
  type PostStatus,
  type Row,
  type Tables,
  type TargetStatus,
} from "@pigy/core";
import { type Channel, selectChannels } from "@/lib/channels";

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
  /** The parts that are published, in the order of the post. */
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
};

export type SentPost = {
  id: string;
  status: SentStatus;
  /** The text of the post, part after part. */
  parts: { id: string; text: string }[];
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

/** The posts of the Sent screen, the one published last first. */
export function selectSent(tables: Tables): SentPost[] {
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
    const ordered = inReadingOrder(parts.get(post.id) ?? []);
    const position = new Map(ordered.map((part, index) => [part.id, index]));
    const ofPost = targets.get(post.id) ?? [];
    const asked = ofPost.flatMap(({ queuedAt }) =>
      queuedAt === null ? [] : [queuedAt],
    );
    posts.push({
      id: post.id,
      status: post.status,
      parts: ordered.map(({ id, text }) => ({ id, text })),
      publishedAt: asked.length > 0 ? Math.min(...asked) : post.updatedAt,
      targets: ofPost
        .map((target): SentTarget => {
          const channel = tables.channel.get(target.channelId) ?? null;
          const failed =
            target.status === "error" || target.status === "uncertain";
          return {
            id: target.id,
            status: target.status,
            error: target.error,
            sentAt: target.sentAt,
            channel,
            published: (results.get(target.id) ?? [])
              // A result of a part that is no longer in the post has no
              // place to be shown in.
              .filter((result) => position.has(result.partId))
              .sort(
                (a, b) =>
                  (position.get(a.partId) ?? 0) - (position.get(b.partId) ?? 0),
              )
              .map(({ partId, remoteId, url }) => ({ partId, remoteId, url })),
            canRetry:
              failed &&
              channel !== null &&
              channel.status !== "needs_reconnect",
            reconnect: failed && channel?.status === "needs_reconnect",
          };
        })
        .sort(
          (a, b) =>
            (order.get(a.channel?.id ?? "") ?? Number.POSITIVE_INFINITY) -
              (order.get(b.channel?.id ?? "") ?? Number.POSITIVE_INFINITY) ||
            (a.id < b.id ? -1 : 1),
        ),
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
 */
export function targetExplanation(target: SentTarget): string | null {
  switch (target.status) {
    case "queued":
      return "Waits its turn: posts to one account go out one after the other.";
    case "uncertain":
      return "pigy cannot tell whether this post reached the account. Look at the account first: if the post is there, do not try again, or it is posted twice.";
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
    case "error":
      // Some of its targets may have arrived: they say which.
      return post.targets.some((target) => target.status === "sent")
        ? { label: "Partly sent", tone: "bad" }
        : { label: "Failed", tone: "bad" };
  }
}

/**
 * Whether a post can be deleted from pigy. Not while it is being sent: the
 * server refuses that, because a post that is deleted in the middle would
 * leave posts on the networks that pigy knows nothing of.
 */
export function canDelete(post: SentPost): boolean {
  return post.status !== "sending";
}
