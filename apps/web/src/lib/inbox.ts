import type { MutatorArgs, Row, Tables } from "@pigy/core";
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

/**
 * Whether the inbox shows `notification`: not while the copy has not
 * heard of the post or the channel that it is about, or has heard that it
 * is gone before it heard the same of the notification.
 */
function isShown(tables: Tables, notification: Row<"notification">): boolean {
  return notification.kind === "post_failed"
    ? notification.postId !== null && tables.post.has(notification.postId)
    : notification.channelId !== null &&
        tables.channel.has(notification.channelId);
}

/** The notifications of the workspace, the newest first. */
export function selectInbox(tables: Tables): InboxItem[] {
  const shown = [...tables.notification.values()].filter((notification) =>
    isShown(tables, notification),
  );
  // The parts and the targets of the posts that the inbox tells of, found
  // in one pass over each table, however many notifications there are.
  const parts = new Map<string, Row<"post_part">[]>();
  const targets = new Map<string, Row<"post_target">[]>();
  for (const { kind, postId } of shown) {
    if (kind !== "post_failed" || postId === null) continue;
    parts.set(postId, []);
    targets.set(postId, []);
  }
  if (parts.size > 0) {
    for (const part of tables.post_part.values()) {
      // The text of the post itself, not what is written for one account
      // in its place.
      if (part.targetId === null) parts.get(part.postId)?.push(part);
    }
    for (const target of tables.post_target.values()) {
      targets.get(target.postId)?.push(target);
    }
  }
  const items: InboxItem[] = [];
  for (const notification of shown) {
    const { id, createdAt, readAt } = notification;
    const about = { id, createdAt, unread: readAt === null };
    if (notification.kind === "post_failed") {
      const postId = notification.postId;
      if (postId === null) continue;
      const [first] = (parts.get(postId) ?? []).sort(
        (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
      );
      items.push({
        ...about,
        kind: "post_failed",
        postId,
        text: first?.text ?? "",
        deliveries: (targets.get(postId) ?? []).map((target) => ({
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

/**
 * How many notifications the person has not read, of those that the
 * inbox shows. The shell counts them on every screen and with every
 * change of the copy, a keystroke included, so this looks at the
 * notifications alone and builds nothing.
 */
export function selectUnread(tables: Tables): number {
  let unread = 0;
  for (const notification of tables.notification.values()) {
    if (notification.readAt === null && isShown(tables, notification)) {
      unread += 1;
    }
  }
  return unread;
}

/** How many notifications one `notification.read` takes. */
const readAtOnce = 100;

/**
 * The mutations that mark every unread one of `items` as read:
 * `notification.read` with these arguments, one after the other, each
 * with as many notifications as the mutator takes. Each notification is
 * named as it was seen, with its `createdAt`: one that has come in its
 * place since is not read by this.
 */
export function readAll(
  items: InboxItem[],
): MutatorArgs<"notification.read">[] {
  const unread = items
    .filter((item) => item.unread)
    .map(({ id, createdAt }) => ({ id, createdAt }));
  const mutations: MutatorArgs<"notification.read">[] = [];
  for (let from = 0; from < unread.length; from += readAtOnce) {
    mutations.push({ notifications: unread.slice(from, from + readAtOnce) });
  }
  return mutations;
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
          : networkInfo[channel.network].renewsAccess
            ? // As the Channels screen says it: an end that is this near
              // is one that the renewals are not going to put off.
              `pigy could not renew it, and it ends on ${dayOf(channel.expiresAt, now)}. Connect the account again before then to keep posting.`
            : `It ends on ${dayOf(channel.expiresAt, now)}, and ${network} does not let pigy renew it. Connect the account again before then to keep posting.`,
    action: "Connect again",
  };
}
