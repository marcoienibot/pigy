import { z } from "zod";
import { idSchema } from "../id.ts";
import { limitsSchema } from "../network/limits.ts";
import { canonicalTimeZone, slotTimes } from "../schedule/zone.ts";
import {
  channelRowSchema,
  defaultSettings,
  defaultTimeZone,
  expiryNoticeMs,
  inReadingOrder,
  lateMs,
  maxOwnTextLength,
  maxParts,
  maxPartTextLength,
  maxScheduled,
  maxSlots,
  maxTimeZoneLength,
  notificationRowSchema,
  partsFor,
  type Row,
  scheduleSlotRowSchema,
  settingsId,
  targetLimits,
  targetPartResultRowSchema,
  targetStatusSchema,
  unscheduled,
} from "./tables.ts";
import type { Transaction } from "./transaction.ts";

/**
 * The mutators: every way to change the synced data of a workspace. A client
 * sends the name and the arguments of a mutation, never rows. The server runs
 * the mutator and its result is what counts. A client may run the same
 * mutator on its local copy first, to show the change at once.
 *
 * Some mutators are the server's own: a client that sends one is refused.
 * They change rows that stand for something only the server has, such as a
 * channel, which is nothing without its credentials.
 *
 * A mutator is synchronous and uses nothing but its arguments and the
 * transaction, so that it does the same thing wherever it runs. It either
 * completes or throws: whoever runs it discards the writes of a mutator that
 * threw.
 */

/** Why a mutation was refused. Clients branch on it. */
export const rejectionCodeSchema = z.enum([
  /** No mutator has this name. */
  "unknown_mutation",
  /** The arguments are not what the mutator takes. */
  "invalid_arguments",
  /** A row with this ID exists already. */
  "already_exists",
  /** The row that the mutation is about does not exist, or no longer. */
  "not_found",
  /**
   * The post is past being a draft, so it can no longer be edited: it is
   * scheduled, or has gone out.
   */
  "not_a_draft",
  /**
   * The post is not scheduled, or not in the queue: it has gone out, or
   * somebody took it back.
   */
  "not_scheduled",
  /** The workspace has as many slots as it can have. */
  "too_many_slots",
  /** The workspace has as many scheduled posts as it can have. */
  "too_many_scheduled",
  /** The part is the only one of its text, which has to keep one. */
  "last_part",
  /** The text has as many parts as a text can have. */
  "too_many_parts",
  /** The post has no channel to go to. */
  "no_channels",
  /** The post is on its way to its channels, and stays until it has ended. */
  "sending",
  /** The delivery has not failed, so there is nothing to try again. */
  "not_failed",
  /**
   * The delivery that the server reports on is not under way: it has
   * ended, or has been begun anew since.
   */
  "not_current",
  /** The mutation is one that only the server runs. */
  "not_allowed",
  /** The server failed. The details are in its logs. */
  "internal_error",
]);

export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

/** Thrown by a mutator that refuses to run, with the reason. */
export class MutationRejected extends Error {
  constructor(
    readonly code: RejectionCode,
    /** For people. */
    message: string,
  ) {
    super(message);
  }
}

/** Who asks for a mutation: a client over its socket, or the server itself. */
export type MutationSource = "client" | "server";

function mutator<Schema extends z.ZodType>(
  schema: Schema,
  run: (tx: Transaction, args: z.output<Schema>) => void,
  { serverOnly = false } = {},
) {
  return {
    schema,
    /** True for a mutator that a client may not ask for. */
    serverOnly,
    /** Checks `args` and runs the mutator. */
    apply(tx: Transaction, args: unknown): void {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        const path = issue?.path.join(".");
        const message = issue?.message ?? "The arguments are invalid";
        throw new MutationRejected(
          "invalid_arguments",
          path ? `${path}: ${message}` : message,
        );
      }
      run(tx, parsed.data);
    },
  };
}

const partTextSchema = z.string().max(maxPartTextLength);

/**
 * The post with this ID. A mutation about one that is gone is rejected,
 * and so is one about a post that was put aside, which is as good as
 * gone: only `post.restore` and `post.delete` are about such a post.
 */
function existingPost(tx: Transaction, id: string): Row<"post"> {
  const post = tx.get("post", id);
  if (!post || post.trashedAt !== null) {
    throw new MutationRejected("not_found", "This post no longer exists");
  }
  return post;
}

/**
 * What a mutation about a part that is gone is told. The part names its
 * post, so nothing says which of the two went: another device removed the
 * part, dropped the text of an account that it was of, or deleted the
 * post.
 */
const partGone = "This part is gone: it was removed, or its post was deleted";

/** The post with this ID, which has to be a draft: only a draft is edited. */
function draft(tx: Transaction, id: string): Row<"post"> {
  const post = existingPost(tx, id);
  if (post.status !== "draft") {
    throw new MutationRejected("not_a_draft", "Only a draft can be edited");
  }
  return post;
}

/** The target of the post `postId` that goes to `channelId`, if any. */
function targetTo(
  tx: Transaction,
  postId: string,
  channelId: string,
): Row<"post_target"> | undefined {
  return tx
    .find("post_target", "postId", postId)
    .find((target) => target.channelId === channelId);
}

/**
 * The parts of one text, in the order they are read in: those of the post
 * `postId` that are written for `targetId`, or the post's own for null.
 */
function textOf(
  tx: Transaction,
  postId: string,
  targetId: string | null,
): Row<"post_part">[] {
  return inReadingOrder(
    tx
      .find("post_part", "postId", postId)
      .filter((part) => part.targetId === targetId),
  );
}

/**
 * Stores `parts` as one text in this order: each gets its place in the
 * list as its position. Only the parts that are new or have moved are
 * written, so a part that stays where it was is no change.
 */
function inOrder(
  tx: Transaction,
  parts: readonly Row<"post_part">[],
  added?: Row<"post_part">,
): void {
  parts.forEach((part, position) => {
    if (part === added || part.position !== position) {
      tx.put("post_part", { ...part, position });
    }
  });
}

/** Removes the text that was written for `targetId`, if there is one. */
function dropOwnText(
  tx: Transaction,
  { id, postId }: Row<"post_target">,
): boolean {
  const written = textOf(tx, postId, id);
  for (const part of written) tx.delete("post_part", part.id);
  return written.length > 0;
}

/**
 * Gives a post the status that follows from its targets, when one of them
 * has changed: `sending` while any of them is on its way or waits its
 * turn, `sent` when all of them are sent, and `error` when all have ended
 * and not all of them well. A post whose targets ended differently is in
 * `error`: its targets say which of them arrived.
 */
function settle(tx: Transaction, postId: string): void {
  const post = tx.get("post", postId);
  if (!post) return;
  const targets = tx.find("post_target", "postId", postId);
  const status = targets.some(
    (target) => target.status === "queued" || target.status === "sending",
  )
    ? "sending"
    : targets.every((target) => target.status === "sent")
      ? "sent"
      : "error";
  if (status === post.status) return;
  tx.put("post", { ...post, status, updatedAt: tx.now });
  // Its deliveries have all ended: this is where the inbox says how, once
  // for the post, and nowhere else.
  if (post.status === "sending") announce(tx, post, status, targets);
}

