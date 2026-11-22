import { uuidv7 } from "@pigy/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  claimTimeZone,
  deviceTimeZone,
  minuteFromInput,
  minuteLabel,
  selectSchedule,
  slotsByDay,
  weekdayName,
  weekdays,
} from "@/lib/queue";
import { cn } from "@/lib/utils";
import { useMutate, useSynced, useSyncedNow } from "@/sync/react";

export const Route = createFileRoute("/_app/settings/schedule")({
  component: PostingSchedule,
});

/** The time zones that this browser knows, with the one in use among them. */
function zonesWith(...zones: string[]): string[] {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf("timeZone");
  } catch {
    // An older browser: the zones that are in use are all it offers.
  }
  return [...new Set([...zones, "UTC", ...known])].sort((a, b) =>
    a.localeCompare(b),
  );
}

const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

/**
 * The posting schedule of the workspace: the times of the week at which
 * the queue sends its next post, and the time zone that they are in.
 * Synced data, changed with mutators: it is the same on every device, and
 * the posts of the queue move to the new times as soon as one changes.
 */
function PostingSchedule() {
  const schedule = useSynced(selectSchedule);
  const mutate = useMutate();
  const tablesNow = useSyncedNow();
  const id = useId();
  const device = deviceTimeZone();
  // The zone that the workspace has, also one that this device does not
  // know, or the one that it takes from this device with its first slot.
  // None for a workspace that has slots and no zone: the server refused
  // the zone of the device that they were added on.
  const chosen =
    schedule.zoneName ?? (schedule.zone === "device" ? device : null);
  const zones = useMemo(
    () => zonesWith(...(chosen === null ? [] : [chosen]), device),
    [chosen, device],
  );
  const days = slotsByDay(schedule.slots);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby={`${id}-zone`}>
        <h2 id={`${id}-zone`} className="font-medium">
          Time zone
        </h2>
        <p className="mt-1 text-muted-foreground">
          The posting times below are on the clocks of this zone, and so is
          every time that pigy shows in this workspace.
        </p>
        <NativeSelect
          aria-labelledby={`${id}-zone`}
          className="mt-3 w-full max-w-xs"
          value={chosen ?? ""}
          onChange={(event) =>
            mutate("settings.setTimeZone", { timeZone: event.target.value })
          }
        >
          {chosen === null && (
            <NativeSelectOption value="" disabled>
              None yet: UTC
            </NativeSelectOption>
          )}
          {zones.map((zone) => (
            <NativeSelectOption key={zone} value={zone}>
              {zoneLabel(zone)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {schedule.zone === "none" && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            This workspace has no time zone yet, so its posting times are in
            UTC. Choose the zone that they are meant in.
          </p>
        )}
        {schedule.zone === "unknown" && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            This device does not know {zoneLabel(schedule.zoneName ?? "")}, so
            it shows the times of this workspace in UTC. pigy posts by{" "}
            {zoneLabel(schedule.zoneName ?? "")} all the same.
          </p>
        )}
        {chosen !== device && (
          <p className="mt-2 text-xs text-muted-foreground">
            This device is in {zoneLabel(device)}.{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-4"
              onClick={() =>
                mutate("settings.setTimeZone", { timeZone: device })
              }
            >
              Use {zoneLabel(device)}
            </button>
          </p>
        )}
      </section>

      <section aria-labelledby={`${id}-times`}>
        <h2 id={`${id}-times`} className="font-medium">
          Posting times
        </h2>
        <p className="mt-1 text-muted-foreground">
          A post that is added to the queue goes out at the next of these times
          that no post before it has. Every week is the same.{" "}
          <Link
            to="/queue"
            className="font-medium text-foreground underline underline-offset-4"
          >
            See the queue
          </Link>
        </p>
        {days.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground">
            No posting times yet. Add one below: the queue has no time for a
            post without them.
          </p>
        ) : (
          <ul
            aria-label="Posting times"
            className="mt-3 divide-y rounded-lg border"
          >
            {days.map(({ weekday, slots }) => (
              <li
                key={weekday}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2"
              >
                <span className="w-24 shrink-0 font-medium">
                  {weekdayName(weekday)}
                </span>
                <ul
                  aria-label={weekdayName(weekday)}
                  className="flex min-w-0 flex-1 flex-wrap gap-1.5"
                >
                  {slots.map((slot) => (
                    <li
                      key={slot.id}
                      className="inline-flex h-7 items-center gap-1 rounded-full border pr-1 pl-2.5 text-sm tabular-nums"
                    >
                      {minuteLabel(slot.minute)}
                      <button
                        type="button"
                        aria-label={`Remove ${weekdayName(weekday)} ${minuteLabel(slot.minute)}`}
                        className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => mutate("slot.remove", { id: slot.id })}
                      >
                        <X aria-hidden="true" className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <AddSlots
          onAdd={(chosen, minute) => {
            // The times are on the clocks of the zone that this screen
            // shows: the workspace gets it now, if it has none.
            claimTimeZone(mutate, tablesNow());
            for (const weekday of chosen) {
              mutate("slot.add", {
                id: uuidv7(new Date()),
                weekday,
                minute,
              });
            }
          }}
        />
      </section>
    </div>
  );
}

/** A time of day, and the days of the week to add it to. */
function AddSlots({
  onAdd,
}: {
  onAdd: (weekdays: number[], minute: number) => void;
}) {
  const id = useId();
  // Monday to Friday to begin with.
  const [chosen, setChosen] = useState<ReadonlySet<number>>(
    () => new Set([1, 2, 3, 4, 5]),
  );
  const [time, setTime] = useState("09:00");
  const minute = minuteFromInput(time);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (minute === null || chosen.size === 0) return;
    onAdd(
      weekdays.filter((weekday) => chosen.has(weekday)),
      minute,
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Add a posting time"
      className="mt-4 flex flex-col gap-3 rounded-lg border p-3"
    >
      <fieldset className="min-w-0">
        <legend className="mb-1.5 font-medium">Add a time on</legend>
        <div className="flex flex-wrap gap-1.5">
          {weekdays.map((weekday) => {
            const pressed = chosen.has(weekday);
            return (
              <button
                key={weekday}
                type="button"
                aria-pressed={pressed}
                aria-label={weekdayName(weekday)}
                onClick={() => {
                  const next = new Set(chosen);
                  if (pressed) next.delete(weekday);
                  else next.add(weekday);
                  setChosen(next);
                }}
                className={cn(
                  "h-8 min-w-11 rounded-full border px-2.5 text-sm outline-none",
                  "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  pressed
                    ? "border-primary bg-primary/10 font-medium"
                    : "text-muted-foreground",
                )}
              >
                {weekdayName(weekday, "short")}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-time`} className="font-medium">
            Time
          </label>
          <Input
            id={`${id}-time`}
            type="time"
            required
            className="w-32"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={minute === null || chosen.size === 0}>
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
    </form>
  );
}
