import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  fieldZone,
  type Schedule,
  suggestedTime,
  timeFromInput,
  timeToInput,
} from "@/lib/queue";

/**
 * Asks for the time at which a post goes out: a date and a time on the
 * clocks of the zone that `schedule` reads times in, which the dialog
 * names. That is the time zone of the workspace, unless this device
 * cannot compute with it or the workspace has none: then it is UTC, and
 * the dialog says that and why. The
 * field is the browser's own for a date and a time, which a phone shows
 * as its wheels and a keyboard can type into.
 *
 * `onSchedule` gets a time that is still to come, by the clock of this
 * device: an earlier one is said to be one, next to the field.
 */
export function ScheduleDialog({
  open,
  onOpenChange,
  title,
  schedule,
  initial,
  onSchedule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the dialog is called: "Schedule this post". */
  title: string;
  schedule: Schedule;
  /** The time that the post has now, to begin with, if it has one. */
  initial?: number | null;
  onSchedule: (time: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Made anew every time the dialog opens: it begins with a time
            that follows from the moment. */}
        {open && (
          <ScheduleForm
            title={title}
            schedule={schedule}
            initial={initial ?? null}
            onCancel={() => onOpenChange(false)}
            onSchedule={(time) => {
              onOpenChange(false);
              onSchedule(time);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({
  title,
  schedule,
  initial,
  onCancel,
  onSchedule,
}: {
  title: string;
  schedule: Schedule;
  initial: number | null;
  onCancel: () => void;
  onSchedule: (time: number) => void;
}) {
  const id = useId();
  const { timeZone } = schedule;
  const [value, setValue] = useState(() => {
    const now = Date.now();
    // A time that has passed is nothing to begin with.
    return timeToInput(
      initial !== null && initial > now
        ? initial
        : suggestedTime(now, timeZone),
      timeZone,
    );
  });
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const time = timeFromInput(value, timeZone);
    if (time === null) {
      setProblem("Enter a date and a time.");
    } else if (time <= Date.now()) {
      setProblem("That time has passed. Choose one that is still to come.");
    } else {
      onSchedule(time);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          pigy publishes the post at this time, to the accounts that are chosen.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-time`} className="font-medium">
          Date and time
        </label>
        <Input
          id={`${id}-time`}
          type="datetime-local"
          required
          autoFocus
          value={value}
          min={timeToInput(Date.now(), timeZone)}
          aria-invalid={problem !== null}
          aria-describedby={`${id}-zone ${id}-problem`}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
        />
        <p id={`${id}-zone`} className="text-xs text-muted-foreground">
          {fieldZone(schedule)}
        </p>
        <p
          id={`${id}-problem`}
          role="alert"
          className="text-xs text-destructive empty:hidden"
        >
          {problem}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Schedule</Button>
      </DialogFooter>
    </form>
  );
}
