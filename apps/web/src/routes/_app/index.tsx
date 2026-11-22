import {
  maxOwnTextLength,
  maxParts,
  maxPartTextLength,
  uuidv7,
} from "@pigy/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2, X } from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { EmptyState, Page } from "@/components/page";
import { PublishPanel } from "@/components/publish-panel";
import { SyncIndicator } from "@/components/sync-indicator";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type Channel, selectChannels, selectNoChannels } from "@/lib/channels";
import {
  type Draft,
  focusWhenOpened,
  type Part,
  restoreOwnText,
  selectDrafts,
  takeFocusOnOpen,
  threadLabel,
  useNewDraft,
} from "@/lib/drafts";
import {
  isBusy,
  modKey,
  takeFocus,
  useKeyDown,
  useShortcuts,
  withMod,
} from "@/lib/keyboard";
import { connectableNetworks } from "@/lib/networks";
import { undoMs } from "@/lib/notices";
import {
  compose,
  type Gauge,
  gaugesOf,
  type Meter,
  ownTextsOf,
  partMetersOf,
  readersOf,
  selectDraftTargets,
  selectOwnTexts,
  targetsOf,
  wholeMetersOf,
} from "@/lib/publish";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  useHasSynced,
  useMutate,
  useSynced,
  useSyncedNow,
  useSyncState,
} from "@/sync/react";

type DraftsSearch = {
  /** The ID of the draft that is open. */
  draft?: string;
};

export const Route = createFileRoute("/_app/")({
  validateSearch: (search): DraftsSearch =>
    typeof search.draft === "string" ? { draft: search.draft } : {},
  component: Drafts,
});

/**
 * What went with a draft that was deleted: the channels that it was to go
 * to, each with the text that was written for it, if one was.
 */
type Went = { channelId: string; own: readonly Part[] | null }[];

/**
 * Whether `parts` can become the text of one account in one step, which
 * is how "Customize" begins one: `target.customize` carries no more.
 */
