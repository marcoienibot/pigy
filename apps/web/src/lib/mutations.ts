import type { MutatorName } from "@pigy/core";

/**
 * What a change is called when the person is told that it was refused, by
 * the mutator that made it. Every mutator has an entry: the compiler asks
 * for one when a mutator is added.
 */
const refused: Record<MutatorName, string> = {
  "post.create": "A new draft was not saved",
  "part.setText": "An edit was not saved",
  "post.delete": "A draft was not deleted",
  // Only the server runs these two, so no copy holds one that the app
  // made. They are named all the same: the list is of every mutator.
  "channel.connect": "An account was not connected",
  "channel.disconnect": "An account was not disconnected",
};

/** What to call a refused change that was made by the mutator `name`. */
export function refusedChange(name: string): string {
  // A copy can hold a mutation of a mutator that this version of the app
  // does not know.
  return Object.hasOwn(refused, name)
    ? refused[name as MutatorName]
    : "A change was not saved";
}
