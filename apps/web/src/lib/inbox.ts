import type { Row, Tables } from "@pigy/core";
import type { Channel } from "@/lib/channels";
import { networkInfo } from "@/lib/networks";
import { dayOf } from "@/lib/time";

/**
 * What the inbox shows: the notifications of the workspace, each with what
 * it is about, read from the local copy like everything synced. The server
 * adds one when a post has ended and has not arrived everywhere, when a
 * network no longer takes the access of an account, and a week before an
 * access ends by its date. It takes one away when what it told of is dealt
 * with: PLAN.md section 13.
 */
export type InboxItem = {
  id: string;
  createdAt: number;
  unread: boolean;
} & (
  | {
      kind: "post_failed";
      /** The first words of the post, as it was written. */
      text: string;
      /** Where the post was to go, with how each delivery ended. */
      deliveries: { account: string; arrived: boolean; unknown: boolean }[];
      postId: string;
    }
  | {
      kind: "channel_needs_reconnect" | "channel_expiring";
      channel: Channel;
    }
);

/** How an account is named in a sentence: by its handle, or its name. */
function accountOf(channel: Channel | undefined): string {
  return channel ? channel.handle : "an account that is no longer connected";
}

/** The notifications of the workspace, the newest first. */
export function selectInbox(tables: Tables): InboxItem[] {
  const items: InboxItem[] = [];
  for (const notification of tables.notification.values()) {
    const { id, createdAt, readAt } = notification;
    const about = { id, createdAt, unread: readAt === null };
    if (notification.kind === "post_failed") {
      const postId = notification.postId;
      // The copy has not heard of the post yet, or has heard that it is
      // gone before it heard the same of the notification.
      if (!postId || !tables.post.has(postId)) continue;
      const parts = [...tables.post_part.values()]
        .filter((part) => part.postId === postId)
        .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
      const targets: Row<"post_target">[] = [
        ...tables.post_target.values(),
      ].filter((target) => target.postId === postId);
      items.push({
        ...about,
        kind: "post_failed",
        postId,
        text: parts[0]?.text ?? "",
        deliveries: targets.map((target) => ({
          account: accountOf(tables.channel.get(target.channelId)),
          arrived: target.status === "sent",
          unknown: target.status === "uncertain",
        })),
      });
      continue;
    }
    const channel =
      notification.channelId && tables.channel.get(notification.channelId);
    if (!channel) continue;
    items.push({ ...about, kind: notification.kind, channel });
  }
  return items.sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );
}

/** How many notifications the person has not read. */
export function selectUnread(tables: Tables): number {
  return selectInbox(tables).filter(({ unread }) => unread).length;
}

/** Up to three names, as a list in a sentence, and how many more. */
function listed(names: string[]): string {
  const [first = "", second, third, ...more] = names;
  if (!second) return first;
  if (!third) return `${first} and ${second}`;
  return more.length === 0
    ? `${first}, ${second} and ${third}`
    : `${first}, ${second} and ${more.length + 1} more`;
}

/** What a notification says, and what pressing it offers to do. */
export function inboxWords(
  item: InboxItem,
  now: number,
): { title: string; detail: string; action: string } {
  if (item.kind === "post_failed") {
    const missing = item.deliveries.filter(({ arrived }) => !arrived);
    // As the Sent screen says it: a post of which nothing is known to
    // have failed, and of which a delivery is unknown, is unknown.
    const unknown = missing.length > 0 && missing.every((one) => one.unknown);
    const where = listed(missing.map(({ account }) => account));
    return {
      title: unknown
        ? `pigy cannot tell whether a post reached ${where || "its account"}`
        : `A post was not sent to ${where || "its account"}`,
      detail: item.text || "Empty post",
      action: "See the post",
    };
  }
  const { channel } = item;
  const network = networkInfo[channel.network].label;
  // A network that addresses an account by its name has it said once.
  const account =
    channel.handle === channel.name
      ? `${channel.name} on ${network}`
      : `${channel.handle}`;
  if (item.kind === "channel_needs_reconnect") {
    return {
      title: `pigy can no longer post to ${account}`,
      detail: `${network} no longer takes the access that pigy was given. Connect the account again to go on posting.`,
      action: "Connect again",
    };
  }
  return {
    title: `pigy's access to ${account} is about to end`,
    detail:
      channel.expiresAt === null
        ? "Connect the account again to keep posting."
        : channel.expiresAt <= now
          ? "It has ended: connect the account again to go on posting."
          : `It ends on ${dayOf(channel.expiresAt, now)}, and ${network} does not let pigy renew it. Connect the account again before then to keep posting.`,
    action: "Connect again",
  };
}
