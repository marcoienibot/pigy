import {
  inReadingOrder,
  type MutatorArgs,
  type MutatorName,
  ownTextMutations,
  type Row,
  type Tables,
  uuidv7,
} from "@pigy/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { attachAgain, type PartImages } from "@/lib/media";
import { useMutate, useSyncedNow } from "@/sync/react";

/** One part of a text, as the editor shows it: its row. */
export type Part = Row<"post_part">;

/** A draft as the drafts screen shows it. */
export type Draft = {
  /** The ID of the post. */
  id: string;
  /**
   * The parts of the post's own text, in the order they are read in. There
   * is at least one. More than one is a thread.
   */
  parts: readonly Part[];
  /**
   * Nothing is written in it: no part has anything in it, of the post's
   * own text or of a text that is written for one account.
   */
  empty: boolean;
  /**
   * Nobody has done anything with it: it is empty, and goes nowhere. Such
   * a draft is what "New draft" takes up again in place of making another.
   */
  untouched: boolean;
  /**
   * The first line that has something in it: of the post's own text, or
   * of a text for one account where the post's own has nothing. Empty for
   * an empty draft.
   */
  title: string;
  /** What follows the title, on one line. */
  snippet: string;
  /** When it was last edited, in milliseconds since the Unix epoch. */
  updatedAt: number;
};

const snippetLength = 160;

/** What a draft is made of, besides its post. */
type Made = {
  draft: Draft;
  /** The parts that are written for single accounts, in a fixed order. */
  forAccounts: readonly Part[];
  /** How many accounts the draft goes to. */
  targets: number;
  /** How many images its parts have. */
  images: number;
};

/**
 * The drafts that were made before, by the row of their post. A row is
 * never changed, a change puts another object in its place. So a draft
 * whose rows are the objects they were is the draft it was, and it is
 * handed out as the same object: typing in one draft makes that draft new
 * and leaves the others alone, for the list to see which rows to render
 * again. It also saves going through the text of every draft with every
 * keystroke. The parts of a draft are their rows, so a part that has not
 * changed is the same object too, for the editor of a thread to see which
 * of its fields to render again.
 *
 * The row of the post does not say all of it: an account that is
 * disconnected takes its target and its text with it and leaves the post
 * as it was. So the parts for accounts and the number of targets are
 * compared too.
 */
const made = new WeakMap<Row<"post">, Made>();

const same = (a: readonly Part[], b: readonly Part[]) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

/** The lines of `parts` that have something in them. */
const linesOf = (parts: readonly Part[]) =>
  parts
    .flatMap((part) => part.text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "");

function draftOf(
  post: Row<"post">,
  parts: readonly Part[],
  forAccounts: readonly Part[],
  targets: number,
  /** How many images its parts have, those of every text together. */
  images: number,
): Draft {
  const before = made.get(post);
  if (
    before &&
    before.targets === targets &&
    before.images === images &&
    same(before.draft.parts, parts) &&
    same(before.forAccounts, forAccounts)
  ) {
    return before.draft;
  }
  let lines = linesOf(parts);
  if (lines.length === 0) {
    // A draft whose every account has a text of its own can leave the
    // post's empty. It is called by the first of those texts that has
    // something in it, and not "Empty draft".
    // They are sorted by account, so the parts of one follow each other.
    const first = forAccounts.find((part) => part.text.trim() !== "");
    lines = linesOf(
      forAccounts.filter((part) => part.targetId === first?.targetId),
    );
  }
  // A draft with an image is not empty, and is called by what it has.
  const empty = lines.length === 0 && images === 0;
  if (lines.length === 0 && images > 0) {
    lines = [images === 1 ? "An image" : `${images} images`];
  }
  const draft = {
    id: post.id,
    parts,
    empty,
    untouched: empty && targets === 0,
    title: lines[0] ?? "",
    snippet: lines.slice(1).join(" ").slice(0, snippetLength),
    updatedAt: post.updatedAt,
  };
  made.set(post, { draft, forAccounts, targets, images });
  return draft;
}

