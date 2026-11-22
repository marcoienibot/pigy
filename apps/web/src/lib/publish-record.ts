import {
  apiKeyPrefixes,
  type Environment,
  type PublishRequest,
  type Tables,
} from "@pigy/core";
import { networkInfo } from "@/lib/networks";

/**
 * What Settings → Record says of the record of publishing: every request
 * to publish that the workspace on screen had, where it came from and how
 * each delivery ended. The record is fetched, not synced, and names posts
 * and accounts by their IDs: the names come from the local copy, where
 * the post or the account may be gone by now.
 */

/** What the record names besides IDs, from the local copy. */
export type RecordNames = {
  channels: Tables["channel"];
  posts: Tables["post"];
};

/** The synced tables that the record takes its names from. */
export const selectRecordNames = (tables: Tables): RecordNames => ({
  channels: tables.channel,
  posts: tables.post,
});

/**
 * What the record goes by in the local copy: every delivery that was
 * asked for, and how it stands. It changes when a delivery is asked for,
 * which queues its target anew, and when one ends, which is when the
 * record has something new, whichever device or script asked: the screen
 * asks for the record again then. A delivery that moves on in between
 * changes it too, which costs a question and nothing else. A string, so
 * that a copy that has not changed in this gives the same one.
 */
export function selectRecorded(tables: Tables): string {
  let recorded = "";
  for (const target of tables.post_target.values()) {
    // A channel that is chosen for a draft has been asked for nothing.
    if (target.status === "pending") continue;
    recorded += `${target.id}:${target.status}:${target.queuedAt};`;
  }
  return recorded;
}

/** How a delivery stands, for its colour: done, gone wrong, or neither. */
export type Tone = "done" | "failed" | "open";

/** One request to publish, as the screen shows it. */
export type RecordEntry = {
  /** The time of the request, which no other request of the record has. */
  key: number;
  requestedAt: number;
  /** Where it came from, in words. */
  source: string;
  /**
   * The post, where the Sent screen has it: it was sent or failed, and has
   * not been deleted since. Null where it is gone, or not sent yet.
   */
  postId: string | null;
  deliveries: {
    key: string;
    /** The account, by its handle, or what it was where it is gone. */
    account: string;
    network: string;
    outcome: string;
    tone: Tone;
  }[];
};

/** Where a request came from, in words. */
export function sourceWords(
  request: Pick<PublishRequest, "source" | "apiKeyId">,
  environment: Environment,
): string {
  switch (request.source) {
    case "app":
      return "Published in the app";
    case "api":
      // As the API screen shows the key: by how it begins. Never the key.
      return request.apiKeyId === null
        ? "Published with an API key"
        : `Published with the API key ${apiKeyPrefixes[environment]}${request.apiKeyId.slice(0, 8)}…`;
    case "schedule":
      return "Sent at its scheduled time";
    case "queue":
      return "Sent from the queue";
    default:
      return "Published";
  }
}

/** How a delivery ended, in words, and its tone. */
export function outcomeWords(
  outcome: PublishRequest["deliveries"][number]["outcome"],
): { words: string; tone: Tone } {
  switch (outcome) {
    case null:
      return { words: "On its way", tone: "open" };
    case "sent":
      return { words: "Sent", tone: "done" };
    case "error":
      return { words: "Not sent", tone: "failed" };
    case "uncertain":
      return { words: "Unknown: look on the network", tone: "failed" };
    case "disconnected":
      return { words: "Not sent: the account was disconnected", tone: "open" };
    default:
      return { words: "Ended", tone: "open" };
  }
}

/** The requests of the record as the screen shows them, the newest first. */
export function recordEntries(
  requests: readonly PublishRequest[],
  { channels, posts }: RecordNames,
  environment: Environment,
): RecordEntry[] {
  return requests.map((request) => {
    const post = posts.get(request.postId);
    return {
      key: request.requestedAt,
      requestedAt: request.requestedAt,
      source: sourceWords(request, environment),
      // The Sent screen lists what has gone out, and brings a post into
      // view by its ID.
      postId:
        post && post.status !== "draft" && post.status !== "scheduled"
          ? post.id
          : null,
      deliveries: request.deliveries.map((delivery) => {
        const channel = channels.get(delivery.channelId);
        const network =
          delivery.network === "other"
            ? "Another network"
            : networkInfo[delivery.network].label;
        const { words, tone } = outcomeWords(delivery.outcome);
        return {
          key: delivery.targetId,
          account: channel?.handle ?? "An account that was disconnected",
          network,
          outcome: words,
          tone,
        };
      }),
    };
  });
}
