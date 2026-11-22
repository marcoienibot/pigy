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
  "target.retry": "A post was not sent again",
  // Only the server runs the ones below, so no copy holds one that the app
  // made. They are named all the same: the list is of every mutator.
  "channel.connect": "An account was not connected",
  "channel.setLimits": "The limits of an account were not updated",
  "channel.renew": "The access to an account was not renewed",
  "channel.disconnect": "An account was not disconnected",
  "target.start": "A post was not sent",
  "target.progress": "A published post was not recorded",
  "target.end": "The outcome of a post was not recorded",
};

/** What to call a refused change that was made by the mutator `name`. */
export function refusedChange(name: string): string {
  // A copy can hold a mutation of a mutator that this version of the app
  // does not know.
  return Object.hasOwn(refused, name)
    ? refused[name as MutatorName]
    : "A change was not saved";
}

const textOf = (value: unknown): string => {
  const text = (value as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
};

/**
 * The text that a refused change carried and that is nowhere else by
 * now, part after part: empty if it carried none that has more in it
 * than space. That is an edit of a part, a part that came with its text,
 * as one that an Undo brings back does, and a text for an account, whose
 * parts are text too. The arguments are read as what they are, the word
 * of a copy that another version of the app may have written.
 */
export function lostTexts({
  name,
  args,
}: Pick<StoredRejection, "name" | "args">): string[] {
  let texts: string[] = [];
  if (name === "part.setText" || name === "part.add") {
    texts = [textOf(args)];
  } else if (name === "target.customize") {
    const parts = (args as { parts?: unknown } | null)?.parts;
    texts = Array.isArray(parts) ? parts.map(textOf) : [];
  }
  return texts.some((text) => text.trim() !== "") ? texts : [];
}
