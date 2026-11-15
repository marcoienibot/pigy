import type { MutatorName } from "@pigy/core";

/**
 * What a change is called when the person is told that it was refused, by
 * the mutator that made it. Every mutator has an entry: the compiler asks
 * for one when a mutator is added.
 */
const refused: Record<MutatorName, string> = {
  "post.create": "A new draft was not saved",
  "part.setText": "An edit was not saved",
  "post.delete": "A post was not deleted",
  "target.add": "An account was not added to a draft",
  "target.remove": "An account was not taken off a draft",
  "post.publish": "A post was not published",
  "target.retry": "A post was not sent again",
  // Only the server runs the ones below, so no copy holds one that the app
  // made. They are named all the same: the list is of every mutator.
  "channel.connect": "An account was not connected",
  "channel.setLimits": "The limits of an account were not updated",
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