function fitsOwnText(parts: readonly { text: string }[]): boolean {
  return (
    parts.reduce((length, { text }) => length + text.length, 0) <=
    maxOwnTextLength
  );
}

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
   * what went with it and the notice that offers it. The one that was
   * deleted last is at the end. They are those of this workspace: the
   * screen is made anew for the other one, and so are the notices.
   */
  const deleted = useRef<
    { draft: Draft; went: Went; notice: string | number }[]
  >([]);
  const tablesNow = useSyncedNow();

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

  const restore = (
    draft: Draft,
    went: Went,
    notice: string | number,
    /** Asked for with the button of the notice, and not with the keys. */
    fromNotice = false,
  ) => {
    forget(notice);
    toast.dismiss(notice);
    // A post that is deleted is gone for every device, so what comes back
    // is a new draft with the same text, part after part in their order,
    // which is to go where the deleted one was.
    const id = uuidv7(new Date());
    const [first, ...more] = draft.parts;
    let last = uuidv7(new Date());
    mutate("post.create", { id, partId: last, text: first?.text ?? "" });
    for (const { text } of more) {
      const partId = uuidv7(new Date());
      mutate("part.add", {
        id: partId,
        postId: id,
        channelId: null,
        afterId: last,
        text,
      });
      last = partId;
    }
    const connected = tablesNow().channel;
    for (const { channelId, own } of went) {
      // An account that was disconnected since is left out: the server
      // would refuse the choice, and take it back with a notice.
      if (!connected.has(channelId)) continue;
      mutate("target.add", { id: uuidv7(new Date()), postId: id, channelId });
      // With the text that was written for it, if it had one: all of
      // it, also where it has grown longer than one step carries.
      if (own) restoreOwnText(mutate, id, channelId, own);
    }
    // The notice that was pressed leaves the page, and the keyboard with
    // it: it goes into the text of the draft, and not to the page, where
    // the next ⌫ would delete the draft again. The keys leave the
    // keyboard where it is.
    if (fromNotice) focusWhenOpened(id);
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
    // Where the draft was to go, and what was written for single accounts,
    // which go with it: read before they do.
    const tables = tablesNow();
    const own = ownTextsOf(selectOwnTexts(tables), draft.id);
    const went: Went = [...targetsOf(selectDraftTargets(tables), draft.id)].map(
      (channelId) => ({ channelId, own: own.get(channelId) ?? null }),
    );
    mutate("post.delete", { id: draft.id });
    // Nothing to bring back of a draft without text.
    if (draft.empty) return;
    const notice: string | number = toast("Draft deleted", {
      duration: undoMs,
      // Its own draft, also when others were deleted after it and their
      // notices are on screen next to this one.
      action: {
        label: "Undo",
        onClick: () => restore(draft, went, notice, true),
      },
      onDismiss: () => forget(notice),
      onAutoClose: () => forget(notice),
    });
    // The notice outlives this screen. It does not outlive the workspace,
    // where there would be nothing to bring the draft back into: the shell
    // sees to that.
    deleted.current.push({ draft, went, notice });
  };

  /**
   * `draft` has been published, and is no longer a draft: the editor
   * closes, as for a draft that is deleted, and the list comes back. The
   * notice of the panel leads to the post on the Sent screen.
   */
  const published = (draft: Draft) => {
    const index = drafts.indexOf(draft);
    const neighbour = drafts[index + 1] ?? drafts[index - 1];
    // Where to go from here is decided here, not by the effect above.
    seen.current = undefined;
    show(undefined);
    // The keyboard stays in the list, next to where the draft was.
    if (isWide() && neighbour) rowOf(neighbour.id)?.focus();
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
        // At the end of the text of the first part, to go on writing.
        const field = editor.current;
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
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
      restore(last.draft, last.went, last.notice);
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
          <FirstSteps onWrite={() => newDraft()} />
        ) : (
          <DraftList drafts={drafts} />
        )}
      </div>

      <section
        aria-label="Draft"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col bg-background",
          // On a phone the editor takes the whole app, navigation
          // included, and the list is a step back. Only the banner of the
          // sandbox stays above it: the shell is what this is placed in,
          // and it keeps the sides and the top out of the edges that a
          // phone keeps for itself. The bottom is the tab bar's, which
          // this covers.
          openId
            ? "absolute inset-0 z-40 flex pb-safe md:static md:z-auto md:pb-0"
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
            onPublished={() => published(open)}
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

/**
 * What the list says while it is empty, which is what somebody new sees
 * first: where they are, and what to do next. Until an account is
 * connected, that is to connect one.
 */
function FirstSteps({ onWrite }: { onWrite: () => void }) {
  const { workspace } = Route.useRouteContext();
  const noChannels = useSynced(selectNoChannels);
  const sandbox = workspace.environment === "sandbox";
  // The first network that can be connected: its form opens at once.
  const [network] = connectableNetworks;
  // An empty copy does not say that there are no drafts, or no channels,
  // on a device that has yet to hear from the server. While it is
  // connecting, the answer is a moment away. While it cannot reach the
  // server, it keeps trying, and the drafts come when it gets through. A
  // window that another one has taken the socket from, or that is too old
  // for the server, does not try again: it has to be loaded again, as its
  // sync indicator says.
  const hasSynced = useHasSynced();
  const { connection, outdated } = useSyncState();
  const stopped = outdated || connection === "replaced";
  const unreached = connection !== "online" && connection !== "connecting";

  if (!hasSynced && (stopped || unreached)) {
    return (
      <EmptyState
        title="Not synced to this device yet"
        description={
          stopped
            ? "This window has stopped syncing, so your drafts are not on this device yet. The sync indicator says how to go on. What you write meanwhile is kept on this device."
            : "Your drafts will appear when pigy is back online. What you write until then is kept on this device."
        }
      >
        <Button variant="outline" onClick={onWrite}>
          Write a draft
        </Button>
      </EmptyState>
    );
  }

  return (
    <EmptyState
      title="No drafts yet"
      description={
        !noChannels
          ? "Posts you are still writing will appear here."
          : sandbox
            ? "This is your sandbox: a place to try pigy on simulated networks, where nothing is posted for real. Connect one of its made-up accounts, then write a post."
            : "Posts you are still writing will appear here. To publish them, connect an account."
      }
    >
      <div className="flex flex-col items-center gap-2">
        {noChannels && network && (
          <Link
            to="/channels"
            search={{ add: network }}
            className={buttonVariants()}
          >
            Connect {sandbox ? "a simulated" : "an"} account
          </Link>
        )}
        <Button variant="outline" onClick={onWrite}>
          Write a draft
        </Button>
      </div>
    </EmptyState>
  );
}

