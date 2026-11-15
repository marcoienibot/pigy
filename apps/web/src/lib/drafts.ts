import { type Row, type Tables, uuidv7 } from "@pigy/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useMutate, useSyncedNow } from "@/sync/react";

/** A draft as the drafts screen shows it. */
export type Draft = {
  /** The ID of the post. */
  id: string;
  /** The ID of its first part, which holds the text. */
  partId: string;
  text: string;
  /** The first line that has something in it. Empty for an empty draft. */
  title: string;
  /** What follows the title, on one line. */
  snippet: string;
  /** When it was last edited, in milliseconds since the Unix epoch. */
  updatedAt: number;
};

const snippetLength = 160;

/** The drafts of a workspace, the one that was edited last first. */
export function selectDrafts(tables: Tables): Draft[] {
  // A draft has one part until threads arrive in phase 4. Its text is that
  // of the first part: the lowest position, then the lowest ID.
  const firstParts = new Map<string, Row<"post_part">>();
  for (const part of tables.post_part.values()) {
    const first = firstParts.get(part.postId);
    if (
      !first ||
      part.position < first.position ||
      (part.position === first.position && part.id < first.id)
    ) {
      firstParts.set(part.postId, part);
    }
  }

  const drafts: Draft[] = [];
  for (const post of tables.post.values()) {
    const part = firstParts.get(post.id);
    if (post.status !== "draft" || !part) continue;
    const lines = part.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    drafts.push({
      id: post.id,
      partId: part.id,
      text: part.text,
      title: lines[0] ?? "",
      snippet: lines.slice(1).join(" ").slice(0, snippetLength),
      updatedAt: post.updatedAt,
    });
  }
  // By ID among drafts of the same moment, so that the order is the same
  // every time.
  return drafts.sort(
    (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1),
  );
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
          ? selectDrafts(read()).find((draft) => draft.text === "")?.id
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
