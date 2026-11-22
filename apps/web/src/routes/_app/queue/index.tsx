import { uuidv7 } from "@pigy/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  CalendarClock,
  ListPlus,
  MoreHorizontal,
  PenLine,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/page";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { focusWhenOpened, useNewDraft } from "@/lib/drafts";
import { useShortcuts } from "@/lib/keyboard";
import { networkInfo } from "@/lib/networks";
import { undoMs } from "@/lib/notices";
import {
  bringBack,
  claimTimeZone,
  movesOf,
  type QueueItem,
  type Schedule,
  selectQueue,
  selectSchedule,
  takePost,
  whenDue,
} from "@/lib/queue";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useMutate, useSynced, useSyncedNow, useSyncState } from "@/sync/react";

export const Route = createFileRoute("/_app/queue/")({
  component: QueueList,
});

/** What a post without words is called. */
const titleOf = ({ title }: Pick<QueueItem, "title">) => title || "Empty post";

/**
 * The scheduled posts, soonest first: those with a time that somebody
 * chose and those of the queue together, each with its text, where it
 * goes and when, and what can be done with it. Everything is a mutation,
 * made on this device at once: nothing here waits for the server.
 */
function QueueList() {
  const items = useSynced(selectQueue);
  const schedule = useSynced(selectSchedule);
  const now = useNow();
  const mutate = useMutate();
  const tablesNow = useSyncedNow();
  const navigate = Route.useNavigate();
  const newDraft = useNewDraft();
  const offline = useSyncState().connection === "offline";
  const list = useRef<HTMLUListElement>(null);
  /** The post that is given another time, while the dialog asks for it. */
  const [rescheduling, setRescheduling] = useState<QueueItem | null>(null);

  const rows = () => [
    ...(list.current?.querySelectorAll<HTMLElement>("[data-post]") ?? []),
  ];
  /** The post whose row has the keyboard, if one has. */
  const focused = (event: KeyboardEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-post]",
    );
    return items.find((item) => item.id === row?.dataset.post);
  };

  const edit = (item: QueueItem) => {
    // Only a draft is edited: the post leaves the queue for the drafts,
    // and is scheduled again from its editor.
    mutate("post.unschedule", { id: item.id });
    focusWhenOpened(item.id);
    void navigate({ to: "/", search: { draft: item.id } });
  };

  const backToDrafts = (item: QueueItem) => {
    mutate("post.unschedule", { id: item.id });
    toast("Back in the drafts", {
      action: {
        label: "Open",
        onClick: () => {
          focusWhenOpened(item.id);
          void navigate({ to: "/", search: { draft: item.id } });
        },
      },
    });
  };

  const sendNow = (item: QueueItem) => {
    mutate("post.publish", { id: item.id });
    toast(
      offline ? "Publishing when this device is back online" : "Publishing now",
      {
        action: {
          label: "View",
          onClick: () =>
            void navigate({ to: "/sent", search: { post: item.id } }),
        },
      },
    );
  };

  const remove = (item: QueueItem) => {
    // What the post is, read before it goes.
    const taken = takePost(tablesNow(), item.id);
    mutate("post.delete", { id: item.id });
    if (!taken) return;
    toast("Scheduled post deleted", {
      duration: undoMs,
      action: {
        label: "Undo",
        onClick: () => {
          const { scheduled } = bringBack(
            mutate,
            tablesNow(),
            taken,
            Date.now(),
            () => uuidv7(new Date()),
          );
          if (!scheduled) {
            toast("Brought back as a draft", {
              description:
                "Its time has passed, or its accounts are no longer connected.",
            });
          }
        },
      },
    });
  };

  useShortcuts((event) => {
    const key = event.key.toLowerCase();
    if (key === "j" || key === "k") {
      const all = rows();
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-post]",
      );
      const index = row ? all.indexOf(row) : -1;
      const step = key === "j" ? 1 : -1;
      const next =
        all[
          index < 0 ? 0 : Math.min(all.length - 1, Math.max(0, index + step))
        ];
      if (!next) return;
      event.preventDefault();
      next.focus();
      return;
    }
    const item = focused(event);
    if (!item) return;
    if (key === "e") {
      event.preventDefault();
      edit(item);
    } else if (key === "s") {
      event.preventDefault();
      setRescheduling(item);
    }
  });

  const noSlots = schedule.slots.length === 0;
  const waiting = items.some((item) => item.mode === "queue");

  if (items.length === 0) {
    return noSlots ? (
      <EmptyState
        title="Nothing scheduled"
        description="Set the times at which the queue posts, then add drafts to it. Or schedule a draft for a time of its own, from its editor."
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Link
            to="/settings/schedule"
            className={buttonVariants({ variant: "default" })}
          >
            Set posting times
          </Link>
          <Button variant="outline" onClick={() => newDraft()}>
            Write a draft
          </Button>
        </div>
      </EmptyState>
    ) : (
      <EmptyState
        title="Nothing scheduled"
        description="Write a draft, choose where it goes, and press “Add to queue” or “Schedule…” under its text."
      >
        <Button onClick={() => newDraft()}>Write a draft</Button>
      </EmptyState>
    );
  }

  return (
    <>
      {noSlots && waiting && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2"
        >
          <p className="min-w-0 flex-1 basis-56">
            <span className="font-medium">The queue has no posting times.</span>{" "}
            Its posts have no time, and go nowhere until it has some.
          </p>
          <Link
            to="/settings/schedule"
            className={buttonVariants({ size: "sm" })}
          >
            Set posting times
          </Link>
        </div>
      )}
      <ul
        ref={list}
        aria-label="Scheduled posts"
        className="flex flex-col gap-3"
      >
        {items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            schedule={schedule}
            now={now}
            moves={movesOf(items, item.id)}
            onEdit={() => edit(item)}
            onReschedule={() => setRescheduling(item)}
            onSendNow={() => sendNow(item)}
            onBackToDrafts={() => backToDrafts(item)}
            onDelete={() => remove(item)}
            onMove={(afterId) => mutate("post.move", { id: item.id, afterId })}
            onEnqueue={() => {
              claimTimeZone(mutate, tablesNow());
              mutate("post.enqueue", { id: item.id, first: false });
            }}
          />
        ))}
      </ul>
      <p className="mt-4 hidden flex-wrap items-center gap-1 text-xs text-muted-foreground md:flex">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd>
        move between posts.
        <Kbd>E</Kbd>
        edits the post, <Kbd>S</Kbd> gives it another time.
      </p>
      <ScheduleDialog
        open={rescheduling !== null}
        onOpenChange={(open) => {
          if (!open) setRescheduling(null);
        }}
        title="Schedule for another time"
        timeZone={schedule.timeZone}
        initial={rescheduling?.dueAt ?? null}
        onSchedule={(dueAt) => {
          if (!rescheduling) return;
          claimTimeZone(mutate, tablesNow());
          mutate("post.schedule", { id: rescheduling.id, dueAt });
        }}
      />
    </>
  );
}