function DraftList({ drafts }: { drafts: Draft[] }) {
  const now = useNow();

  return (
    <ul aria-label="Drafts">
      {drafts.map((draft) => (
        <DraftRow
          key={draft.id}
          draft={draft}
          ago={timeAgo(draft.updatedAt, now)}
        />
      ))}
    </ul>
  );
}

/**
 * A row of the list. It renders again when its draft has changed, which
 * `selectDrafts` says with another object, or when the time that it shows
 * has: typing in one draft renders one row, however long the list is.
 */
const DraftRow = memo(function DraftRow({
  draft,
  ago,
}: {
  draft: Draft;
  /** How long ago the draft was edited, as the row words it. */
  ago: string;
}) {
  const thread = threadLabel(draft);
  return (
    <li>
      <Link
        to="/"
        search={{ draft: draft.id }}
        data-draft={draft.id}
        // The router marks the link of the open draft as the current
        // page: its address is the one in the address bar. That row is
        // filled. The focus of the keyboard is a ring, which Tab moves to
        // other rows: Enter and Backspace go by the ring, so the two must
        // not look the same.
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
            {ago}
          </span>
        </span>
        <span className="flex h-5 items-baseline gap-2 text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{draft.snippet}</span>
          {thread && <span className="shrink-0 text-xs">· {thread}</span>}
        </span>
      </Link>
    </li>
  );
});

const segmenter = new Intl.Segmenter();

