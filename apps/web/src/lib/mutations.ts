import type { MutatorName, StoredRejection } from "@pigy/core";

/**
 * What a change is called when the person is told that it was refused, by
 * the mutator that made it. Every mutator has an entry: the compiler asks
 * for one when a mutator is added.
 */
const refused: Record<MutatorName, string> = {
  "post.create": "A new draft was not saved",
  "part.setText": "An edit was not saved",
  "part.add": "A part was not added to a draft",
  "part.remove": "A part was not removed from a draft",
  "part.move": "A part was not moved",
  "post.delete": "A post was not deleted",
  "target.add": "An account was not added to a draft",
  "target.remove": "An account was not taken off a draft",
  "target.customize": "An account was not given a text of its own",
  "target.followPost": "An account was not given the text of the post again",
  "post.publish": "A post was not published",
  "post.schedule": "A post was not scheduled",
  "post.enqueue": "A post was not added to the queue",
  "post.move": "A post was not moved in the queue",
  "post.unschedule": "A post was not taken back to the drafts",
  "post.trash": "A scheduled post was not deleted",
  "post.restore": "A deleted post was not brought back",
  "slot.add": "A posting time was not added",
  "slot.remove": "A posting time was not removed",
  "queue.setPaused": "The queue was not paused or resumed",
  "settings.setTimeZone": "The time zone was not changed",
  "target.retry": "A post was not sent again",
  "notification.read": "A notification was not marked as read",
  "notification.dismiss": "A notification was not dismissed",
  "media.create": "An image was not added",
  "media.attach": "An image was not added to a draft",
  "media.setAlt": "The description of an image was not saved",
  "media.detach": "An image was not removed from a draft",
  "media.move": "An image was not moved",
  // Only the server runs the ones below, so no copy holds one that the app
  // made. They are named all the same: the list is of every mutator.
  "channel.connect": "An account was not connected",
  "channel.setLimits": "The limits of an account were not updated",
  "channel.renew": "The access to an account was not renewed",
  "channel.lapse": "An account was not marked as needing a new connection",
  "channel.disconnect": "An account was not disconnected",
  "post.due": "A scheduled post was not taken up",
  "target.start": "A post was not sent",
  "target.progress": "A published post was not recorded",
  "target.end": "The outcome of a post was not recorded",
  "metric.record": "The stats of a post were not recorded",
  "target.halt": "A post that waited its turn was not stopped",
  "channel.warnOfExpiry": "A reminder was not added",
  "notification.prune": "Old notifications were not removed",
  "media.ready": "An uploaded image was not recorded",
  "media.fail": "A failed upload was not recorded",
  "media.expire": "An old image was not let go of",
  "media.delete": "An unused image was not removed",
};

/** What to call a refused change that was made by the mutator `name`. */
export function refusedChange(name: string): string {
  // A copy can hold a mutation of a mutator that this version of the app
  // does not know.
  return Object.hasOwn(refused, name)
    ? refused[name as MutatorName]
    : "A change was not saved";
}

const textOf = (value: unknown, field = "text"): string => {
  const text = (value as Record<string, unknown> | null)?.[field];
  return typeof text === "string" ? text : "";
};

/**
 * The text that a refused change carried and that is nowhere else by
 * now, part after part: empty if it carried none that has more in it
 * than space. That is an edit of a part, a part that came with its text,
 * as one that an Undo brings back does, a text for an account, whose
 * parts are text too, and the description of an image. The arguments are
 * read as what they are, the word of a copy that another version of the
 * app may have written.
 */
export function lostTexts({
  name,
  args,
}: Pick<StoredRejection, "name" | "args">): string[] {
  let texts: string[] = [];
  if (name === "part.setText" || name === "part.add") {
    texts = [textOf(args)];
  } else if (name === "media.setAlt") {
    texts = [textOf(args, "alt")];
  } else if (name === "target.customize") {
    const parts = (args as { parts?: unknown } | null)?.parts;
    texts = Array.isArray(parts) ? parts.map((part) => textOf(part)) : [];
  }
  return texts.some((text) => text.trim() !== "") ? texts : [];
}
