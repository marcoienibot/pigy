import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  addMonths,
  type CalendarEntry,
  clockTime,
  dayName,
  dayOfTime,
  entriesByDay,
  type Month,
  monthName,
  monthOf,
  selectCalendar,
  selectSchedule,
  weekdayName,
  weekdays,
  weeksOf,
} from "@/lib/queue";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSynced } from "@/sync/react";

export const Route = createFileRoute("/_app/queue/calendar")({
  component: Calendar,
});

const kindWords: Record<CalendarEntry["kind"], string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  held: "Missed",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

const kindStyles: Record<CalendarEntry["kind"], string> = {
  scheduled: "border-primary/40 bg-primary/10",
  queued: "border-sky-500/40 bg-sky-500/10",
  held: "border-amber-500/60 bg-amber-500/15",
  sending: "border-border bg-muted",
  sent: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/50 bg-destructive/10",
};

/** How many posts a day of the grid lists before it counts the rest. */
const shownPerDay = 3;

/**
 * A month of posts: those that are scheduled, at their times, those of
 * the queue, at their slots, and those that went out. On a wide screen
 * it is a grid of weeks. On a phone, where seven columns leave no room
 * for a word, it is the days of the month that have a post, as a list.
 * Read from the local copy, on the clocks of the time zone of the
 * workspace.
 */
function Calendar() {
  const entries = useSynced(selectCalendar);
  const { timeZone } = useSynced(selectSchedule);
  const now = useNow();
  const today = dayOfTime(now, timeZone);
  // Null follows the month of today, also over midnight at its end.
  const [chosen, setChosen] = useState<Month | null>(null);
  const month = chosen ?? monthOf(now, timeZone);
  const days = useMemo(
    () => entriesByDay(entries, timeZone),
    [entries, timeZone],
  );
  const weeks = weeksOf(month);
  const inMonth = weeks
    .flat()
    .filter((day) => day.inMonth && days.has(day.key));

  return (
    <section aria-label="Calendar">
      <div className="mb-3 flex items-center gap-2">
        <h2 aria-live="polite" className="mr-auto font-medium">
          {monthName(month)}
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={chosen === null}
          onClick={() => setChosen(null)}
        >
          Today
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => setChosen(addMonths(month, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next month"
          onClick={() => setChosen(addMonths(month, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      {/* The grid, where there is room for it. */}
      <table className="hidden w-full table-fixed border-collapse md:table">
        <caption className="sr-only">{monthName(month)}</caption>
        <thead>
          <tr>
            {weekdays.map((weekday) => (
              <th
                key={weekday}
                scope="col"
                className="pb-1 text-left text-xs font-normal text-muted-foreground"
              >
                <span aria-hidden="true">{weekdayName(weekday, "short")}</span>
                <span className="sr-only">{weekdayName(weekday)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.key}>
              {week.map((day) => {
                const posts = days.get(day.key) ?? [];
                return (
                  <td
                    key={day.key}
                    aria-label={dayName(day)}
                    aria-current={day.key === today ? "date" : undefined}
                    className={cn(
                      "h-24 border p-1 align-top",
                      !day.inMonth && "bg-muted/40 text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-full text-xs tabular-nums",
                        day.key === today &&
                          "bg-primary font-medium text-primary-foreground",
                      )}
                    >
                      {day.day}
                    </span>
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {posts.slice(0, shownPerDay).map((entry) => (
                        <li key={entry.id}>
                          <EntryLink
                            entry={entry}
                            timeZone={timeZone}
                            compact
                          />
                        </li>
                      ))}
                      {posts.length > shownPerDay && (
                        <li className="px-1 text-xs text-muted-foreground">
                          {posts.length - shownPerDay} more
                        </li>
                      )}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* The days that have a post, on a phone. */}
      <div className="md:hidden">
        {inMonth.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-8 text-center text-muted-foreground">
            Nothing in {monthName(month)}.
          </p>
        ) : (
          <ul aria-label={monthName(month)} className="flex flex-col gap-4">
            {inMonth.map((day) => (
              <li key={day.key}>
                <h3
                  className={cn(
                    "mb-1 text-sm",
                    day.key === today ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  {dayName(day)}
                  {day.key === today && " · Today"}
                </h3>
                <ul className="flex flex-col gap-1">
                  {(days.get(day.key) ?? []).map((entry) => (
                    <li key={entry.id}>
                      <EntryLink entry={entry} timeZone={timeZone} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ul
        aria-label="Legend"
        className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {(["scheduled", "queued", "sent", "failed", "held"] as const).map(
          (kind) => (
            <li key={kind} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn("size-2.5 rounded-sm border", kindStyles[kind])}
              />
              {kindWords[kind]}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/**
 * A post of the calendar: its time, what it is and how it begins. It
 * leads to where the post is: the list of the queue for one that is to
 * go out, the Sent screen for one that has.
 */
function EntryLink({
  entry,
  timeZone,
  compact = false,
}: {
  entry: CalendarEntry;
  timeZone: string;
  compact?: boolean;
}) {
  const waits =
    entry.kind === "scheduled" ||
    entry.kind === "queued" ||
    entry.kind === "held";
  const className = cn(
    "block rounded-md border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
    compact ? "truncate px-1 py-px text-xs" : "px-2.5 py-1.5",
    kindStyles[entry.kind],
  );
  const content = (
    <>
      <span className="tabular-nums">{clockTime(entry.time, timeZone)}</span>{" "}
      <span className={compact ? "sr-only" : "text-xs text-muted-foreground"}>
        {kindWords[entry.kind]}
        {compact ? ": " : ""}
      </span>
      <span className={compact ? undefined : "block truncate"}>
        {entry.title || "Empty post"}
      </span>
    </>
  );
  return waits ? (
    <Link to="/queue" className={className}>
      {content}
    </Link>
  ) : (
    <Link to="/sent" search={{ post: entry.id }} className={className}>
      {content}
    </Link>
  );
}