/** How many characters a person would count in `text`. */
function countCharacters(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/**
 * Whether the browser sizes a field by what is in it. Where it does not,
 * the field of a part is sized by hand: `PartField`.
 */
const sizesFields =
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/**
 * What the field of a part asks of the editor. The object is the same for
 * as long as the editor is, so that a field renders again only when its
 * part has changed: `PartField` is kept by `memo`.
 */
type PartActions = {
  /** The field of the part `id` is on the page, or with null gone. */
  register(id: string, field: HTMLTextAreaElement | null): void;
  setText(part: Part, text: string): void;
  /** Adds an empty part after `part` and takes the keyboard to it. */
  addAfter(part: Part): void;
  /** Removes `part`, and takes the keyboard to a part next to it. */
  remove(part: Part): void;
  /** Moves `part` one place up or down in its text. */
  move(part: Part, step: 1 | -1): void;
  /**
   * Takes the keyboard to the part before or after `part`. Returns false
   * if there is none.
   */
  go(part: Part, step: 1 | -1): boolean;
  /** The person wants out of the text. */
  leave(): void;
};

/**
 * The editor that is on the page, for what outlives the editor that made
 * it: the Undo of a notice, which can be pressed when another text is
 * shown, another draft is open, or none.
 */
let openEditor:
  | {
      draftId: string;
      /** Shows the text of `channelId`, the post's for null, and takes the keyboard to its part `partId`. */
      reveal(channelId: string | null, partId: string): void;
    }
  | undefined;

/**
 * A part for the editor of its draft to show and give the keyboard once
 * that editor is on the page: the draft was not open when it was asked.
 */
let revealOnOpen:
  | { draftId: string; channelId: string | null; partId: string }
  | undefined;

/**
 * The editor of a draft: its text, part after part, each saved as it is
 * typed, with how long it is for the accounts that get it, and under it
 * where the draft goes. Every change is a mutation, and the fields show
 * what the local copy holds.
 *
 * A draft has a text of its own, and an account can be given another in
 * its place. The editor shows one of them at a time: the post's, or the
 * one of the account that `shown` names.
 */
function Editor({
  draft,
  ref,
  onLeave,
  onDelete,
  onPublished,
}: {
  draft: Draft;
  /** The field of the first part of the text that is shown. */
  ref: RefObject<HTMLTextAreaElement | null>;
  /** The person wants out of the field. */
  onLeave: () => void;
  onDelete: () => void;
  onPublished: () => void;
}) {
  const mutate = useMutate();
  const navigate = Route.useNavigate();
  const tablesNow = useSyncedNow();
  const channels = useSynced(selectChannels);
  const chosen = targetsOf(useSynced(selectDraftTargets), draft.id);
  const own = ownTextsOf(useSynced(selectOwnTexts), draft.id);
  const composer = compose(draft.parts, channels, chosen, own);

  // The account whose own text is shown. One that has none, or no longer,
  // because the text was dropped or the account left out, here or on
  // another device, shows the post's text.
  const [asked, setShown] = useState<string | null>(null);
  const written = asked === null ? undefined : own.get(asked);
  const shown = written ? asked : null;
  const parts = written ?? draft.parts;
  const reader = composer.choices.find(({ channel }) => channel.id === shown);

  // What the text that is shown has to keep to: the limits of the accounts
  // that get it. Made anew only when those change, and not with every key:
  // they are handed to every field.
  const readers = JSON.stringify(
    readersOf(composer.choices, shown).map(({ handle, limits }) => ({
      handle,
      limits,
    })),
  );
  const gauges = useMemo(
    () => gaugesOf(JSON.parse(readers) as Pick<Channel, "handle" | "limits">[]),
    [readers],
  );

  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  /** The part that is to get the keyboard once its field is on the page. */
  const awaited = useRef<{ id: string; at: "start" | "end" }>(null);

  const focus = (id: string, at: "start" | "end") => {
    const field = fields.current.get(id);
    if (!field) {
      awaited.current = { id, at };
      return;
    }
    awaited.current = null;
    takeFocus(field);
    const caret = at === "start" ? 0 : field.value.length;
    field.setSelectionRange(caret, caret);
  };

  useLayoutEffect(() => {
    const [first] = parts;
    ref.current = (first && fields.current.get(first.id)) ?? null;
    if (awaited.current) focus(awaited.current.id, awaited.current.at);
  });

  /**
   * Shows the text that the part `partId` is of, which is the one of
   * `channelId`, or the post's for null, and takes the keyboard to the
   * end of that part, once its field is on the page.
   */
  const reveal = (channelId: string | null, partId: string) => {
    setShown(channelId);
    focus(partId, "end");
  };

  // What outlives this editor finds the one that is on the page here.
  useLayoutEffect(() => {
    const handle = { draftId: draft.id, reveal };
    openEditor = handle;
    // A part that was brought back into this draft while it was not open.
    if (revealOnOpen?.draftId === draft.id) {
      const { channelId, partId } = revealOnOpen;
      revealOnOpen = undefined;
      reveal(channelId, partId);
    }
    return () => {
      if (openEditor === handle) openEditor = undefined;
    };
  });

  // The person has asked for this draft to write in it.
  useEffect(() => {
    if (!takeFocusOnOpen(draft.id)) return;
    // At the end of the text, to go on writing, where the draft has any.
    const field = ref.current;
    takeFocus(field);
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [draft.id, ref]);

  /** Shows the post's text, or the one of the account `channelId`. */
  const show = (channelId: string | null) => {
    setShown(channelId);
    const [first] = (channelId && own.get(channelId)) || draft.parts;
    if (first) awaited.current = { id: first.id, at: "end" };
  };

  /** The parts of the text that `part` is of, as they are now. */
  const textOf = (part: Part) => {
    const tables = tablesNow();
    if (tables.post.get(draft.id)?.status !== "draft") return undefined;
    if (part.targetId === null) {
      return selectDrafts(tables).find(({ id }) => id === draft.id)?.parts;
    }
    const channelId = tables.post_target.get(part.targetId)?.channelId;
    return channelId
      ? ownTextsOf(selectOwnTexts(tables), draft.id).get(channelId)
      : undefined;
  };

  const actions: PartActions = {
    register: () => {},
    setText: (part, text) => mutate("part.setText", { id: part.id, text }),
    addAfter: (part) => {
      if (parts.length >= maxParts) return;
      const id = uuidv7(new Date());
      mutate("part.add", {
        id,
        postId: draft.id,
        channelId: shown,
        afterId: part.id,
        text: "",
      });
      focus(id, "start");
    },
    remove: (part) => {
      const index = parts.indexOf(part);
      const before = parts[index - 1];
      const neighbour = before ?? parts[index + 1];
      if (index < 0 || !neighbour) return;
      mutate("part.remove", { id: part.id });
      focus(neighbour.id, before ? "end" : "start");
      // Nothing to bring back of a part without text.
      if (part.text === "") return;
      const channelId = shown;
      toast("Part removed", {
        duration: undoMs,
        action: {
          label: "Undo",
          onClick: () => {
            // Into the text that it was removed from, if that is still
            // there to be edited: after the part that it followed, or at
            // the end if that one is gone too.
            const text = textOf(part);
            if (!text || text.length >= maxParts) return;
            const id = uuidv7(new Date());
            mutate("part.add", {
              id,
              postId: draft.id,
              channelId,
              afterId: before?.id ?? null,
              text: part.text,
            });
            // The notice leaves the page with the press: the keyboard
            // goes to the part that is back, and not to the page, where
            // its keys open and delete drafts. The notice can be
            // pressed when the editor shows another text of the draft,
            // or when this editor is gone, because another draft was
            // opened or none: the part is shown first, by the editor
            // that is on the page, or by the one that opens its draft.
            if (openEditor?.draftId === draft.id) {
              openEditor.reveal(channelId, id);
            } else {
              revealOnOpen = { draftId: draft.id, channelId, partId: id };
              void navigate({
                to: "/",
                search: { draft: draft.id },
                replace: true,
              });
            }
          },
        },
      });
    },
    move: (part, step) => {
      const index = parts.indexOf(part);
      const to = index + step;
      if (index < 0 || to < 0 || to >= parts.length) return;
      mutate("part.move", {
        id: part.id,
        // Down: after the part that follows. Up: after the part before
        // the one before, or to the beginning.
        afterId:
          step === 1 ? (parts[to]?.id ?? null) : (parts[to - 1]?.id ?? null),
      });
      // The button that was pressed moves with its part. At the end of
      // the text it has nothing left to do and is disabled, which would
      // lose the keyboard: it goes to the text of the part.
      if (to === 0 || to === parts.length - 1) focus(part.id, "end");
    },
    go: (part, step) => {
      const next = parts[parts.indexOf(part) + step];
      if (!next) return false;
      focus(next.id, step === 1 ? "start" : "end");
      return true;
    },
    leave: onLeave,
  };
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const [stable] = useState(
    (): PartActions => ({
      // Not through `latest`: a field is on the page before the effect
      // above has run for the first time.
      register: (id, field) => {
        if (field) fields.current.set(id, field);
        else fields.current.delete(id);
      },
      setText: (...args) => latest.current.setText(...args),
      addAfter: (...args) => latest.current.addAfter(...args),
      remove: (...args) => latest.current.remove(...args),
      move: (...args) => latest.current.move(...args),
      go: (...args) => latest.current.go(...args),
      leave: () => latest.current.leave(),
    }),
  );

  const customize = (channel: Channel) => {
    if (!fitsOwnText(draft.parts)) return;
    const parts = draft.parts.map(({ text }) => ({
      id: uuidv7(new Date()),
      text,
    }));
    mutate("target.customize", {
      postId: draft.id,
      channelId: channel.id,
      parts,
    });
    // The text is there with the next render, and shown then. The button
    // that was pressed is gone by then, and the keyboard would be left on
    // the page, where its keys open and delete drafts: it goes into the
    // first part of the new text.
    setShown(channel.id);
    const [first] = parts;
    if (first) awaited.current = { id: first.id, at: "end" };
  };

  const followPost = (channel: Channel) => {
    mutate("target.followPost", { postId: draft.id, channelId: channel.id });
    show(null);
  };

  const customized = composer.choices.filter((choice) => choice.own);
  const customizable = composer.choices.filter(
    (choice) => choice.chosen && !choice.own,
  );
  const alone = parts.length === 1;
  const wholeMeters = wholeMetersOf(gauges, parts);

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
        {!alone && (
          <span className="pl-2 text-xs text-muted-foreground md:pl-1">
            Thread of {parts.length} parts
          </span>
        )}
        <span className="ml-auto" />
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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Above the text and scrolled with it: a phone has little room. */}
        {(customized.length > 0 || customizable.length > 0) && (
          <div className="flex shrink-0 flex-col gap-1.5 border-b px-4 py-2 text-xs md:px-6">
            <div className="flex flex-wrap items-center gap-1.5">
              {customized.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: a fieldset would put a second frame around the buttons.
                <div
                  role="group"
                  aria-label="Text to edit"
                  className="flex max-w-full flex-wrap items-center gap-1.5"
                >
                  <TextChoice
                    pressed={shown === null}
                    onClick={() => show(null)}
                  >
                    Post text
                  </TextChoice>
                  {customized.map(({ channel }) => (
                    <TextChoice
                      key={channel.id}
                      pressed={shown === channel.id}
                      onClick={() => show(channel.id)}
                    >
                      <span className="sr-only">Text for </span>
                      {channel.handle}
                    </TextChoice>
                  ))}
                </div>
              )}
              {customizable.map(({ channel }) => (
                <button
                  key={channel.id}
                  type="button"
                  disabled={!fitsOwnText(draft.parts)}
                  title={
                    fitsOwnText(draft.parts)
                      ? `Write another text for ${channel.handle}, beginning with this one`
                      : "This text is too long to begin another from"
                  }
                  className="inline-flex h-7 max-w-full items-center rounded-full border border-dashed px-2.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => customize(channel)}
                >
                  <span className="truncate">
                    Customize for {channel.handle}
                  </span>
                </button>
              ))}
            </div>
            {reader && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <span>
                  Only {reader.channel.handle} gets this text. The post's own
                  text goes to the other accounts.
                </span>
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => followPost(reader.channel)}
                >
                  Use the post's text
                </button>
              </p>
            )}
          </div>
        )}

        <ol
          aria-label={
            reader ? `Text for ${reader.channel.handle}` : "Text of the post"
          }
          className="flex flex-1 flex-col"
        >
          {parts.map((part, index) => (
            <PartField
              key={part.id}
              part={part}
              index={index}
              count={parts.length}
              handle={reader?.channel.handle ?? null}
              gauges={gauges}
              actions={stable}
            />
          ))}
        </ol>
        {wholeMeters.length > 0 && (
          // Under the last part: a network that makes one post of the
          // parts counts them together, and has no counter under a part.
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would put a frame around a line of text.
          <div
            role="group"
            aria-label="Length of the parts as one post"
            className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground md:px-6"
          >
            {wholeMeters.map((meter) => (
              <Counter key={meter.key} meter={meter} />
            ))}
            <span>
              for the parts together: they go out as one post there, with an
              empty line between them.
            </span>
          </div>
        )}
        {!alone && (
          <p className="hidden shrink-0 flex-wrap items-center gap-1 px-6 pb-3 text-xs text-muted-foreground md:flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            at the edge of a part move to the part next to it.
            <Kbd>⌫</Kbd>
            in an empty part removes it.
          </p>
        )}
      </div>
      <PublishPanel
        draft={draft}
        composer={composer}
        onPublished={onPublished}
      />
    </>
  );
}