/**
 * Tells the person, in the inbox, how the post `post` has ended, which was
 * `sending` until now and is `status` from now on. There is a
 * notification if a delivery has ended badly by itself since the post
 * last began to be sent: failed, or ended with nobody knowing how.
 *
 * Not for a delivery that ended because the person disconnected its
 * account: they did that themselves. And not for one that had failed
 * before: the person was told of it then, and has tried other deliveries
 * again since, which is all that happened now. If those arrived, nothing
 * is new.
 */
function announce(
  tx: Transaction,
  post: Row<"post">,
  status: Row<"post">["status"],
  targets: Row<"post_target">[],
): void {
  // Nothing changes a post while it is sending, so this is when it last
  // began to be: when it was published, or when a delivery of it was
  // tried again after all had ended. The deliveries that were asked for
  // then, or since, are the ones that have ended now.
  const since = post.updatedAt;
  const endedBadly = targets.some(
    (target) =>
      (target.status === "error" || target.status === "uncertain") &&
      !target.disconnected &&
      target.queuedAt !== null &&
      target.queuedAt >= since,
  );
  if (status === "error" && endedBadly) {
    notifyOfPost(tx, post.id);
  } else if (tx.get("notification", post.id)?.postId === post.id) {
    tx.delete("notification", post.id);
  }
}

/**
 * The post with this ID, which has not gone out: a draft, or one that is
 * scheduled. Only such a post is given a time, or sent.
 */
function unsent(tx: Transaction, id: string): Row<"post"> {
  const post = existingPost(tx, id);
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new MutationRejected("not_a_draft", "This post has gone out already");
  }
  return post;
}

/** Whether a post is in the queue. Not one that was put aside. */
const inQueue = (post: Row<"post">) =>
  post.status === "scheduled" &&
  post.mode === "queue" &&
  post.trashedAt === null;

/** How many posts are scheduled, the queue included. */
const scheduledCount = (tx: Transaction) =>
  tx
    .find("post", "status", "scheduled")
    .filter((post) => post.trashedAt === null).length;

