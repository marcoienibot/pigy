import { inReadingOrder, type Row, type Tables, uuidv7 } from "@pigy/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
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
  /** No part has anything in it. */
  empty: boolean;
  /** The first line that has something in it. Empty for an empty draft. */
  title: string;
  /** What follows the title, on one line. */
  snippet: string;
  /** When it was last edited, in milliseconds since the Unix epoch. */
  updatedAt: number;
};

const snippetLength = 160;

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
 */
const made = new WeakMap<Row<"post">, Draft>();

function draftOf(post: Row<"post">, parts: readonly Part[]): Draft {
  const before = made.get(post);
  if (
    before &&
    before.parts.length === parts.length &&
    before.parts.every((part, index) => part === parts[index])
  ) {
    return before;
  }
  const lines = parts
    .flatMap((part) => part.text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const draft = {
    id: post.id,
    parts,
    empty: parts.every((part) => part.text === ""),
    title: lines[0] ?? "",
    snippet: lines.slice(1).join(" ").slice(0, snippetLength),
    updatedAt: post.updatedAt,
  };
  made.set(post, draft);
  return draft;
}

/** The drafts of a workspace, the one that was edited last first. */
export function selectDrafts(tables: Tables): Draft[] {
  // The text of a draft is its own: the parts that are written for one
  // account in its place are the editor's to show, with that account.
  const texts = new Map<string, Part[]>();
  for (const part of tables.post_part.values()) {
    if (part.targetId !== null) continue;
    const text = texts.get(part.postId);
    if (text) text.push(part);
    else texts.set(part.postId, [part]);
  }

  const drafts: Draft[] = [];
  for (const post of tables.post.values()) {
    const text = texts.get(post.id);
    if (post.status !== "draft" || !text) continue;
    drafts.push(draftOf(post, inReadingOrder(text)));
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

/** Whether the editor should focus `id`. It is asked once per draft. */
export function takeFocusOnOpen(id: string): boolean {
  if (focusOnOpen !== id) return false;
  focusOnOpen = undefined;
  return true;
}

/**
 * Returns the function behind "New draft": it opens a draft to write in,
 * with `text` if that is given. An empty draft that is there already is
 * used rather than making another.
 */
export function useNewDraft() {
  const mutate = useMutate();
  const read = useSyncedNow();
  const navigate = useNavigate();

  return useCallback(
    (text = "") => {
      let id =
        text === ""
          ? selectDrafts(read()).find((draft) => draft.empty)?.id
          : undefined;
      if (!id) {
        id = uuidv7(new Date());
        mutate("post.create", { id, partId: uuidv7(new Date()), text });
      }
      focusOnOpen = id;
      void navigate({ to: "/", search: { draft: id } });
    },
    [mutate, read, navigate],
  );
}
