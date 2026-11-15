import { maxPartTextLength, uuidv7 } from "@pigy/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { toast } from "sonner";
import { EmptyState, Page } from "@/components/page";
import { SyncIndicator } from "@/components/sync-indicator";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type Draft,
  selectDrafts,
  takeFocusOnOpen,
  useNewDraft,
} from "@/lib/drafts";
import {
  isBusy,
  modKey,
  useKeyDown,
  useShortcuts,
  withMod,
} from "@/lib/keyboard";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useMutate, useSynced } from "@/sync/react";

type DraftsSearch = {
  /** The ID of the draft that is open. */
  draft?: string;
};

export const Route = createFileRoute("/_app/")({
  validateSearch: (search): DraftsSearch =>
    typeof search.draft === "string" ? { draft: search.draft } : {},
  component: Drafts,
});

/** Whether the list and the editor are side by side: `md` in Tailwind. */
function isWide(): boolean {
  return window.matchMedia("(min-width: 48rem)").matches;
}

/**
 * The drafts: a list, and the editor of the one that is open. Side by side
 * on a wide screen. On a phone the list, then the editor in its place.
 *
 * Everything here reads the local copy and changes it through mutators, so
 * nothing waits for the network.
 */
function Drafts() {
  const { draft: openId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const drafts = useSynced(selectDrafts);
  const mutate = useMutate();
  const newDraft = useNewDraft();
  const open = drafts.find((draft) => draft.id === openId);
  const list = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  /**
   * The drafts that were deleted and can still be brought back, each with
   * the notice that offers it. The one that was deleted last is at the end.
   */
  const deleted = useRef<{ draft: Draft; notice: string | number }[]>([]);

  const rowOf = (id: string) =>
    list.current?.querySelector<HTMLElement>(`[data-draft="${id}"]`);

  /** Opens the draft `id`, or none, in place of the one that is open. */
  const show = (id: string | undefined) =>
    void navigate({ search: id ? { draft: id } : {}, replace: true });

  // A draft that was open and is gone was deleted, here or on another
  // device: the editor closes. One that was never there is another matter,
  // see below.
  const seen = useRef<string>(undefined);
  useEffect(() => {
    if (open) {
      seen.current = open.id;
    } else if (openId && seen.current === openId) {
      seen.current = undefined;
      void navigate({ search: {}, replace: true });
    }
  }, [open, openId, navigate]);

  /** The draft of `notice` can no longer be brought back. */
  const forget = (notice: string | number) => {
    deleted.current = deleted.current.filter(
      (entry) => entry.notice !== notice,
    );
  };

  const restore = (draft: Draft, notice: string | number) => {
    forget(notice);
    toast.dismiss(notice);
    // A post that is deleted is gone for every device, so what comes back
    // is a new draft with the same text.
    const id = uuidv7(new Date());
    mutate("post.create", { id, partId: uuidv7(new Date()), text: draft.text });
    show(id);
  };

  const remove = (draft: Draft) => {
    const index = drafts.indexOf(draft);
    const neighbour = drafts[index + 1] ?? drafts[index - 1];
    if (draft.id === openId) {
      // Where to go from here is decided here, not by the effect above.
      seen.current = undefined;
      // Next to the list, the editor moves on to the neighbour. On a
      // phone, the list comes back.
      const next = isWide() ? neighbour?.id : undefined;
      show(next);
      if (next) rowOf(next)?.focus();
    } else if (neighbour && rowOf(draft.id) === document.activeElement) {
      // The focus would go with the row, and the next key press would be
      // about the open draft. It stays in the list.
      rowOf(neighbour.id)?.focus();
    }
    mutate("post.delete", { id: draft.id });
    // Nothing to bring back of a draft without text.
    if (draft.text === "") return;
    const notice: string | number = toast("Draft deleted", {
      // Its own draft, also when others were deleted after it and their
      // notices are on screen next to this one.
      action: { label: "Undo", onClick: () => restore(draft, notice) },
      onDismiss: () => forget(notice),
      onAutoClose: () => forget(notice),
    });
    deleted.current.push({ draft, notice });
  };

  /** The draft whose row in the list has the focus, if one has. */
  const focused = (event: KeyboardEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-draft]",
    );
    return drafts.find((draft) => draft.id === row?.dataset.draft);
  };

  /** Opens the draft that is `step` rows from the open one. */
  const move = (step: 1 | -1) => {
    const index = open ? drafts.indexOf(open) : -1;
    const next =
      drafts[
        index < 0 ? 0 : Math.min(drafts.length - 1, Math.max(0, index + step))
      ];
    if (!next) return;
    show(next.id);
    rowOf(next.id)?.focus();
  };

  useShortcuts((event) => {
    switch (event.key.toLowerCase()) {
      case "j":
      case "arrowdown":
        move(1);
        break;
      case "k":
      case "arrowup":
        move(-1);
        break;
      case "enter": {
        // On a link or a button, Enter is theirs. The row of a draft is a
        // link that opens it, and Tab can take the focus to any row. Only
        // on the row of the draft that is open already is there nothing
        // left for the link to do: there Enter goes on into the text.
        const target = event.target as HTMLElement;
        if (!open) return;
        if (target.closest("a, button") && focused(event) !== open) return;
        // At the end of the text, to go on writing.
        editor.current?.focus();
        editor.current?.setSelectionRange(open.text.length, open.text.length);
        break;
      }
      case "escape":
        if (!openId) return;
        show(undefined);
        break;
      case "backspace":
      case "delete": {
        // The draft that the keyboard is on: the row with the focus, which
        // Tab can take away from the open draft, and otherwise that one.
        const draft = focused(event) ?? open;
        if (!draft) return;
        remove(draft);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  });

  useKeyDown((event) => {
    // The draft that was deleted last, and with the next press the one
    // before it.
    const last = deleted.current.at(-1);
    if (
      withMod(event) &&
      event.key.toLowerCase() === "z" &&
      last &&
      !isBusy(event)
    ) {
      event.preventDefault();
      restore(last.draft, last.notice);
    }
  });

  return (
    <Page
      title="Drafts"
      fill
      actions={
        <Button variant="outline" size="sm" onClick={() => newDraft()}>
          <Plus aria-hidden="true" />
          New draft
          <Kbd className="hidden md:inline-flex">C</Kbd>
        </Button>
      }
    >
      <div
        ref={list}
        className={cn(
          "min-h-0 w-full flex-col overflow-y-auto md:flex md:w-80 md:shrink-0 md:border-r",
          openId ? "hidden" : "flex",
        )}
      >
        {drafts.length === 0 ? (
          <EmptyState
            title="No drafts yet"
            description="Posts you are still writing will appear here."
          >
            <Button variant="outline" onClick={() => newDraft()}>
              Write a draft
            </Button>
          </EmptyState>
        ) : (
          <DraftList drafts={drafts} />
        )}
      </div>

      <section
        aria-label="Draft"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col bg-background",
          // On a phone the editor takes the whole screen, navigation
          // included, and the list is a step back.
          openId
            ? "fixed inset-0 z-40 flex pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:pb-0"
            : "hidden md:flex",
        )}
      >
        {open ? (
          <Editor
            // A new editor for every draft: nothing of the one before is
            // carried over.
            key={open.id}
            draft={open}
            ref={editor}
            onLeave={() => {
              if (isWide()) rowOf(open.id)?.focus();
              else show(undefined);
            }}
            onDelete={() => remove(open)}
          />
        ) : openId ? (
          <EmptyState
            title="Draft not found"
            description="It was deleted, or it has not reached this device yet."
          >
            <Link to="/" className="underline underline-offset-4">
              Back to drafts
            </Link>
          </EmptyState>
        ) : (
          <Shortcuts />
        )}
      </section>
    </Page>
  );
}

