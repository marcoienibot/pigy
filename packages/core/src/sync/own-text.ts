import type { MutatorArgs } from "./mutators.ts";
import { maxOwnTextLength } from "./tables.ts";

/**
 * How a client gives an account a text of its own that is there already:
 * one that it brings back, after the draft was deleted or the account left
 * out. A text that an account has had can be longer than the one mutation
 * `target.customize` carries, because it grows part by part once it is
 * begun. So it comes back in steps that each fit one message of the
 * protocol.
 */

/** One of the mutations that bring a text for an account back. */
export type OwnTextMutation =
  | { name: "target.customize"; args: MutatorArgs<"target.customize"> }
  | { name: "part.add"; args: MutatorArgs<"part.add"> };

/**
 * The mutations that give the account `channelId` of the draft `postId`
 * the text `texts`, part after part, whatever its length: a
 * `target.customize` with as many of the first parts as it carries, which
 * is one at least, and a `part.add` for each part after those, behind the
 * part before it. None for no parts. `newId` makes the ID of a part.
 *
 * Each of them is as long as its mutator takes, and so fits one message:
 * a client must not make a mutation that does not, because it would stay
 * at the front of its outbox and keep everything behind it from the
 * server.
 *
 * The steps are not one: if another device gives the account a text in
 * the same moment and its `target.customize` comes first, the parts that
 * are added here go to the end of that text. A client uses this for a
 * target that it has just made itself, which no other device has seen.
 */
export function ownTextMutations(
  postId: string,
  channelId: string,
  texts: readonly string[],
  newId: () => string,
): OwnTextMutation[] {
  const parts = texts.map((text) => ({ id: newId(), text }));
  let first = 0;
  let length = 0;
  for (const { text } of parts) {
    if (first > 0 && length + text.length > maxOwnTextLength) break;
    length += text.length;
    first += 1;
  }
  if (first === 0) return [];
  const mutations: OwnTextMutation[] = [
    {
      name: "target.customize",
      args: { postId, channelId, parts: parts.slice(0, first) },
    },
  ];
  parts.slice(first).forEach(({ id, text }, index) => {
    mutations.push({
      name: "part.add",
      args: {
        id,
        postId,
        channelId,
        afterId: parts[first + index - 1]?.id ?? null,
        text,
      },
    });
  });
  return mutations;
}