/** The drafts of a workspace, the one that was edited last first. */
export function selectDrafts(tables: Tables): Draft[] {
  // The text of a draft is its own: the parts that are written for one
  // account in its place are the editor's to show, with that account.
  // The list goes by them only for what it calls a draft.
  const texts = new Map<string, Part[]>();
  const forAccounts = new Map<string, Part[]>();
  for (const part of tables.post_part.values()) {
    const of = part.targetId === null ? texts : forAccounts;
    const text = of.get(part.postId);
    if (text) text.push(part);
    else of.set(part.postId, [part]);
  }
  const targets = new Map<string, number>();
  for (const { postId } of tables.post_target.values()) {
    targets.set(postId, (targets.get(postId) ?? 0) + 1);
  }

  // The images of each post: of the parts of all its texts.
  const images = new Map<string, number>();
  for (const { partId } of tables.part_media.values()) {
    const postId = tables.post_part.get(partId)?.postId;
    if (postId) images.set(postId, (images.get(postId) ?? 0) + 1);
  }

  const drafts: Draft[] = [];
  for (const post of tables.post.values()) {
    const text = texts.get(post.id);
    if (post.status !== "draft" || !text) continue;
    drafts.push(
      draftOf(
        post,
        inReadingOrder(text),
        // By account, and each text in the order it is read in.
        (forAccounts.get(post.id) ?? []).sort(
          (a, b) =>
            (a.targetId ?? "").localeCompare(b.targetId ?? "") ||
            a.position - b.position ||
            (a.id < b.id ? -1 : 1),
        ),
        targets.get(post.id) ?? 0,
        images.get(post.id) ?? 0,
      ),
    );
  }
  // By ID among drafts of the same moment, so that the order is the same
  // every time.
  return drafts.sort(
    (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1),
  );
}

/** What the list says of the length of a thread, or null for one part. */
export function threadLabel({ parts }: Pick<Draft, "parts">): string | null {
  return parts.length > 1 ? `${parts.length} parts` : null;
}

/**
 * The ID of a draft that the editor is to take the focus for when it
 * opens it: one that the person has just asked for, to write in.
 */
let focusOnOpen: string | undefined;

/**
 * Has the editor take the focus for the draft `id` when it opens it: for
 * a draft that the person has asked for from something that leaves the
 * page with the press, a notice for example. The keyboard would otherwise
 * be left on the page, where the keys are shortcuts of the screen.
 */
export function focusWhenOpened(id: string): void {
  focusOnOpen = id;
}

/** Whether the editor should focus `id`. It is asked once per draft. */
export function takeFocusOnOpen(id: string): boolean {
  if (focusOnOpen !== id) return false;
  focusOnOpen = undefined;
  return true;
}

/**
 * Returns the function behind "New draft": it opens a draft to write in,
 * with `text` if that is given, or with a thread of the parts `text` for
 * several. A draft that is there already and that nobody has done
 * anything with is used rather than making another: one without text,
 * without a text for an account, and that goes nowhere.
 */
export function useNewDraft() {
  const mutate = useMutate();
  const read = useSyncedNow();
  const navigate = useNavigate();

  return useCallback(
    (text: string | readonly string[] = "") => {
      const [first = "", ...more] = typeof text === "string" ? [text] : text;
      let id =
        first === "" && more.length === 0
          ? selectDrafts(read()).find((draft) => draft.untouched)?.id
          : undefined;
      if (!id) {
        id = uuidv7(new Date());
        let last = uuidv7(new Date());
        mutate("post.create", { id, partId: last, text: first });
        for (const part of more) {
          const partId = uuidv7(new Date());
          mutate("part.add", {
            id: partId,
            postId: id,
            channelId: null,
            afterId: last,
            text: part,
          });
          last = partId;
        }
      }
      focusOnOpen = id;
      void navigate({ to: "/", search: { draft: id } });
    },
    [mutate, read, navigate],
  );
}

/**
 * Gives the account `channelId` of the draft `postId` the text `parts`
 * as its own, all of it, however long it is, with the images that each
 * part had, by its ID in `images`: for a text that is brought back, with
 * a draft that was deleted or an account that was left out.
 * `ownTextMutations` of `@pigy/core` has how, and why it is more than
 * one mutation for a long text. Returns the IDs of the parts of the text.
 */
export function restoreOwnText(
  mutate: <Name extends MutatorName>(
    name: Name,
    args: MutatorArgs<Name>,
  ) => void,
  postId: string,
  channelId: string,
  parts: readonly { id: string; text: string }[],
  images: PartImages = new Map(),
): string[] {
  const mutations = ownTextMutations(
    postId,
    channelId,
    parts.map(({ text }) => text),
    () => uuidv7(new Date()),
  );
  for (const mutation of mutations) {
    // Each under its own name: the compiler checks the arguments of a
    // mutation against its name, which it cannot for one of two.
    if (mutation.name === "target.customize") {
      mutate(mutation.name, mutation.args);
    } else {
      mutate(mutation.name, mutation.args);
    }
  }
  // The IDs of the parts that were made, in the order of `parts`, which
  // get their images back.
  const made = mutations.flatMap((mutation) =>
    mutation.name === "target.customize"
      ? mutation.args.parts.map(({ id }) => id)
      : [mutation.args.id],
  );
  parts.forEach((part, index) => {
    const partId = made[index];
    if (partId) attachAgain(mutate, partId, images.get(part.id) ?? []);
  });
  return made;
}
