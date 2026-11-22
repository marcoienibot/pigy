import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Pause, Play } from "lucide-react";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcuts } from "@/lib/keyboard";
import { selectSchedule, zoneNote } from "@/lib/queue";
import { cn } from "@/lib/utils";
import { useMutate, useSynced } from "@/sync/react";

export const Route = createFileRoute("/_app/queue")({
  component: Queue,
});

const sectionLink = cn(
  "-mb-px border-b-2 border-transparent pb-2 text-muted-foreground outline-none",
  "hover:text-foreground focus-visible:text-foreground",
  "aria-[current=page]:border-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground",
);

/**
 * What will go out and when: as a list, soonest first, and as a calendar.
 * Both read the local copy. The pause of the queue is here, over both: a
 * mutation like every other, which holds the posts of the queue on every
 * device, and on the server when it has reached it.
 */
function Queue() {
  const schedule = useSynced(selectSchedule);
  const { paused } = schedule;
  // The times of the list and of the calendar are on the clocks of the
  // workspace. Where those are not the clocks of this device, both say
  // whose they are.
  const zone = zoneNote(schedule);
  const mutate = useMutate();
  const toggle = () => mutate("queue.setPaused", { paused: !paused });

  useShortcuts((event) => {
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      toggle();
    }
  });

  return (
    <Page
      title="Queue"
      actions={
        <Button variant="outline" size="sm" onClick={toggle}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? "Resume queue" : "Pause queue"}
          <Kbd className="hidden md:inline-flex">P</Kbd>
        </Button>
      }
    >
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Queue" className="mb-4 flex gap-4 border-b">
          <Link
            to="/queue"
            // Without this it would also be current on the calendar, whose
            // path starts with its own.
            activeOptions={{ exact: true }}
            className={sectionLink}
          >
            List
          </Link>
          <Link to="/queue/calendar" className={sectionLink}>
            Calendar
          </Link>
        </nav>
        {paused && (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2"
          >
            <p className="min-w-0 flex-1 basis-56">
              <span className="font-medium">The queue is paused.</span> Nothing
              of the queue goes out until it is resumed. A post that is
              scheduled for a time of its own still goes out then.
            </p>
            <Button size="sm" onClick={toggle}>
              <Play aria-hidden="true" />
              Resume
            </Button>
          </div>
        )}
        {zone && (
          <p className="mb-3 text-xs text-muted-foreground">
            {zone}{" "}
            {schedule.zone === "none" && (
              <Link
                to="/settings/schedule"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Set a time zone
              </Link>
            )}
          </p>
        )}
        <Outlet />
      </div>
    </Page>
  );
}
