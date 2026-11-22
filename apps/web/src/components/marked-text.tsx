import type { ReactNode } from "react";
import { type Mark, segmentsOf } from "@/lib/markup";
import { cn } from "@/lib/utils";

/**
 * A text with its links, mentions and hashtags told from its words, for
 * reading: a post on the Sent screen, a post in a simulated feed. They
 * are coloured and nothing else. A link is no link here: where it leads
 * is somebody's to write, and these screens show what a network has, not
 * a way to it.
 */
const shown: Record<Mark["kind"], string> = {
  link: "text-sky-700 underline decoration-sky-700/40 underline-offset-2 dark:text-sky-400 dark:decoration-sky-400/40",
  mention: "text-violet-700 dark:text-violet-400",
  hashtag: "text-teal-700 dark:text-teal-400",
};

export function MarkedText({
  text,
  marks,
}: {
  text: string;
  marks: readonly Mark[];
}): ReactNode {
  return segmentsOf(text, marks).map(({ text: part, mark }, index) =>
    mark ? (
      // The marks of a text are in its order and are never reordered.
      // biome-ignore lint/suspicious/noArrayIndexKey: a segment has nothing else of its own
      <span key={index} data-mark={mark.kind} className={shown[mark.kind]}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * How the editor shows a mark under the letters that are typed: as a
 * tint behind them. The letters themselves are those of the field.
 */
const behind: Record<Mark["kind"], string> = {
  link: "bg-sky-500/15 shadow-[inset_0_-1px_0_0] shadow-sky-600/60 dark:bg-sky-400/20 dark:shadow-sky-400/60",
  mention: "bg-violet-500/15 dark:bg-violet-400/25",
  hashtag: "bg-teal-500/15 dark:bg-teal-400/25",
};

/**
 * The marks of a text as a layer to put behind the field that the text
 * is typed into: the same text, in the same letters, which are not
 * drawn, with a tint behind what is a link, a mention or a hashtag. The
 * field stays a plain field, so typing, selecting, undoing, input
 * methods and screen readers are the browser's own, and the layer is
 * hidden from the latter: what it says is said in words under the field.
 *
 * It lines up with the field only if both are set in the same letters
 * with the same room around them: whoever uses it gives both the same
 * classes for that.
 */
export function MarkLayer({
  text,
  marks,
  className,
}: {
  text: string;
  marks: readonly Mark[];
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-marks=""
      className={cn(
        // As a field wraps what is typed into it.
        "pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-transparent select-none",
        className,
      )}
    >
      {segmentsOf(text, marks).map(({ text: part, mark }, index) =>
        mark ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a segment has nothing else of its own
            key={index}
            data-mark={mark.kind}
            data-everywhere={mark.everywhere}
            className={cn(
              "rounded-[2px]",
              behind[mark.kind],
              // Not for every account that gets the text.
              !mark.everywhere &&
                "bg-transparent outline-1 -outline-offset-1 outline-muted-foreground/70 outline-dashed dark:bg-transparent",
            )}
          >
            {part}
          </span>
        ) : (
          part
        ),
      )}
      {/* A line break at the very end makes no line by itself. */}
      {text.endsWith("\n") && " "}
    </div>
  );
}