/** When a post goes out, in words. */
function timeWords(item: QueueItem, schedule: Schedule, now: number): string {
  if (item.dueAt !== null) return whenDue(item.dueAt, now, schedule.timeZone);
  return schedule.paused ? "Paused" : "No posting time";
}

function QueueRow({
  item,
  schedule,
  now,
  moves,
  onEdit,
  onReschedule,
  onSendNow,
  onBackToDrafts,
  onDelete,
  onMove,
  onEnqueue,
}: {
  item: QueueItem;
  schedule: Schedule;
  now: number;
  moves: ReturnType<typeof movesOf>;
  onEdit: () => void;
  onReschedule: () => void;
  onSendNow: () => void;
  onBackToDrafts: () => void;
  onDelete: () => void;
  onMove: (afterId: string | null) => void;
  onEnqueue: () => void;
}) {
  const title = titleOf(item);
  const reconnect = item.channels.filter(
    (channel) => channel.status === "needs_reconnect",
  );
  const { up, down, top } = moves;

  return (
    <li
      data-post={item.id}
      tabIndex={-1}
      className="rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <article aria-label={title} className="flex flex-col gap-2 px-3 py-2.5">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p
            className={cn(
              "font-medium tabular-nums",
              item.held && "text-amber-700 dark:text-amber-400",
            )}
          >
            {item.held ? "Missed" : timeWords(item, schedule, now)}
          </p>
          <span className="rounded-full border px-2 py-px text-xs text-muted-foreground">
            {item.mode === "queue"
              ? `Queue · ${(item.position ?? 0) + 1}`
              : "Scheduled"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {item.mode === "queue" && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move “${title}” up`}
                  disabled={up === undefined}
                  onClick={() => up !== undefined && onMove(up)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move “${title}” down`}
                  disabled={down === undefined}
                  onClick={() => down !== undefined && onMove(down)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for “${title}”`}
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon-sm",
                })}
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onEdit}>
                  <PenLine aria-hidden="true" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onReschedule}>
                  <CalendarClock aria-hidden="true" />
                  {item.mode === "queue"
                    ? "Schedule for a time…"
                    : "Reschedule…"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSendNow}>
                  <Send aria-hidden="true" />
                  Send now
                </DropdownMenuItem>
                {item.mode === "queue" ? (
                  top !== undefined && (
                    <DropdownMenuItem onClick={() => onMove(top)}>
                      <ArrowUpToLine aria-hidden="true" />
                      Move to the top
                    </DropdownMenuItem>
                  )
                ) : (
                  <DropdownMenuItem onClick={onEnqueue}>
                    <ListPlus aria-hidden="true" />
                    Add to queue
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onBackToDrafts}>
                  <Undo2 aria-hidden="true" />
                  Back to drafts
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {item.held && item.dueAt !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-amber-700 dark:text-amber-400">
            <p className="flex min-w-0 flex-1 basis-56 items-start gap-1.5 text-sm">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>
                It was due{" "}
                {whenDue(item.dueAt, now, schedule.timeZone).toLowerCase()}, and
                pigy could not send it within an hour of that. It waits for you:
                send it now, give it another time, or take it back.
              </span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onReschedule}>
                Reschedule…
              </Button>
              <Button size="sm" onClick={onSendNow}>
                Send now
              </Button>
            </div>
          </div>
        )}

        <div className="min-w-0">
          <p className={cn("truncate", !item.title && "text-muted-foreground")}>
            {title}
          </p>
          {item.snippet && (
            <p className="truncate text-muted-foreground">{item.snippet}</p>
          )}
        </div>

        <ul
          aria-label="Goes to"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
        >
          {item.parts > 1 && <li>{item.parts} parts</li>}
          {item.channels.map((channel) => (
            <li key={channel.id} className="flex min-w-0 items-center gap-1.5">
              <Avatar
                name={channel.name}
                src={channel.avatarUrl}
                className="size-5 text-[0.5625rem]"
              />
              <span className="truncate">{channel.handle}</span>
              <span className="sr-only">
                {" "}
                on {networkInfo[channel.network].label}
              </span>
            </li>
          ))}
        </ul>

        {reconnect.map((channel) => (
          <p
            key={channel.id}
            className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            <span>
              {channel.handle} has to be connected again, or this post fails
              there when its time comes.{" "}
              <Link
                to="/channels"
                search={{ reconnect: channel.id }}
                className="font-medium underline underline-offset-4"
              >
                Reconnect {channel.handle}
              </Link>
            </span>
          </p>
        ))}
      </article>
    </li>
  );
}