function DraftList({ drafts }: { drafts: Draft[] }) {
  const now = useNow();

  return (
    <ul aria-label="Drafts">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <Link
            to="/"
            search={{ draft: draft.id }}
            data-draft={draft.id}
            // The router marks the link of the open draft as the current
            // page: its address is the one in the address bar. That row is
            // filled. The focus of the keyboard is a ring, which Tab moves
            // to other rows: Enter and Backspace go by the ring, so the two
            // must not look the same.
            className={cn(
              "block border-b px-4 py-2 outline-none",
              "hover:bg-accent/60",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              "aria-[current=page]:bg-accent",
            )}
          >
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  "truncate font-medium",
                  !draft.title && "text-muted-foreground",
                )}
              >
                {draft.title || "Empty draft"}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {timeAgo(draft.updatedAt, now)}
              </span>
            </span>
            <span className="block h-5 truncate text-muted-foreground">
              {draft.snippet}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const segmenter = new Intl.Segmenter();

/** How many characters a person would count in `text`. */
function countCharacters(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/**
 * The text of a draft, which is saved as it is typed: every change is a
 * mutation, and the field shows what the local copy holds.
 */
function Editor({
  draft,
  ref,
  onLeave,
  onDelete,
}: {
  draft: Draft;
  ref: RefObject<HTMLTextAreaElement | null>;
  /** The person wants out of the field. */
  onLeave: () => void;
  onDelete: () => void;
}) {
  const mutate = useMutate();
  const { text } = draft;
  const count = countCharacters(text);

  // The person has asked for this draft to write in it.
  useEffect(() => {
    if (takeFocusOnOpen(draft.id)) ref.current?.focus();
  }, [draft.id, ref]);

  // When the text changes from elsewhere, another device or another tab,
  // the browser puts the cursor at the end of the field. It is put back
  // where the person had it. What they type is never lost to such a
  // change: an edit that the server has not confirmed stays on top of
  // whatever arrives.
  const typed = useRef(text);
  const selection = useRef<[number, number]>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (text === typed.current || !field) return;
    typed.current = text;
    if (document.activeElement === field && selection.current) {
      const [start, end] = selection.current;
      field.setSelectionRange(
        Math.min(start, text.length),
        Math.min(end, text.length),
      );
    }
  }, [text, ref]);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2 md:h-9 md:px-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to drafts"
          className="md:hidden"
          onClick={onLeave}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {count === 1 ? "1 character" : `${count} characters`}
        </span>
        {/* The header of the screen, which has it, is under the editor. */}
        <div className="md:hidden">
          <SyncIndicator placement="header" />
        </div>
        <Hint label="Delete draft" keys={["⌫"]}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete draft"
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </Hint>
      </header>
      <textarea
        ref={ref}
        aria-label="Draft text"
        placeholder="Write something…"
        value={text}
        maxLength={maxPartTextLength}
        // 16px on a phone, below which iOS zooms into a field.
        className="min-h-0 w-full flex-1 resize-none bg-transparent p-4 text-base leading-relaxed outline-none placeholder:text-muted-foreground md:px-6 md:py-5 md:text-[0.9375rem]"
        onChange={(event) => {
          typed.current = event.target.value;
          mutate("part.setText", {
            id: draft.partId,
            text: event.target.value,
          });
        }}
        onSelect={(event) => {
          const { selectionStart, selectionEnd } = event.currentTarget;
          selection.current = [selectionStart, selectionEnd];
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // The one key that is not for the text.
            event.preventDefault();
            onLeave();
          }
        }}
      />
    </>
  );
}

/** A tooltip that names what a button does and the keys for it. */
function Hint({
  label,
  keys,
  children,
}: {
  label: string;
  keys: string[];
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function Shortcut({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <>
      <dt className="flex justify-end gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </dt>
      <dd className="text-muted-foreground">{children}</dd>
    </>
  );
}

/** What the keyboard does on this screen, where the editor would be. */
function Shortcuts() {
  return (
    <div className="m-auto p-6">
      <h2 className="sr-only">Keyboard shortcuts</h2>
      <dl className="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-2">
        <Shortcut keys={["C"]}>New draft</Shortcut>
        <Shortcut keys={["↑", "↓"]}>Move through the drafts</Shortcut>
        <Shortcut keys={["↵"]}>Write in the open draft</Shortcut>
        <Shortcut keys={["Esc"]}>Leave the text, then close the draft</Shortcut>
        <Shortcut keys={["⌫"]}>Delete the open draft</Shortcut>
        <Shortcut keys={[modKey, "Z"]}>Bring a deleted draft back</Shortcut>
        <Shortcut keys={[modKey, "K"]}>All commands</Shortcut>
      </dl>
    </div>
  );
}