/** A button that chooses which text of a draft the editor shows. */
function TextChoice({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-full items-center rounded-full border px-2.5 outline-none",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        pressed
          ? "border-primary bg-primary/10 font-medium text-foreground"
          : "text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

/**
 * One part of a text: the field that it is typed into, how long it is,
 * and what can be done with it. It renders again when its part has
 * changed, or its place in the text, and not when another part is typed
 * into.
 */
const PartField = memo(function PartField({
  part,
  index,
  count,
  handle,
  gauges,
  actions,
}: {
  part: Part;
  /** Its place in the text, counted from 0. */
  index: number;
  /** How many parts the text has. */
  count: number;
  /** The account that the text is written for, or null for the post's. */
  handle: string | null;
  /** The limits of the accounts that get the text. */
  gauges: readonly Gauge[];
  actions: PartActions;
}) {
  const { text } = part;
  const field = useRef<HTMLTextAreaElement>(null);
  const alone = count === 1;
  const number = index + 1;
  const label = alone
    ? handle
      ? `Text for ${handle}`
      : "Draft text"
    : handle
      ? `Part ${number} for ${handle}`
      : `Part ${number}`;

  useLayoutEffect(() => {
    actions.register(part.id, field.current);
    return () => actions.register(part.id, null);
  }, [actions, part.id]);

  // When the text changes from elsewhere, another device or another tab,
  // the browser puts the cursor at the end of the field. It is put back
  // where the person had it. What they type is never lost to such a
  // change: an edit that the server has not confirmed stays on top of
  // whatever arrives.
  const typed = useRef(text);
  const selection = useRef<[number, number]>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    // Where the browser does not size a field by its text, as high as
    // the text is.
    if (!sizesFields) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
    if (text === typed.current) return;
    typed.current = text;
    if (document.activeElement === element && selection.current) {
      const [start, end] = selection.current;
      element.setSelectionRange(
        Math.min(start, text.length),
        Math.min(end, text.length),
      );
    }
  }, [text]);

  const meters = partMetersOf(gauges, text, count);
  const characters = countCharacters(text);

  return (
    <li
      className={cn(
        "flex flex-col",
        // The one part of a post takes the room that there is, to click
        // into. The parts of a thread are as high as their text.
        alone ? "flex-1" : "border-b",
      )}
    >
      <textarea
        ref={field}
        data-part={part.id}
        aria-label={label}
        placeholder={index === 0 ? "Write something…" : "Go on…"}
        value={text}
        maxLength={maxPartTextLength}
        rows={alone ? undefined : 2}
        // 16px on a phone, below which iOS zooms into a field.
        className={cn(
          "field-sizing-content w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground md:px-6 md:pt-5 md:text-[0.9375rem]",
          alone ? "min-h-24 flex-1" : "min-h-16",
        )}
        onChange={(event) => {
          typed.current = event.target.value;
          actions.setText(part, event.target.value);
        }}
        onSelect={(event) => {
          const { selectionStart, selectionEnd } = event.currentTarget;
          selection.current = [selectionStart, selectionEnd];
        }}
        onKeyDown={(event) => {
          // A key that composes a character is the input method's: ↓ and
          // ↑ go through its candidates, ⌫ and Escape take back what it
          // holds, Enter takes a candidate. None of them is for the
          // thread. Safari says 229 for the key that ends a composition,
          // after it has said that the composition is over.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const { selectionStart, selectionEnd, value } = event.currentTarget;
          const plain =
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey;
          if (event.key === "Escape") {
            // The one key that is not for the text.
            event.preventDefault();
            actions.leave();
          } else if (
            event.key === "Enter" &&
            withMod(event.nativeEvent) &&
            event.shiftKey &&
            !event.repeat
          ) {
            event.preventDefault();
            actions.addAfter(part);
          } else if (
            event.key === "ArrowUp" &&
            plain &&
            selectionStart === 0 &&
            selectionEnd === 0
          ) {
            // At the very beginning of a part, up is the part before.
            if (actions.go(part, -1)) event.preventDefault();
          } else if (
            event.key === "ArrowDown" &&
            plain &&
            selectionStart === value.length &&
            selectionEnd === value.length
          ) {
            if (actions.go(part, 1)) event.preventDefault();
          } else if (
            event.key === "Backspace" &&
            plain &&
            value === "" &&
            !alone &&
            !event.repeat
          ) {
            // Nothing left to delete in it: the part itself goes.
            event.preventDefault();
            actions.remove(part);
          }
        }}
      />
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-xs text-muted-foreground md:px-6">
        {!alone && (
          <span className="tabular-nums">
            {number}/{count}
          </span>
        )}
        {meters.length === 0 ? (
          <span className="tabular-nums">
            {characters === 1 ? "1 character" : `${characters} characters`}
          </span>
        ) : (
          meters.map((meter) => <Counter key={meter.key} meter={meter} />)
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {!alone && (
            <>
              <Hint label="Move up" keys={[]}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move part ${number} up`}
                  disabled={index === 0}
                  onClick={() => actions.move(part, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
              </Hint>
              <Hint label="Move down" keys={[]}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move part ${number} down`}
                  disabled={index === count - 1}
                  onClick={() => actions.move(part, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </Hint>
              <Hint label="Remove part" keys={[]}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove part ${number}`}
                  onClick={() => actions.remove(part)}
                >
                  <X aria-hidden="true" />
                </Button>
              </Hint>
            </>
          )}
          <Hint label="Add a part below" keys={[modKey, "⇧", "↵"]}>
            <Button
              variant="ghost"
              size={alone ? "sm" : "icon-sm"}
              aria-label={
                alone ? "Add a part" : `Add a part after part ${number}`
              }
              disabled={count >= maxParts}
              onClick={() => actions.addAfter(part)}
            >
              <Plus aria-hidden="true" />
              {alone && "Add part"}
            </Button>
          </Hint>
        </span>
      </div>
    </li>
  );
});

/**
 * How long a part is for the accounts of one network, against what they
 * take: plain while it fits, a warning near the limit and an error over
 * it.
 */
function Counter({ meter }: { meter: Meter }) {
  const { label, count, max, tone, description } = meter;
  return (
    <span
      title={description}
      data-tone={tone}
      className={cn(
        "tabular-nums",
        tone === "near" && "text-amber-700 dark:text-amber-400",
        tone === "over" && "font-medium text-destructive",
      )}
    >
      <span aria-hidden="true">
        {label} {count}/{max}
      </span>
      <span className="sr-only">
        {description}
        {tone === "over"
          ? ", over the limit"
          : tone === "near"
            ? ", near the limit"
            : ""}
      </span>
    </span>
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
        <Shortcut keys={[modKey, "⇧", "↵"]}>
          Add a part below, for a thread
        </Shortcut>
        <Shortcut keys={["↑", "↓"]}>
          At the edge of a part: to the part next to it
        </Shortcut>
        <Shortcut keys={["Esc"]}>Leave the text, then close the draft</Shortcut>
        <Shortcut keys={["⌫"]}>Delete the open draft</Shortcut>
        <Shortcut keys={[modKey, "↵"]}>Publish the open draft</Shortcut>
        <Shortcut keys={[modKey, "Z"]}>Bring a deleted draft back</Shortcut>
        <Shortcut keys={[modKey, "K"]}>All commands</Shortcut>
      </dl>
    </div>
  );
}
