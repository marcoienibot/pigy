import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useNewDraft } from "@/lib/drafts";
import { lostTexts, refusedChange } from "@/lib/mutations";
import { useRejections } from "@/sync/react";

/**
 * Tells the person of every change that the server refused: what it was
 * and why. By then the screen shows the data without the change. A notice
 * stays until it is dismissed, here or in another tab, and comes back
 * after a reload if it was not. The notices are those of the workspace on
 * screen: the shell makes this anew for every workspace, together with
 * where the notices are shown. So when the tab goes on to the other one,
 * they leave the screen with it, without being dismissed, and are there
 * again when it comes back.
 *
 * A change that was refused can have text in it that exists nowhere else
 * by now: an edit, for example because the draft was deleted on another
 * device while it was being written, and a part or a text for an account
 * that an Undo was bringing back. The notice offers to keep that text as
 * a new draft, part by part.
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
      const texts = lostTexts(rejection);
      const text = texts.length > 0;
      // The first of it that says something, trimmed, for the notice
      // only: the draft gets the text as it was written, with its
      // indentation and its last empty lines.
      const quote = texts.find((part) => part.trim() !== "")?.trim() ?? "";
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
              newDraft(texts);
              dismiss(rejection.key);
            },
          },
        }),
      });
    }
    // Those that were dismissed in another tab.
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