/** The posts of the queue, in its order. */
function queueOf(tx: Transaction): Row<"post">[] {
  return tx
    .find("post", "status", "scheduled")
    .filter(inQueue)
    .sort(
      (a, b) =>
        (a.queuePosition ?? 0) - (b.queuePosition ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
}

/** The settings of the workspace, also of one that has set nothing. */
function settingsOf(tx: Transaction): Row<"settings"> {
  return tx.get("settings", settingsId) ?? defaultSettings;
}

/** Every slot of the workspace. */
function slotsOf(tx: Transaction): Row<"schedule_slot">[] {
  return [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
    tx.find("schedule_slot", "weekday", weekday),
  );
}

/**
 * The places of the posts of `queue` in this order: each keeps the place
 * that it has where that is after the place of the post before it, and
 * takes the next number where it is not, or has none. A post without a
 * place that comes to the front takes the number before the first place.
 * So the places only have to grow along the queue, and may leave numbers
 * out: a post that leaves the queue changes no other post, and one that
 * enters it at either end changes none either.
 */
function placesOf(queue: readonly Row<"post">[]): number[] {
  const places: number[] = [];
  queue.forEach((post, index) => {
    const before = places[index - 1];
    let place = post.queuePosition;
    if (before === undefined) {
      if (place === null) {
        const next = queue.find(
          (other) => other.queuePosition !== null,
        )?.queuePosition;
        place = next === undefined || next === null ? 0 : next - 1;
      }
    } else if (place === null || place <= before) {
      place = before + 1;
    }
    places.push(place);
  });
  return places;
}

/**
 * Stores `queue` as the queue, in this order, and gives each post its
 * time: the posts take the slots after now, one each, in their order. It
 * is run whenever the queue, the slots, the time zone or the pause
 * changes, so the times that are stored are always the ones that follow
 * from them. Time passing changes nothing: the post at the front goes out
 * at its time, and the others have theirs already.
 *
 * - While the queue is paused, and while the workspace has no slot, no
 *   post of it has a time.
 * - A post whose time has come keeps it, and takes no slot: it is as good
 *   as gone. The server takes it up before it runs another mutation, so
 *   this is for a client, which shows such a post until the server has
 *   said what became of it. Not while the queue is paused: that holds
 *   every post of it.
 *
 * Only the posts that change are written, and those of `changed`, which
 * the caller has changed otherwise.
 *
 * This is the one costly thing that a mutator does, so a mutator runs it
 * once, however many posts it changes. What it costs is bounded: a
 * workspace has `maxScheduled` posts in its queue at most, and `timeOf`
 * keeps the moments of the slots. That also bounds what a client pays
 * that runs its unconfirmed mutations again with every change, a
 * keystroke included.
 */
function requeue(
  tx: Transaction,
  queue: readonly Row<"post">[] = queueOf(tx),
  changed: ReadonlySet<Row<"post">> = new Set(),
): void {
  requeues.count += 1;
  const { timeZone, queuePaused } = settingsOf(tx);
  if (!queuePaused) requeues.timed += 1;
  const times = queuePaused
    ? undefined
    : slotTimes(timeZone ?? defaultTimeZone, slotsOf(tx), tx.now);
  const places = placesOf(queue);
  queue.forEach((post, index) => {
    const queuePosition = places[index] ?? 0;
    const due = !queuePaused && post.dueAt !== null && post.dueAt <= tx.now;
    const dueAt = due ? post.dueAt : (times?.next().value ?? null);
    if (
      changed.has(post) ||
      post.queuePosition !== queuePosition ||
      post.dueAt !== dueAt
    ) {
      tx.put("post", { ...post, queuePosition, dueAt });
    }
  });
}

/**
 * How often the posts of a queue were given their times, for a test that
 * says that a mutator does it once.
 */
export const requeues = {
  count: 0,
  /**
   * How often of those the clocks of the time zone were read, which is
   * what costs: not while the queue is paused, where no post has a time.
   */
  timed: 0,
};

/**
 * Makes a draft of a post that was scheduled: nothing says when it goes
 * out any more, and the inbox no longer says that it was held. The queue
 * closes up behind a post that was in it, unless the caller does that
 * itself, `closeUp`, for all the posts that it takes out of the queue at
 * once.
 */
function toDraft(tx: Transaction, post: Row<"post">, closeUp = true): void {
  const queued = inQueue(post);
  // Nobody has to decide about a post that was held any more.
  forgetNoticeOfPost(tx, post.id);
  tx.put("post", {
    ...post,
    ...unscheduled,
    status: "draft",
    updatedAt: tx.now,
  });
  if (queued && closeUp) requeue(tx);
}

/** Deletes the post `id` with everything that is its own. */
function deletePost(tx: Transaction, id: string): void {
  // What refers to something goes before it: a result cannot be without
  // its target and its part, a part that is written for a target not
  // without that target, and none of them without the post.
  const targets = tx.find("post_target", "postId", id);
  for (const target of targets) {
    for (const result of tx.find("target_part_result", "targetId", target.id)) {
      tx.delete("target_part_result", result.id);
    }
  }
  for (const part of tx.find("post_part", "postId", id)) {
    tx.delete("post_part", part.id);
  }
  for (const target of targets) tx.delete("post_target", target.id);
  // What the inbox says of the post, which is under the ID of the post.
  forgetNoticeOfPost(tx, id);
  const post = tx.get("post", id);
  tx.delete("post", id);
  // The queue closes up behind a post that was in it.
  if (post && inQueue(post)) requeue(tx);
}

/**
 * Refuses to schedule `post` if the workspace has as many scheduled posts
 * as it can have, the queue included. Not for a post that is scheduled
 * already, which is given another time or place. A post that was put
 * aside does not count: it is as good as gone.
 */
function roomFor(tx: Transaction, post: Row<"post">): void {
  if (post.status !== "scheduled" && scheduledCount(tx) >= maxScheduled) {
    throw new MutationRejected(
      "too_many_scheduled",
      `A workspace has at most ${maxScheduled} scheduled posts`,
    );
  }
}

/**
 * Takes up the scheduled post `post`, whose time has come.
 *
 * - A post that is at most `lateMs` late is sent, the way `post.publish`
 *   sends one: its targets wait their turn. It keeps its `mode` and its
 *   `dueAt`, which say when it was to go out.
 * - A post with a time that somebody chose which is later than that is
 *   held: it stays `scheduled`, with `heldAt`, until somebody decides,
 *   and the inbox tells them that they have to, with a notification of
 *   the kind `post_held`. Here and nowhere else: this is where a post
 *   comes to be held.
 * - Of the queue, one post goes out at a time. When the time of several
 *   has come, because nobody looked for a while, the first of them is
 *   sent if it is at most `lateMs` late, and the others take the slots
 *   after now, in their order: they do not go out one after the other at
 *   once, which is what the slots are there to keep from happening. So
 *   does the first if it is later than that. `post` is one of them, and
 *   this is done for all of them.
 */
function takeUp(tx: Transaction, post: Row<"post"> & { dueAt: number }): void {
  const late = (dueAt: number) => tx.now - dueAt > lateMs;
  if (!inQueue(post)) {
    if (late(post.dueAt)) {
      tx.put("post", { ...post, heldAt: tx.now, updatedAt: tx.now });
      notifyOfPost(tx, post.id, "post_held");
    } else {
      send(tx, post, { mode: post.mode, dueAt: post.dueAt });
    }
    return;
  }
  const queue = queueOf(tx);
  const isDue = ({ dueAt }: Row<"post">) => dueAt !== null && dueAt <= tx.now;
  const first = queue.find(isDue);
  const sent =
    first && first.dueAt !== null && !late(first.dueAt) ? first : undefined;
  // Without the time that has passed, so that each is given another: a
  // post whose time has come would keep it.
  const moved = new Set<Row<"post">>();
  const rest = queue.flatMap((other) => {
    if (other === sent) return [];
    if (!isDue(other)) return [other];
    const later = { ...other, dueAt: null, updatedAt: tx.now };
    moved.add(later);
    return [later];
  });
  if (sent) send(tx, sent, { mode: sent.mode, dueAt: sent.dueAt }, false);
  requeue(tx, rest, moved);
}

/**
 * Sends a post that has not gone out to its channels: it is `sending`
 * from here on, and its targets wait their turn. `scheduled` says what is
 * kept of when it was to go out: nothing for a post that somebody asked to
 * be sent at once. What the inbox said of the post goes: that it was
 * held, which is all that the inbox says of a post that has not gone out.
 */
function send(
  tx: Transaction,
  post: Row<"post">,
  scheduled: Pick<Row<"post">, "mode" | "dueAt"> = unscheduled,
  closeUp = true,
): void {
  const targets = tx.find("post_target", "postId", post.id);
  if (targets.length === 0) {
    throw new MutationRejected(
      "no_channels",
      "Choose an account to publish to first",
    );
  }
  const queued = inQueue(post);
  forgetNoticeOfPost(tx, post.id);
  for (const target of targets) {
    tx.put("post_target", { ...target, status: "queued", queuedAt: tx.now });
  }
  tx.put("post", {
    ...post,
    ...unscheduled,
    ...scheduled,
    status: "sending",
    updatedAt: tx.now,
  });
  if (queued && closeUp) requeue(tx);
}

/**
 * The target that the server reports on: the one with this ID, if it is on
 * its way in the attempt that the report is from. A report that comes late
 * is rejected: the delivery was ended since, by a disconnect for example,
 * or ended and begun anew.
 */
function currentTarget(
  tx: Transaction,
  id: string,
  attempt: number,
): Row<"post_target"> {
  const target = tx.get("post_target", id);
  if (target?.status !== "sending" || target.attempt !== attempt) {
    throw new MutationRejected(
      "not_current",
      "This delivery is no longer under way",
    );
  }
  return target;
}

/**
 * Tells the person something about the post `postId`, in the inbox, or
 * tells them again: the notification is new and unread. A post has one,
 * under its own ID. It says that the post has ended and has not arrived
 * everywhere, `post_failed`, or that the post was not sent at its time
 * and waits for them to decide, `post_held`: a post is never both, because
 * one that is held has not gone out.
 */
function notifyOfPost(
  tx: Transaction,
  postId: string,
  kind: "post_failed" | "post_held" = "post_failed",
): void {
  tx.put("notification", {
    id: postId,
    kind,
    postId,
    channelId: null,
    createdAt: tx.now,
    readAt: null,
  });
}

/**
 * Takes what the inbox says of the post `postId` away, if it says
 * anything: what it told of is dealt with, or the post is gone.
 */
function forgetNoticeOfPost(tx: Transaction, postId: string): void {
  if (tx.get("notification", postId)?.postId === postId) {
    tx.delete("notification", postId);
  }
}

/**
 * Tells the person something about a channel, in the inbox. A channel has
 * one notification, under its own ID: what is said later takes the place
 * of what was said before.
 */
function notifyOfChannel(
  tx: Transaction,
  channelId: string,
  kind: "channel_needs_reconnect" | "channel_expiring",
): void {
  tx.put("notification", {
    id: channelId,
    kind,
    postId: null,
    channelId,
    createdAt: tx.now,
    readAt: null,
  });
}

/** A notification as a device has seen it: see `notification.read`. */
const seenNotificationSchema = notificationRowSchema.pick({
  id: true,
  createdAt: true,
});

/** The notification that `seen` names, if it is still the one that was seen. */
function seenNotification(
  tx: Transaction,
  seen: z.infer<typeof seenNotificationSchema>,
): Row<"notification"> | undefined {
  const notification = tx.get("notification", seen.id);
  return notification?.createdAt === seen.createdAt ? notification : undefined;
}

// What a target is told when its account is disconnected under it. The
// migration that added `disconnected` to the targets of a workspace found
// the ones from before by this text: a change of the words here does not
// reach it, and need not.
const disconnectedMessage =
  "The account was disconnected before the post was sent.";

export const mutators = {
  /**
   * Creates a draft with its first part. A post always has at least one
   * part. The text may be empty.
   */
  "post.create": mutator(
    z.strictObject({ id: idSchema, partId: idSchema, text: partTextSchema }),
    (tx, { id, partId, text }) => {
      if (tx.get("post", id) || tx.get("post_part", partId)) {
        throw new MutationRejected(
          "already_exists",
          "This post exists already",
        );
      }
      tx.put("post", {
        id,
        status: "draft",
        createdAt: tx.now,
        updatedAt: tx.now,
        ...unscheduled,
      });
      tx.put("post_part", {
        id: partId,
        postId: id,
        targetId: null,
        position: 0,
        text,
      });
    },
  ),

  /**
   * Replaces the text of one part of a draft: of its own text, or of the
   * text that is written for one of its accounts.
   */
  "part.setText": mutator(
    z.strictObject({ id: idSchema, text: partTextSchema }),
    (tx, { id, text }) => {
      const part = tx.get("post_part", id);
      const post = part && tx.get("post", part.postId);
      // The part can be gone while its post is there: another device
      // removed it, or dropped the text of an account that it was of.
      if (!part || !post) {
        throw new MutationRejected("not_found", partGone);
      }
      if (post.status !== "draft") {
        throw new MutationRejected("not_a_draft", "Only a draft can be edited");
      }
      tx.put("post_part", { ...part, text });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Adds a part to a text of a draft: to the post's own, or with
   * `channelId` to the text that is written for that account. The part
   * goes after the part `afterId`, or first for null.
   *
   * A mutation names the part to go after and no position: the order is
   * kept where the mutations are run one after the other, and two devices
   * that add a part at the same place both get theirs in, the later one
   * nearer to the part that both named. If that part is gone by now, or
   * is not of this text, the new one goes to the end: what was typed
   * into it is kept.
   *
   * Not so with `mustFollow`, which is for a part that continues a text
   * of the client's own making, as the parts of a text that is brought
   * back do: it goes after the part that it names or nowhere. If that
   * part is not of this text, the text is another one than the client
   * began, and the part is refused rather than put at its end.
   *
   * A part for an account whose text is gone is refused, whether the text
   * was dropped or went with its target: it is never put anywhere else.
   */
  "part.add": mutator(
    z.strictObject({
      id: idSchema,
      postId: idSchema,
      channelId: idSchema.nullable(),
      afterId: idSchema.nullable(),
      mustFollow: z.boolean().optional(),
      text: partTextSchema,
    }),
    (tx, { id, postId, channelId, afterId, mustFollow, text }) => {
      const post = draft(tx, postId);
      if (tx.get("post_part", id)) {
        throw new MutationRejected(
          "already_exists",
          "This part exists already",
        );
      }
      const target =
        channelId === null ? undefined : targetTo(tx, postId, channelId);
      // A part for an account is a part of the text of its target, and of
      // no other: when the post no longer goes there, the account was left
      // out or disconnected since, and what was written for it has gone
      // with it. The post's own text, which the other accounts get, is
      // not the place for it.
      if (channelId !== null && !target) {
        throw new MutationRejected(
          "not_found",
          "The post no longer goes to this account",
        );
      }
      const parts = textOf(tx, postId, target?.id ?? null);
      // A text for an account begins with `target.customize`. One that
      // was dropped since is not begun anew by a part that was meant for
      // the middle of it.
      if (target && parts.length === 0) {
        throw new MutationRejected(
          "not_found",
          "This account no longer has a text of its own",
        );
      }
      if (parts.length >= maxParts) {
        throw new MutationRejected(
          "too_many_parts",
          `A post has at most ${maxParts} parts`,
        );
      }
      const added = {
        id,
        postId,
        targetId: target?.id ?? null,
        position: 0,
        text,
      };
      const after = parts.findIndex((part) => part.id === afterId);
      if (mustFollow && afterId !== null && after < 0) {
        throw new MutationRejected(
          "not_found",
          "The text that this part continues is no longer there",
        );
      }
      parts.splice(
        afterId === null ? 0 : after < 0 ? parts.length : after + 1,
        0,
        added,
      );
      inOrder(tx, parts, added);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Removes a part from its text. Does nothing if the part is gone: two
   * devices can remove the same part. A text keeps one part: the last one
   * is not removed. The text of an account goes as a whole, with
   * `target.followPost`.
   */
  "part.remove": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const part = tx.get("post_part", id);
    if (!part) return;
    const post = draft(tx, part.postId);
    const parts = textOf(tx, part.postId, part.targetId);
    if (parts.length === 1) {
      throw new MutationRejected(
        "last_part",
        "The only part of a text cannot be removed",
      );
    }
    tx.delete("post_part", id);
    inOrder(
      tx,
      parts.filter((other) => other.id !== id),
    );
    tx.put("post", { ...post, updatedAt: tx.now });
  }),

  /**
   * Moves a part within its text: to after the part `afterId`, or to the
   * beginning for null. Like `part.add`, it names a part and no position.
   * If the part to go after is gone by now, or is not of this text, the
   * part stays where it is.
   */
  "part.move": mutator(
    z.strictObject({ id: idSchema, afterId: idSchema.nullable() }),
    (tx, { id, afterId }) => {
      const part = tx.get("post_part", id);
      if (!part) {
        throw new MutationRejected("not_found", partGone);
      }
      const post = draft(tx, part.postId);
      const parts = textOf(tx, part.postId, part.targetId);
      const others = parts.filter((other) => other.id !== id);
      const after = others.findIndex((other) => other.id === afterId);
      if (afterId !== null && after < 0) return;
      // The row as `textOf` handed it out, so that `inOrder` compares it
      // with the place it had.
      const moved = parts.find((other) => other.id === id);
      if (!moved) return;
      others.splice(afterId === null ? 0 : after + 1, 0, moved);
      if (others.every((other, index) => other === parts[index])) return;
      inOrder(tx, others);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Deletes a post with its parts, those that are written for one account
   * included, its targets and what they published.
   * Deleting a post that does not exist does nothing and is not an error:
   * two devices can delete the same post.
   *
   * A post that is being sent stays until all its targets have ended.
   * Deleted in the middle, it would leave posts on the networks that pigy
   * knows nothing of.
   *
   * With `ifTrashed` only a post that was put aside is deleted, and
   * nothing is done to any other: that is the second step of deleting a
   * scheduled post, which follows `post.trash` when the Undo is no
   * longer offered. The first step may have been refused, because the
   * post had gone out by then, or taken back by the Undo of another
   * device: the post is then not this deletion's to delete, and whoever
   * made it has been told, or has nothing to be told.
   */
  "post.delete": mutator(
    z.strictObject({ id: idSchema, ifTrashed: z.literal(true).optional() }),
    (tx, { id, ifTrashed }) => {
      const post = tx.get("post", id);
      if (ifTrashed && (!post || post.trashedAt === null)) return;
      if (post?.status === "sending") {
        throw new MutationRejected(
          "sending",
          "A post cannot be deleted while it is being sent",
        );
      }
      deletePost(tx, id);
    },
  ),

  /**
   * Chooses a channel for a draft to go to. Does nothing if the draft goes
   * there already: two devices can choose the same channel, and the target
   * that came first stays.
   */
  "target.add": mutator(
    z.strictObject({ id: idSchema, postId: idSchema, channelId: idSchema }),
    (tx, { id, postId, channelId }) => {
      const post = existingPost(tx, postId);
      if (post.status !== "draft") {
        throw new MutationRejected(
          "not_a_draft",
          "Only a draft can change where it goes",
        );
      }
      if (!tx.get("channel", channelId)) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      const chosen = tx
        .find("post_target", "postId", postId)
        .some((target) => target.channelId === channelId);
      if (chosen) return;
      if (tx.get("post_target", id)) {
        throw new MutationRejected(
          "already_exists",
          "This target exists already",
        );
      }
      tx.put("post_target", {
        id,
        postId,
        channelId,
        status: "pending",
        attempt: 0,
        error: null,
        queuedAt: null,
        sentAt: null,
        disconnected: false,
      });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Takes a channel back from where a draft goes. The target is named by
   * its post and its channel, not by its ID: of two devices that chose the
   * channel, one has made up an ID that the server never took. Does nothing
   * if the draft does not go there.
   */
  "target.remove": mutator(
    z.strictObject({ postId: idSchema, channelId: idSchema }),
    (tx, { postId, channelId }) => {
      const post = existingPost(tx, postId);
      if (post.status !== "draft") {
        throw new MutationRejected(
          "not_a_draft",
          "Only a draft can change where it goes",
        );
      }
      const target = tx
        .find("post_target", "postId", postId)
        .find((candidate) => candidate.channelId === channelId);
      if (!target) return;
      // The text that was written for the account goes with the choice.
      dropOwnText(tx, target);
      tx.delete("post_target", target.id);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Gives an account of a draft a text of its own, in place of the post's:
   * `parts`, in this order, which the app fills with the post's text as it
   * is, for the person to change. From then on the account gets these
   * parts, however many there are, and the post's own text goes to the
   * other accounts.
   *
   * The whole text comes in one mutation, so that an account never has
   * half of one, and so that of two devices that begin one, one wins as a
   * whole: does nothing if the account has a text of its own already. The
   * account is named by its channel, like in `target.remove`.
   */
  "target.customize": mutator(
    z.strictObject({
      postId: idSchema,
      channelId: idSchema,
      parts: z
        .array(z.strictObject({ id: idSchema, text: partTextSchema }))
        .min(1)
        .max(maxParts)
        .refine(
          (parts) =>
            parts.reduce((length, { text }) => length + text.length, 0) <=
            maxOwnTextLength,
          `The text is longer than ${maxOwnTextLength} characters`,
        ),
    }),
    (tx, { postId, channelId, parts }) => {
      const post = draft(tx, postId);
      const target = targetTo(tx, postId, channelId);
      if (!target) {
        throw new MutationRejected(
          "not_found",
          "The post no longer goes to this account",
        );
      }
      if (textOf(tx, postId, target.id).length > 0) return;
      parts.forEach(({ id, text }, position) => {
        if (
          tx.get("post_part", id) ||
          parts.findIndex((part) => part.id === id) !== position
        ) {
          throw new MutationRejected(
            "already_exists",
            "This part exists already",
          );
        }
        tx.put("post_part", {
          id,
          postId,
          targetId: target.id,
          position,
          text,
        });
      });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Takes the text that was written for an account away again: the
   * account gets the post's own text, like the others. Does nothing if it
   * does so already, or if the post does not go there.
   */
  "target.followPost": mutator(
    z.strictObject({ postId: idSchema, channelId: idSchema }),
    (tx, { postId, channelId }) => {
      const post = draft(tx, postId);
      const target = targetTo(tx, postId, channelId);
      if (!target || !dropOwnText(tx, target)) return;
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Asks for a post to be sent to its channels now: a draft, or one that is
   * scheduled, which then does not wait for its time. The post is `sending`
   * from here on and can no longer be edited, and its targets wait their
   * turn. The server takes it from there: a client sees the targets change
   * as they go out.
   */
  "post.publish": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    send(tx, unsent(tx, id));
  }),

  /**
   * Gives a post a time at which it goes out: a draft, or one that is
   * scheduled already, whether for another time or in the queue, which it
   * leaves. The post is `scheduled` from here on, and can no longer be
   * edited: to change it, it is taken back to the drafts first.
   *
   * A time that has passed is not refused. A device can schedule a post
   * without a connection, and the server learns of it when the time has
   * come and gone. Such a post is taken up at once, here, the way
   * `post.due` takes up a post whose time the server finds out late: it
   * is sent, or held if it is too late for that. A client does the same
   * to what it shows, by its own clock.
   */
  "post.schedule": mutator(
    z.strictObject({
      id: idSchema,
      // Up to the last moment that a date can hold.
      dueAt: z.number().int().nonnegative().max(8.64e15),
    }),
    (tx, { id, dueAt }) => {
      const post = unsent(tx, id);
      roomFor(tx, post);
      if (tx.find("post_target", "postId", id).length === 0) {
        throw new MutationRejected(
          "no_channels",
          "Choose an account to publish to first",
        );
      }
      const queued = inQueue(post);
      const scheduled = {
        ...post,
        status: "scheduled",
        mode: "custom",
        dueAt,
        queuePosition: null,
        heldAt: null,
        updatedAt: tx.now,
      } as const;
      tx.put("post", scheduled);
      // A post that was held has a time again: the inbox need not say
      // that somebody has to decide. If the new time is too late as
      // well, it says so anew, below.
      forgetNoticeOfPost(tx, id);
      if (queued) requeue(tx);
      if (dueAt <= tx.now) takeUp(tx, scheduled);
    },
  ),

  /**
   * Puts a post into the queue: a draft, or one that is scheduled for a
   * time that somebody chose. It goes to the end of the queue, and gets
   * the first slot that no post before it has, or with `first` to the
   * front, where it gets the next slot and every other post the one after
   * its own. The post is `scheduled` from here on.
   *
   * A post that is in the queue already stays where it is, and moves to
   * the front with `first`. While the queue is paused or the workspace has
   * no slot, the post is in the queue without a time.
   */
  "post.enqueue": mutator(
    z.strictObject({ id: idSchema, first: z.boolean() }),
    (tx, { id, first }) => {
      const post = unsent(tx, id);
      roomFor(tx, post);
      if (tx.find("post_target", "postId", id).length === 0) {
        throw new MutationRejected(
          "no_channels",
          "Choose an account to publish to first",
        );
      }
      const queued = inQueue(post);
      if (queued && !first) return;
      // A post that was held is in the queue from here on, and no longer
      // held: only a post with a time that somebody chose is.
      forgetNoticeOfPost(tx, id);
      const entered: Row<"post"> = queued
        ? post
        : {
            ...post,
            status: "scheduled",
            mode: "queue",
            dueAt: null,
            queuePosition: null,
            heldAt: null,
            updatedAt: tx.now,
          };
      const others = queueOf(tx).filter((other) => other.id !== id);
      requeue(
        tx,
        first
          ? // At the front it takes a place anew, before the first.
            [{ ...entered, queuePosition: null }, ...others]
          : [...others, entered],
        new Set(queued ? [] : [entered]),
      );
    },
  ),

  /**
   * Moves a post within the queue: to after the post `afterId`, or to the
   * front for null. Like `part.move`, it names a post and no position, so
   * that two devices which reorder at once leave one order behind. If the
   * post to go after is not in the queue, or no longer, the post stays
   * where it is. The posts of the queue then take the slots in their new
   * order.
   */
  "post.move": mutator(
    z.strictObject({ id: idSchema, afterId: idSchema.nullable() }),
    (tx, { id, afterId }) => {
      const post = existingPost(tx, id);
      if (!inQueue(post)) {
        throw new MutationRejected(
          "not_scheduled",
          "This post is no longer in the queue",
        );
      }
      const queue = queueOf(tx);
      const others = queue.filter((other) => other.id !== id);
      const after = others.findIndex((other) => other.id === afterId);
      if (afterId !== null && after < 0) return;
      const moved = queue.find((other) => other.id === id);
      if (!moved) return;
      others.splice(afterId === null ? 0 : after + 1, 0, moved);
      if (others.every((other, index) => other === queue[index])) return;
      // The post that moves takes a place anew, between its neighbours
      // where there is room, so that the others keep theirs.
      requeue(
        tx,
        others.map((other) =>
          other === moved ? { ...moved, queuePosition: null } : other,
        ),
      );
    },
  ),

  /**
   * Takes a scheduled post back to the drafts: nothing says when it goes
   * out any more, and it can be edited again. Does nothing to a draft: two
   * devices can take the same post back.
   */
  "post.unschedule": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const post = existingPost(tx, id);
    if (post.status === "draft") return;
    if (post.status !== "scheduled") {
      throw new MutationRejected(
        "not_scheduled",
        "This post has gone out already",
      );
    }
    toDraft(tx, post);
  }),

  /**
   * Puts a scheduled post aside: the first step of deleting it from the
   * Queue screen, which `post.restore` takes back. From here on the post
   * is as good as gone, for every mutator but that one and `post.delete`:
   * it is not due, the queue closes up behind it, and it does not count
   * among the scheduled posts. Its row stays, with its parts, its targets
   * and the texts of its accounts, and with what says when it was to go
   * out: the time that somebody chose, or its place in the queue.
   *
   * Only a post that is scheduled is put aside. One that has gone out,
   * or that somebody took back to the drafts, is refused: a device that
   * has not heard of that must not delete the post from the Sent screen
   * or the drafts of every other. Does nothing if the post is gone or put
   * aside already: two devices can delete the same post.
   *
   * Deleting is two steps so that its Undo is no new post. An Undo that
   * made a copy would have to prove that the post it copies was deleted
   * by the deletion that it undoes, and not published first and deleted
   * from Sent later, and not undone by another device as well. This
   * way there is one row, and every step is about it and does nothing
   * where it does not apply: whatever order the steps of several devices
   * arrive in, the post goes out once at most.
   */
  "post.trash": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const post = tx.get("post", id);
    if (!post || post.trashedAt !== null) return;
    if (post.status !== "scheduled") {
      throw new MutationRejected(
        "not_scheduled",
        post.status === "draft"
          ? "This post is back in the drafts: somebody took it back"
          : "This post has gone out already",
      );
    }
    const queued = inQueue(post);
    // As good as gone, so the inbox says nothing of it any more. If it
    // was held and comes back, it is held still, and the inbox does not
    // say so a second time: whoever takes the deletion back has the post
    // before them, on the Queue screen, which says it.
    forgetNoticeOfPost(tx, id);
    tx.put("post", {
      ...post,
      // A post of the queue has no time while it is put aside, and is
      // given one anew when it comes back.
      dueAt: queued ? null : post.dueAt,
      trashedAt: tx.now,
      updatedAt: tx.now,
    });
    if (queued) requeue(tx);
  }),

  /**
   * Takes back that a post was put aside: the Undo of deleting a
   * scheduled post. Does nothing if the post is not put aside, or is
   * gone: the first step was refused, the post was deleted for good, or
   * another device has taken it back already.
   *
   * The post is scheduled again as it was, by the rules of scheduling:
   *
   * - A post of the queue is in the queue again, at its place if no
   *   other post has taken that, and the posts take the slots anew.
   * - A post with a time that somebody chose has that time. If it has
   *   passed meanwhile, the post is taken up as `post.schedule` takes up
   *   one that is scheduled for the past: sent, or held if it is too
   *   late for that, which the inbox then tells of. One that was held
   *   before it was put aside is held still, and the inbox says nothing
   *   of it again: `post.trash` has why.
   * - A post that has no account left, because its accounts were
   *   disconnected meanwhile, is a draft. So is one for which the
   *   workspace has no room, because as many posts were scheduled
   *   meanwhile as it can have: nothing is lost, and somebody schedules
   *   it again.
   */
  "post.restore": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const post = tx.get("post", id);
    if (!post || post.trashedAt === null) return;
    const back = { ...post, trashedAt: null, updatedAt: tx.now };
    if (
      tx.find("post_target", "postId", id).length === 0 ||
      scheduledCount(tx) >= maxScheduled
    ) {
      tx.put("post", { ...back, ...unscheduled, status: "draft" });
      return;
    }
    tx.put("post", back);
    if (inQueue(back)) {
      requeue(tx);
    } else if (
      back.dueAt !== null &&
      back.dueAt <= tx.now &&
      back.heldAt === null
    ) {
      takeUp(tx, { ...back, dueAt: back.dueAt });
    }
  }),

  /**
   * Adds a slot to the queue: a time of the week at which it sends its
   * next post. Does nothing if the workspace has a slot at that time
   * already: two devices can add the same one. The posts of the queue take
   * the slots anew.
   */
  "slot.add": mutator(scheduleSlotRowSchema, (tx, slot) => {
    const slots = slotsOf(tx);
    if (
      slots.some(
        ({ weekday, minute }) =>
          weekday === slot.weekday && minute === slot.minute,
      )
    ) {
      return;
    }
    if (tx.get("schedule_slot", slot.id)) {
      throw new MutationRejected("already_exists", "This slot exists already");
    }
    if (slots.length >= maxSlots) {
      throw new MutationRejected(
        "too_many_slots",
        `A queue has at most ${maxSlots} posting times`,
      );
    }
    tx.put("schedule_slot", slot);
    requeue(tx);
  }),

  /**
   * Removes a slot from the queue. Does nothing if it is gone. The posts
   * of the queue take the slots that are left, and have no time when none
   * is.
   */
  "slot.remove": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    if (!tx.get("schedule_slot", id)) return;
    tx.delete("schedule_slot", id);
    requeue(tx);
  }),

  /**
   * Pauses the queue, or lets it go on. While it is paused none of its
   * posts goes out, and none has a time. When it goes on, the posts take
   * the slots after that moment: a slot that passed meanwhile was not
   * used. A post with a time that somebody chose is not concerned.
   */
  "queue.setPaused": mutator(
    z.strictObject({ paused: z.boolean() }),
    (tx, { paused }) => {
      const settings = settingsOf(tx);
      if (settings.queuePaused === paused) return;
      tx.put("settings", { ...settings, queuePaused: paused });
      requeue(tx);
    },
  ),

  /**
   * Sets the time zone that the slots of the queue are in. With
   * `onlyIfUnset` it does nothing for a workspace that has one: that is
   * how the app gives a workspace the zone of the device on which its
   * first slot is added or its first post is scheduled. The posts of the queue take the slots as they are in the new zone.
   *
   * The zone has to be one that the server knows: a mutator that computed
   * with a zone it does not know would compute with another. It is stored
   * under the name that whoever runs the mutator has for it,
   * `canonicalTimeZone`: "europe/rome" as "Europe/Rome". So a workspace
   * has one spelling of its zone, the server's, whatever a client sent,
   * and what is stored is one of the few hundred names that the server
   * has, not one of the many ways to write them.
   */
  "settings.setTimeZone": mutator(
    z.strictObject({
      timeZone: z.string().min(1).max(maxTimeZoneLength),
      onlyIfUnset: z.boolean().optional(),
    }),
    (tx, args) => {
      const { onlyIfUnset } = args;
      const timeZone = canonicalTimeZone(args.timeZone);
      if (timeZone === null || timeZone.length > maxTimeZoneLength) {
        throw new MutationRejected(
          "invalid_arguments",
          "timeZone: This is not a time zone that pigy knows",
        );
      }
      const settings = settingsOf(tx);
      if (settings.timeZone === timeZone) return;
      if (onlyIfUnset && settings.timeZone !== null) return;
      tx.put("settings", { ...settings, timeZone });
      requeue(tx);
    },
  ),

  /**
   * Asks for a delivery that failed to be tried again. It goes on from the
   * parts that are published, at the end of the queue of its channel, and
   * its post is `sending` again.
   */
  "target.retry": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const target = tx.get("post_target", id);
    if (!target) {
      throw new MutationRejected("not_found", "This post no longer exists");
    }
    if (target.status !== "error" && target.status !== "uncertain") {
      throw new MutationRejected(
        "not_failed",
        "Only a delivery that has failed can be tried again",
      );
    }
    if (!tx.get("channel", target.channelId)) {
      throw new MutationRejected(
        "not_found",
        "This account is no longer connected",
      );
    }
    tx.put("post_target", {
      ...target,
      status: "queued",
      error: null,
      queuedAt: tx.now,
    });
    settle(tx, target.postId);
    // The post is on its way again: what the inbox said of how it ended
    // is no longer so. It says so anew if this try ends badly too.
    if (tx.get("notification", target.postId)?.postId === target.postId) {
      tx.delete("notification", target.postId);
    }
  }),

  /**
   * Stores the account that somebody has just connected, as a channel that
   * is good to use. An account has one channel: if the workspace has one
   * for it already, that channel is brought up to date and keeps its ID,
   * and `id` is not used. The server runs this when a network has handed it
   * the access to the account, and stores that access with the channel.
   *
   * `limits` is what the network said the account may post, or null if it
   * could not be asked: a channel that has limits from before keeps them
   * then.
   */
  "channel.connect": mutator(
    channelRowSchema.omit({
      status: true,
      connectedAt: true,
      limitsCheckedAt: true,
    }),
    (tx, channel) => {
      const existing = tx
        .find("channel", "accountId", channel.accountId)
        .find(({ network }) => network === channel.network);
      if (!existing && tx.get("channel", channel.id)) {
        throw new MutationRejected(
          "already_exists",
          "This channel exists already",
        );
      }
      // A new connection is what the inbox asked for, if it said anything
      // of the channel.
      if (existing && tx.get("notification", existing.id)?.channelId) {
        tx.delete("notification", existing.id);
      }
      tx.put("channel", {
        ...channel,
        id: existing?.id ?? channel.id,
        status: "connected",
        connectedAt: tx.now,
        limits: channel.limits ?? existing?.limits ?? null,
        limitsCheckedAt: channel.limits
          ? tx.now
          : (existing?.limitsCheckedAt ?? null),
      });
    },
    { serverOnly: true },
  ),

  /**
   * Stores what the account of a channel may post, as its network has just
   * said. The server runs this when it has asked the network again.
   */
  "channel.setLimits": mutator(
    z.strictObject({ id: idSchema, limits: limitsSchema }),
    (tx, { id, limits }) => {
      const channel = tx.get("channel", id);
      if (!channel) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      tx.put("channel", { ...channel, limits, limitsCheckedAt: tx.now });
    },
    { serverOnly: true },
  ),

  /**
   * Stores when the access of a channel ends now that the server has
   * renewed its credentials, where the network has that. It keeps the new
   * credentials with the channel in the same step.
   */
  "channel.renew": mutator(
    channelRowSchema.pick({ id: true, expiresAt: true }),
    (tx, { id, expiresAt }) => {
      const channel = tx.get("channel", id);
      if (!channel) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      tx.put("channel", { ...channel, expiresAt });
      // A reminder that the access ends is about the end that it had.
      if (tx.get("notification", id)?.kind === "channel_expiring") {
        tx.delete("notification", id);
      }
    },
    { serverOnly: true },
  ),

  /**
   * Marks a channel as one that has to be connected again, because its
   * network would not renew the access when the server asked for that by
   * its timer. Only for the connection that was refused, which
   * `connectedAt` names: the word of the network can arrive after the
   * person has connected the account again, and must not count against
   * that. Does nothing then, and nothing if the channel is gone.
   */
  "channel.lapse": mutator(
    z.strictObject({ id: idSchema, connectedAt: z.number().int() }),
    (tx, { id, connectedAt }) => {
      const channel = tx.get("channel", id);
      if (channel?.connectedAt === connectedAt) {
        tx.put("channel", { ...channel, status: "needs_reconnect" });
        notifyOfChannel(tx, channel.id, "channel_needs_reconnect");
      }
    },
    { serverOnly: true },
  ),

  /**
   * Removes a channel, and with it the access that the server keeps for
   * it. Does nothing if the channel is gone.
   *
   * The posts that were to go to the channel no longer do. A draft loses
   * the target, with the text that was written for it, and so does a post
   * that is scheduled, which is a draft again if that was its only
   * account. A target that waits or is on its way fails, with what it has
   * published so far. What has ended stays as it is, for the record:
   * its `channelId` then names a channel that is gone.
   */
  "channel.disconnect": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      // Whether a post left the queue: it closes up once, at the end,
      // however many posts were to go to this channel alone.
      let left = false;
      for (const target of tx.find("post_target", "channelId", id)) {
        if (target.status === "pending") {
          dropOwnText(tx, target);
          tx.delete("post_target", target.id);
          // A scheduled post goes to the accounts that are left. One that
          // has none left would have nowhere to go when its time comes:
          // it is a draft again, for somebody to choose.
          // Not one that was put aside: it stays so, and is a draft if
          // it is restored.
          const post = tx.get("post", target.postId);
          if (
            post?.status === "scheduled" &&
            post.trashedAt === null &&
            tx.find("post_target", "postId", post.id).length === 0
          ) {
            left ||= inQueue(post);
            toDraft(tx, post, false);
          }
        } else if (target.status === "queued" || target.status === "sending") {
          tx.put("post_target", {
            ...target,
            status: "error",
            error: disconnectedMessage,
            disconnected: true,
          });
          settle(tx, target.postId);
        }
      }
      if (tx.get("notification", id)?.channelId === id) {
        tx.delete("notification", id);
      }
      if (left) requeue(tx);
      tx.delete("channel", id);
    },
    { serverOnly: true },
  ),

  /**
   * Takes up a scheduled post whose time has come: the server runs this
   * when it finds one, which is at that time or as soon after it as the
   * server can. `takeUp` has what becomes of the post: it is sent, held,
   * or given another slot.
   */
  "post.due": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      const post = tx.get("post", id);
      if (
        post?.status !== "scheduled" ||
        post.dueAt === null ||
        post.dueAt > tx.now ||
        post.heldAt !== null ||
        post.trashedAt !== null
      ) {
        throw new MutationRejected("not_current", "This post is not due");
      }
      takeUp(tx, { ...post, dueAt: post.dueAt });
    },
    { serverOnly: true },
  ),

  /**
   * Begins a delivery that has waited its turn, or begins one anew that is
   * tried again: the target is `sending` in a new attempt. The server runs
   * this when no other delivery to the channel is under way, which is also
   * checked here: an adapter cannot tell two deliveries to one account
   * apart that go out together.
   */
  "target.start": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      const target = tx.get("post_target", id);
      const busy =
        target &&
        tx
          .find("post_target", "channelId", target.channelId)
          .some((other) => other.status === "sending");
      if (target?.status !== "queued" || busy) {
        throw new MutationRejected(
          "not_current",
          "This delivery cannot begin now",
        );
      }
      tx.put("post_target", {
        ...target,
        status: "sending",
        attempt: target.attempt + 1,
      });
    },
    { serverOnly: true },
  ),

  /**
   * Records the parts that a delivery has published so far, in the order
   * of the text that the target gets, the post's or its own: where each stands on the network. A part that is recorded
   * already keeps its row, and the `id` that is passed for it is not used.
   */
  "target.progress": mutator(
    z.strictObject({
      id: idSchema,
      attempt: z.number().int().positive(),
      parts: z.array(
        targetPartResultRowSchema.pick({ id: true, remoteId: true, url: true }),
      ),
    }),
    (tx, { id, attempt, parts }) => {
      const target = currentTarget(tx, id, attempt);
      // The parts that the target gets: its own, if it has any.
      const postParts = partsFor(
        tx.find("post_part", "postId", target.postId),
        id,
      );
      const recorded = new Set(
        tx
          .find("target_part_result", "targetId", id)
          .map((result) => result.partId),
      );
      parts.forEach((published, index) => {
        const part = postParts[index];
        if (!part) {
          throw new MutationRejected(
            "invalid_arguments",
            "The post has fewer parts than were published",
          );
        }
        if (recorded.has(part.id)) return;
        if (tx.get("target_part_result", published.id)) {
          throw new MutationRejected(
            "already_exists",
            "This result exists already",
          );
        }
        tx.put("target_part_result", {
          ...published,
          targetId: id,
          partId: part.id,
        });
      });
    },
    { serverOnly: true },
  ),

  /**
   * Ends a delivery: every part is published, or it has failed, with the
   * reason for the person. The post leaves `sending` when the last of its
   * targets has ended.
   *
   * `refusedConnection` says whether the network has refused the access
   * of the channel, and which access: the `connectedAt` of the channel
   * that the refused credentials were read with, or null if none were
   * refused. The channel then needs connecting again, unless it has been
   * connected again since. The end of a delivery can be recorded long
   * after its network refused, and must not mark a connection that the
   * delivery has never tried.
   */
  "target.end": mutator(
    z.discriminatedUnion("status", [
      z.strictObject({
        id: idSchema,
        attempt: z.number().int().positive(),
        status: z.literal(targetStatusSchema.enum.sent),
      }),
      z.strictObject({
        id: idSchema,
        attempt: z.number().int().positive(),
        status: targetStatusSchema.extract(["error", "uncertain"]),
        error: z.string().min(1).max(targetLimits.errorLength),
        refusedConnection: channelRowSchema.shape.connectedAt.nullable(),
      }),
    ]),
    (tx, end) => {
      const target = currentTarget(tx, end.id, end.attempt);
      tx.put("post_target", {
        ...target,
        status: end.status,
        error: end.status === "sent" ? null : end.error,
        sentAt: end.status === "sent" ? tx.now : null,
      });
      if (end.status !== "sent" && end.refusedConnection !== null) {
        const channel = tx.get("channel", target.channelId);
        // The time of a connection names it: no two mutations of a
        // workspace are run at the same time.
        if (channel?.connectedAt === end.refusedConnection) {
          tx.put("channel", { ...channel, status: "needs_reconnect" });
          notifyOfChannel(tx, channel.id, "channel_needs_reconnect");
        }
      }
      // Which is also where the inbox says how the post ended, once,
      // when the last of its deliveries has: not for each of them.
      settle(tx, target.postId);
    },
    { serverOnly: true },
  ),

  /**
   * Tells the person that the access of a channel ends within
   * `expiryNoticeMs`, on a network where it ends by a date and is not
   * renewed. The server runs this once for each access, when that time
   * has come. It says nothing of a channel that needs connecting again
   * already, which the inbox has said, nor of one whose access does not
   * end within that time, or has ended.
   */
  "channel.warnOfExpiry": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      const channel = tx.get("channel", id);
      if (!channel) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      if (
        channel.status !== "connected" ||
        channel.expiresAt === null ||
        channel.expiresAt <= tx.now ||
        channel.expiresAt - tx.now > expiryNoticeMs
      ) {
        return;
      }
      notifyOfChannel(tx, id, "channel_expiring");
    },
    { serverOnly: true },
  ),

  /**
   * Marks notifications as read, on every device. One that is gone or
   * read already is left as it is: two devices can read the same one.
   *
   * Each is named with its `createdAt`, as the device saw it: what was
   * told of can happen again, which puts a new, unread notification under
   * the same ID. A device that was away meanwhile has read the one before
   * and not this one, which is left as it is.
   */
  "notification.read": mutator(
    z.strictObject({
      notifications: z.array(seenNotificationSchema).min(1).max(100),
    }),
    (tx, { notifications }) => {
      for (const seen of notifications) {
        const notification = seenNotification(tx, seen);
        if (notification && notification.readAt === null) {
          tx.put("notification", { ...notification, readAt: tx.now });
        }
      }
    },
  ),

  /**
   * Takes a notification out of the inbox. What it was about stays as it
   * is. Does nothing if the notification is gone, or if another has come
   * in its place since the device saw it: see `notification.read`.
   */
  "notification.dismiss": mutator(seenNotificationSchema, (tx, seen) => {
    if (seenNotification(tx, seen)) tx.delete("notification", seen.id);
  }),

  /**
   * Removes notifications that the person has not dismissed: the server
   * runs this for the ones that are older than it keeps them.
   */
  "notification.prune": mutator(
    z.strictObject({ ids: z.array(idSchema).min(1).max(100) }),
    (tx, { ids }) => {
      for (const id of ids) tx.delete("notification", id);
    },
    { serverOnly: true },
  ),
};

export type MutatorName = keyof typeof mutators;

/** The arguments of the mutator `Name`. */
export type MutatorArgs<Name extends MutatorName> = z.input<
  (typeof mutators)[Name]["schema"]
>;

/**
 * Runs the mutation `name` with `args` in `tx`, for `source`. Throws
 * `MutationRejected` if there is no such mutator, if it is one that
 * `source` may not ask for, if the arguments are not what it takes, or if
 * it refuses. Then, and when anything else is thrown, the caller has to
 * discard what the mutation wrote to `tx`.
 */
export function applyMutation(
  tx: Transaction,
  name: string,
  args: unknown,
  source: MutationSource,
): void {
  if (!Object.hasOwn(mutators, name)) {
    throw new MutationRejected(
      "unknown_mutation",
      `There is no mutation named ${JSON.stringify(name)}`,
    );
  }
  const mutator = mutators[name as MutatorName];
  if (mutator.serverOnly && source === "client") {
    throw new MutationRejected(
      "not_allowed",
      `Only the server runs ${JSON.stringify(name)}`,
    );
  }
  mutator.apply(tx, args);
}
