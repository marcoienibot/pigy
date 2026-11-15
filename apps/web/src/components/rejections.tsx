import type { StoredRejection } from "@pigy/core";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useNewDraft } from "@/lib/drafts";
import { refusedChange } from "@/lib/mutations";
import { useRejections } from "@/sync/react";

/**
 * The text that a refused edit would have set, if it was one with text
 * that has more in it than space.
 */
function lostText({ name, args }: StoredRejection): string {
  if (name !== "part.setText") return "";
  const text = (args as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.trim() !== "" ? text : "";
}

/**
 * Tells the person of every change that the server refused: what it was
 * and why. By then the screen shows the data without the change. A notice
 * stays until it is dismissed, here or in another tab, and comes back
 * after a reload if it was not. The notices are those of the workspace on
 * screen: when the tab goes on to the other one, they leave the screen
 * with it and are there again when it comes back.
 *
 * An edit that was refused has text in it that exists nowhere else by now,
 * for example because the draft was deleted on another device while it was
 * being written. The notice offers to keep that text as a new draft.
 */
export function Rejections() {
  const { rejections, dismiss } = useRejections();
  const newDraft = useNewDraft();
  const shown = useRef(new Set<string>());
  // The notices that this takes off the screen itself, by key. The notice
  // library says "dismissed" for those as it does for the ones that the
  // person closes, and only the person's word may delete a rejection.
  const taken = useRef(new Set<string>());

  useEffect(() => {
    for (const rejection of rejections) {
      const text = lostText(rejection);
      // Trimmed for the notice only: the draft gets the text as it was
      // written, with its indentation and its last empty lines.
      const quote = text.trim();
      // With an ID, a notice that is on screen already is left as it is.
      toast.error(refusedChange(rejection.name), {
        id: rejection.key,
        description: text
          ? `${rejection.message}. You wrote: “${quote.length > 80 ? `${quote.slice(0, 80)}…` : quote}”`
          : `${rejection.message}.`,
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        onDismiss: () => {
          if (!taken.current.delete(rejection.key)) dismiss(rejection.key);
        },
        ...(text && {
          action: {
            label: "Keep as new draft",
            onClick: () => {
              newDraft(text);
              dismiss(rejection.key);
            },
          },
        }),
      });
    }
    // Those that were dismissed in another tab, and those of the workspace
    // that was on screen before this one: its rejections are still to be
    // seen.
    const keys = new Set(rejections.map(({ key }) => key));
    for (const key of shown.current) {
      if (keys.has(key)) continue;
      taken.current.add(key);
      toast.dismiss(key);
    }
    shown.current = keys;
  }, [rejections, dismiss, newDraft]);

  return null;
}
