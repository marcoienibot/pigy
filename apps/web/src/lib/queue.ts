import {
  addDays,
  defaultSettings,
  defaultTimeZone,
  isTimeZone,
  type LocalDate,
  localTimeAt,
  type MutatorArgs,
  type MutatorName,
  maxApiTime,
  ownParts,
  type Row,
  sameTimeZone,
  settingsId,
  type Tables,
  timeOf,
} from "@pigy/core";
import { type Channel, selectChannels } from "@/lib/channels";

/**
 * What the Queue screen, the calendar and the posting schedule show: the
 * posts that will go out and when, and the slots that the queue goes by.
 * All of it is read from the local copy. The times of the queued posts
 * are in their rows, where the mutators keep them, so nothing here
 * computes when a post goes out: it only says it, on the clocks of the
 * time zone of the workspace.
 */

/** A slot of the queue: its row. */
export type Slot = Row<"schedule_slot">;

/** The posting schedule of a workspace. */
export type Schedule = {
  /**
   * The time zone that this device reads and shows the times of the
   * workspace in. It is one that the device can compute with, which is
   * not always the one that the workspace has: `zone` says which it is.
   */
  timeZone: string;
  /**
   * What `timeZone` is:
   *
   * - `set`: the zone that the workspace has set.
   * - `unknown`: UTC, because this device does not know the zone that
   *   the workspace has set, `zoneName`: another device set it, with
   *   newer time zone data. The server computes with that zone. This
   *   device cannot, so it says its times in UTC, and says so.
   * - `device`: the zone of this device. The workspace has none, and
   *   nothing that goes by one: it takes this one with its first slot
   *   or scheduled post, `claimTimeZone`.
   * - `none`: UTC. The workspace has no zone although it has slots or
   *   scheduled posts: the server did not take the zone of the device
   *   that they were made on. Until somebody sets one, the server
   *   computes in UTC, and so does the app.
   */
  zone: "set" | "unknown" | "device" | "none";
  /** The zone that the workspace has set, or null if it has none. */
  zoneName: string | null;
  /** The queue is paused. */
  paused: boolean;
  /** The slots, Monday first, each day in the order of its times. */
  slots: Slot[];
};

/** Monday first: the place of a weekday of `Date.getDay()` in a week. */
const inWeek = (weekday: number) => (weekday + 6) % 7;

/** The time zone of this device, as the browser names it. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || defaultTimeZone;
  } catch {
    return defaultTimeZone;
  }
}

export function selectSchedule(
  tables: Tables,
  device = deviceTimeZone(),
): Schedule {
  const settings = tables.settings.get(settingsId) ?? defaultSettings;
  const zoneName = settings.timeZone;
  let zone: Schedule["zone"];
  if (zoneName !== null) zone = isTimeZone(zoneName) ? "set" : "unknown";
  else zone = goesByZone(tables) ? "none" : "device";
  return {
    timeZone:
      zone === "set" && zoneName !== null
        ? zoneName
        : zone === "device"
          ? device
          : defaultTimeZone,
    zone,
    zoneName,
    paused: settings.queuePaused,
    slots: [...tables.schedule_slot.values()].sort(
      (a, b) =>
        inWeek(a.weekday) - inWeek(b.weekday) ||
        a.minute - b.minute ||
        (a.id < b.id ? -1 : 1),
    ),
  };
}

/**
 * Whether a post is scheduled, as far as a screen is concerned: not one
 * that was put aside, which is deleted but for its Undo and is on no
 * screen.
 */
const isScheduled = (post: Row<"post">) =>
  post.status === "scheduled" && post.trashedAt === null;

/** Whether the workspace has something that goes by its time zone. */
function goesByZone(tables: Tables): boolean {
  if (tables.schedule_slot.size > 0) return true;
  for (const post of tables.post.values()) {
    if (isScheduled(post)) return true;
  }
  return false;
}

const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

/**
 * What a screen that shows times says about the zone that they are in,
 * or null where there is nothing to say: they are in the zone of the
 * workspace, and that is the zone of this device, `device`.
 */
export function zoneNote(
  { timeZone, zone, zoneName }: Schedule,
  device = deviceTimeZone(),
): string | null {
  switch (zone) {
    case "unknown":
      return `Times are in UTC: this device does not know ${zoneLabel(zoneName ?? "")}, the time zone of this workspace.`;
    case "none":
      return "Times are in UTC until this workspace has a time zone.";
    case "set":
      return sameTimeZone(timeZone, device)
        ? null
        : `Times are in ${zoneLabel(timeZone)}, the time zone of this workspace.`;
    case "device":
      return null;
  }
}

/** What the field for a date and a time says about the zone it is read in. */
export function fieldZone({ timeZone, zone, zoneName }: Schedule): string {
  switch (zone) {
    case "unknown":
      return `In UTC: this device does not know ${zoneLabel(zoneName ?? "")}, the time zone of this workspace.`;
    case "none":
      return "In UTC: this workspace has no time zone yet.";
    case "set":
      return `In the time zone of this workspace, ${zoneLabel(timeZone)}.`;
    case "device":
      return `In the time zone of this device, ${zoneLabel(timeZone)}, which this workspace takes as its own.`;
  }
}

/** `mutate` of `@/sync/react`, as the functions here take it. */
type Mutate = <Name extends MutatorName>(
  name: Name,
  args: MutatorArgs<Name>,
) => void;

/**
 * Gives a workspace that has no time zone the one of this device, before
 * the first thing is done that goes by it: a slot is added, a post is
 * queued or scheduled. So the zone of a workspace is that of the device
 * that it was first scheduled on, and what that device showed is what
 * the server computes. A workspace that has a zone keeps it, also when
 * another device gave it one in the meantime: the mutation says so.
 *
 * Only for a workspace that has nothing yet which goes by a zone. One
 * that has slots or scheduled posts and no zone was claimed before, and
 * the server refused: it does not know the zone of the device. The claim
 * is not made again with everything that is scheduled, to be refused
 * again with a notice each time: the screens say that the times are in
 * UTC, and the posting schedule is where somebody chooses a zone.
 */
export function claimTimeZone(
  mutate: Mutate,
  tables: Tables,
  device = deviceTimeZone(),
): void {
  if (selectSchedule(tables, device).zone !== "device") return;
  mutate("settings.setTimeZone", { timeZone: device, onlyIfUnset: true });
}

/** The days of a week, Monday first, as `Date.getDay()` numbers them. */
export const weekdays = [1, 2, 3, 4, 5, 6, 0] as const;

/** The slots of each day that has any, Monday first. */
export function slotsByDay(
  slots: readonly Slot[],
): { weekday: number; slots: Slot[] }[] {
  return weekdays
    .map((weekday) => ({
      weekday,
      slots: slots.filter((slot) => slot.weekday === weekday),
    }))
    .filter((day) => day.slots.length > 0);
}

/** A post that is scheduled, as the Queue screen shows it. */
export type QueueItem = {
  /** The ID of the post. */
  id: string;
  /** In the queue, or at a time that somebody chose. */
  mode: "queue" | "custom";
  /**
   * When it goes out. Null for a post of the queue that has no time:
   * the queue is paused, or the workspace has no slots.
   */
  dueAt: number | null;
  /**
   * Its time passed too long ago for the server to send it still. It
   * waits for somebody to say what becomes of it.
   */
  held: boolean;
  /**
   * Its place in the queue, counted from 0, or null for a post that is
   * not in it. Not the number that its row has, which only says the
   * order and can leave numbers out.
   */
  position: number | null;
  /** The first line that has something in it. */
  title: string;
  /** What follows the title, on one line. */
  snippet: string;
  /** How many parts its text has. */
  parts: number;
  /** The accounts that it goes to, in the order of the Channels screen. */
  channels: Channel[];
};

const snippetLength = 160;

/**
 * The scheduled posts of a workspace, the one that goes out soonest
 * first: those with a time that somebody chose and those of the queue
 * together. A post without a time comes after those that have one, in
 * the order of the queue.
 */
export function selectQueue(tables: Tables): QueueItem[] {
  const scheduled = new Map<string, Row<"post">>();
  for (const post of tables.post.values()) {
    if (isScheduled(post)) scheduled.set(post.id, post);
  }
  if (scheduled.size === 0) return [];
  const parts = new Map<string, Row<"post_part">[]>();
  for (const part of tables.post_part.values()) {
    if (!scheduled.has(part.postId)) continue;
    const of = parts.get(part.postId);
    if (of) of.push(part);
    else parts.set(part.postId, [part]);
  }
  const channels = selectChannels(tables);
  const goesTo = new Map<string, Set<string>>();
  for (const target of tables.post_target.values()) {
    if (!scheduled.has(target.postId)) continue;
    const of = goesTo.get(target.postId) ?? new Set();
    of.add(target.channelId);
    goesTo.set(target.postId, of);
  }

  // The places of the queue, counted: the rows only say the order.
  const places = new Map(
    [...scheduled.values()]
      .filter((post) => post.mode === "queue")
      .sort(
        (a, b) =>
          (a.queuePosition ?? 0) - (b.queuePosition ?? 0) ||
          (a.id < b.id ? -1 : 1),
      )
      .map((post, place) => [post.id, place]),
  );

  const items = [...scheduled.values()].map((post): QueueItem => {
    const all = parts.get(post.id) ?? [];
    let lines = linesOf(ownParts(all));
    // A post whose every account has a text of its own can have none
    // itself: it is called by what one of them gets.
    if (lines.length === 0) lines = linesOf(all);
    return {
      id: post.id,
      mode: post.mode === "queue" ? "queue" : "custom",
      dueAt: post.dueAt,
      held: post.heldAt !== null,
      position: post.mode === "queue" ? (places.get(post.id) ?? null) : null,
      title: lines[0] ?? "",
      snippet: lines.slice(1).join(" ").slice(0, snippetLength),
      parts: ownParts(all).length,
      channels: channels.filter(({ id }) => goesTo.get(post.id)?.has(id)),
    };
  });
  return items.sort(
    (a, b) =>
      // A post without a time after every post that has one.
      Number(a.dueAt === null) - Number(b.dueAt === null) ||
      (a.dueAt ?? 0) - (b.dueAt ?? 0) ||
      (a.position ?? 0) - (b.position ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

const linesOf = (parts: readonly { text: string }[]) =>
  parts
    .flatMap((part) => part.text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The posts of the queue among `items`, in the order of the queue. */
export function inQueueOrder(items: readonly QueueItem[]): QueueItem[] {
  return items
    .filter((item) => item.position !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** Where a post of the queue can be moved: see `movesIn`. */
export type Moves = { up?: string | null; down?: string; top?: null };

/**
 * Where each post of the queue can be moved: what `post.move` is to name
 * as the post to go after, for each way to move it, or undefined where it
 * cannot go that way. `null` names the front. For all posts at once: the
 * order of the queue is worked out once for a list, not once for each of
 * its rows.
 */
export function movesIn(items: readonly QueueItem[]): Map<string, Moves> {
  const queue = inQueueOrder(items);
  return new Map(
    queue.map((item, index) => {
      const below = queue[index + 1];
      return [
        item.id,
        {
          ...(index > 0 && {
            // After the post two before it, which is before the one above.
            up: queue[index - 2]?.id ?? null,
            top: null,
          }),
          ...(below && { down: below.id }),
        },
      ];
    }),
  );
}

// How times are said. Each takes the locale, which the app leaves to the
// device and a test names.

const formats = new Map<string, Intl.DateTimeFormat>();

function format(
  locale: string | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, timeZone, options]);
  let made = formats.get(key);
  if (!made) {
    try {
      made = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      // A zone that this browser does not know: the server knows it, and
      // computes with it. Its times are shown in UTC here, see
      // `packages/core/src/schedule/zone.ts`.
      made = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    }
    formats.set(key, made);
  }
  return made;
}

const dayKey = ({ year, month, day }: LocalDate) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** The day of `time` on the clocks of `zone`, as "2026-01-31". */
export function dayOfTime(time: number, zone: string): string {
  return dayKey(localTimeAt(zone, time));
}

/** The time of day of `time` in `zone`: "09:00". */
export function clockTime(time: number, zone: string, locale?: string): string {
  return format(locale, zone, { hour: "2-digit", minute: "2-digit" }).format(
    time,
  );
}

/**
 * When `time` is, on the clocks of `zone`, as somebody at `now` says it:
 * "Today, 09:00", "Tomorrow, 09:00", "Mon 12 Jan, 09:00", with the year
 * where it is not this one. `inSentence` is for the middle of a
 * sentence, where the day begins small, "today, 09:00", and everything
 * else is written as it is: the name of a day or a month, AM and PM.
 */
export function whenDue(
  time: number,
  now: number,
  zone: string,
  locale?: string,
  inSentence = false,
): string {
  const day = localTimeAt(zone, time);
  const today = localTimeAt(zone, now);
  const clock = clockTime(time, zone, locale);
  const near = (word: string) =>
    `${inSentence ? word.toLowerCase() : word}, ${clock}`;
  if (dayKey(day) === dayKey(today)) return near("Today");
  if (dayKey(day) === dayKey(addDays(today, 1))) return near("Tomorrow");
  if (dayKey(day) === dayKey(addDays(today, -1))) return near("Yesterday");
  const date = format(locale, zone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.year !== today.year && { year: "numeric" }),
  }).format(time);
  return `${date}, ${clock}`;
}

/**
 * When `time` is, for a notice: `whenDue` in the middle of a sentence,
 * on the clocks that this device shows the times of the workspace on,
 * with their zone named wherever that is not the zone of this device,
 * `device`. A notice is read on any screen, also on one that says
 * nothing about the zone, as the drafts: "tomorrow, 09:00" would be
 * taken for a time of the device. The zone is the workspace's, or UTC
 * where the workspace has none or this device cannot compute with it.
 */
export function whenInNotice(
  time: number,
  now: number,
  { timeZone, zone }: Schedule,
  device = deviceTimeZone(),
  locale?: string,
): string {
  const when = whenDue(time, now, timeZone, locale, true);
  const named =
    zone === "unknown" || zone === "none"
      ? !sameTimeZone(defaultTimeZone, device)
      : zone === "set" && !sameTimeZone(timeZone, device);
  return named ? `${when} (${zoneLabel(timeZone)})` : when;
}

/** The name of a weekday of `Date.getDay()`: "Monday", or "Mon". */
export function weekdayName(
  weekday: number,
  width: "long" | "short" = "long",
  locale?: string,
): string {
  // 4 January 1970 was a Sunday.
  return format(locale, "UTC", { weekday: width }).format(
    Date.UTC(1970, 0, 4 + weekday),
  );
}

/** A time of day that is `minute` minutes after midnight: "09:00". */
export function minuteLabel(minute: number, locale?: string): string {
  return clockTime(minute * 60_000, "UTC", locale);
}

/** `minute` as the value of a time field: "09:00". */
export function minuteToInput(minute: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** The minutes after midnight that a time field says, or null. */
export function minuteFromInput(value: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute < 24 * 60 && Number(match[2]) < 60 ? minute : null;
}

/**
 * `time` on the clocks of `zone` as the value of a field for a date and
 * a time: "2026-01-31T09:00".
 */
export function timeToInput(time: number, zone: string): string {
  const local = localTimeAt(zone, time);
  return `${dayKey(local)}T${minuteToInput(local.minute)}`;
}

/**
 * The moment that a field for a date and a time says, read on the clocks
 * of `zone`, or null for a value that is no date and time. A time that
 * the clocks of the zone skip or show twice is read as a slot at that
 * time would be: `timeOf` of `@pigy/core`.
 */
export function timeFromInput(value: string, zone: string): number | null {
  const match = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day, clock = ""] = match;
  const minute = minuteFromInput(clock);
  const date = { year: Number(year), month: Number(month), day: Number(day) };
  // A day that the calendar does not have, such as 31 February.
  if (minute === null || dayKey(addDays(date, 0)) !== dayKey(date)) return null;
  return timeOf(zone, date, minute);
}

/**
 * What keeps the time `time` that a field says from being the time of a
 * post, in words for the person, or null: a value that is no date and
 * time, a time that has passed, and one after the year 9999. A field for
 * a date takes a year of six digits, where a slip of a finger makes the
 * year 20266 of 2026, and such a time cannot be said by the API, which
 * writes a year with four.
 */
export function timeProblem(time: number | null, now: number): string | null {
  if (time === null) return "Enter a date and a time.";
  if (time <= now) {
    return "That time has passed. Choose one that is still to come.";
  }
  if (time > maxApiTime) {
    return "That is too far off. Choose a time before the year 10000.";
  }
  return null;
}

/** The last value that the field for the time of a post takes. */
export const lastTimeInput = "9999-12-31T23:59";

/**
 * The time that the field for scheduling a post begins with: the next
 * full hour that is at least a quarter of an hour away, on the clocks of
 * `zone`.
 */
export function suggestedTime(now: number, zone: string): number {
  const hour = 60 * 60_000;
  const local = localTimeAt(zone, now + 15 * 60_000 + hour);
  return timeOf(zone, local, Math.floor(local.minute / 60) * 60);
}

// The calendar.

/** What the calendar shows of a post. */
export type CalendarEntry = {
  /** The ID of the post. */
  id: string;
  /** When it goes out, or went. */
  time: number;
  /**
   * `scheduled` for a time that somebody chose, `queued` for a slot of
   * the queue, `held` for a time that was missed, and what became of a
   * post that went out: `sending`, `sent` or `failed`.
   */
  kind: "scheduled" | "queued" | "held" | "sending" | "sent" | "failed";
  title: string;
};

/**
 * The posts that have a day: those that are scheduled and have a time,
 * and those that went out, at the time they were sent, or were asked for
 * if they were not. In the order of their times.
 */
export function selectCalendar(tables: Tables): CalendarEntry[] {
  const texts = new Map<string, Row<"post_part">[]>();
  for (const part of tables.post_part.values()) {
    const of = texts.get(part.postId);
    if (of) of.push(part);
    else texts.set(part.postId, [part]);
  }
  const went = new Map<string, number>();
  for (const { postId, sentAt, queuedAt } of tables.post_target.values()) {
    const time = sentAt ?? queuedAt;
    if (time !== null && time > (went.get(postId) ?? 0)) went.set(postId, time);
  }
  const entries: CalendarEntry[] = [];
  for (const post of tables.post.values()) {
    if (post.status === "draft" || post.trashedAt !== null) continue;
    const time = post.status === "scheduled" ? post.dueAt : went.get(post.id);
    // A post of a queue that is paused or has no slots has no day.
    if (time === null || time === undefined) continue;
    const all = texts.get(post.id) ?? [];
    const [title = ""] = [...linesOf(ownParts(all)), ...linesOf(all)];
    entries.push({
      id: post.id,
      time,
      kind:
        post.status === "scheduled"
          ? post.heldAt !== null
            ? "held"
            : post.mode === "queue"
              ? "queued"
              : "scheduled"
          : post.status === "error"
            ? "failed"
            : post.status,
      title,
    });
  }
  return entries.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
}

/** A month of the calendar. */
export type Month = { year: number; month: number };

/** The month of `time` on the clocks of `zone`. */
export function monthOf(time: number, zone: string): Month {
  const { year, month } = localTimeAt(zone, time);
  return { year, month };
}

/** The month `months` months after `month`. */
export function addMonths({ year, month }: Month, months: number): Month {
  const index = year * 12 + (month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** "November 2026". */
export function monthName({ year, month }: Month, locale?: string): string {
  return format(locale, "UTC", { month: "long", year: "numeric" }).format(
    Date.UTC(year, month - 1, 1),
  );
}

/** A day of the month grid. */
export type CalendarDay = LocalDate & {
  /** "2026-01-31". */
  key: string;
  /** Of the month that is shown, and not of the one before or after. */
  inMonth: boolean;
};

/**
 * The weeks that a month is shown as: whole weeks, Monday first, from
 * the week of the first to the week of the last day of the month.
 */
export function weeksOf({ year, month }: Month): CalendarDay[][] {
  const first = addDays({ year, month, day: 1 }, 0);
  const start = -inWeek(first.weekday);
  const weeks: CalendarDay[][] = [];
  for (let offset = start; ; offset += 7) {
    const week = [0, 1, 2, 3, 4, 5, 6].map((day): CalendarDay => {
      const date = addDays({ year, month, day: 1 }, offset + day);
      return {
        year: date.year,
        month: date.month,
        day: date.day,
        key: dayKey(date),
        inMonth: date.month === month,
      };
    });
    if (offset > 0 && !week.some((day) => day.inMonth)) return weeks;
    weeks.push(week);
  }
}

/** `entries` by the day that each is on in `zone`: "2026-01-31". */
export function entriesByDay(
  entries: readonly CalendarEntry[],
  zone: string,
): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const key = dayOfTime(entry.time, zone);
    const of = days.get(key);
    if (of) of.push(entry);
    else days.set(key, [entry]);
  }
  return days;
}

/** "Monday 12 January" for a day of the grid. */
export function dayName(
  { year, month, day }: LocalDate,
  locale?: string,
): string {
  return format(locale, "UTC", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(Date.UTC(year, month - 1, day));
}

// Deleting a scheduled post, and taking that back.

/**
 * Deletes the scheduled post `id`, as far as anybody sees: puts it aside.
 * It is gone from every screen and goes out nowhere, and `restore` takes
 * that back. `deleteForGood` is the second step, when the Undo is no
 * longer offered. The server refuses the first step for a post that is
 * no longer scheduled: a device that has not heard that the post went
 * out must not delete it from the Sent screen of every other.
 */
export function putAside(mutate: Mutate, id: string): void {
  mutate("post.trash", { id });
}

/**
 * Deletes a post that was put aside, and no other: the first step may
 * have been refused, and the post is then not this deletion's.
 */
export function deleteForGood(mutate: Mutate, id: string): void {
  mutate("post.delete", { id, ifTrashed: true });
}

/** What came of taking the deletion of a scheduled post back. */
export type Restored =
  /** It is scheduled again, as it was. */
  | { as: "scheduled" }
  /** Its time had passed by less than an hour: it is being sent. */
  | { as: "sending" }
  /**
   * It is a draft: no account of it is left, or the workspace has as
   * many scheduled posts as it can have.
   */
  | { as: "draft" }
  /**
   * Nothing was taken back, because the post was not deleted: the server
   * refused, and the post is there as what `status` says. It had gone
   * out by then, or somebody had taken it back to the drafts.
   */
  | { as: "there"; status: Row<"post">["status"] }
  /** Nothing: the post is gone, deleted for good on another device. */
  | { as: "gone" };

/**
 * Takes back that the scheduled post `id` was deleted on this device,
 * and says what came of it, as this device knows it. It is the same post
 * again, never a copy: the server does the same to the one row whatever
 * it has heard of meanwhile, and nothing where there is nothing to take
 * back, so a post never goes out twice. `tables` reads the copy anew.
 */
export function restore(
  mutate: Mutate,
  tables: () => Tables,
  id: string,
): Restored {
  const before = tables().post.get(id);
  if (!before) return { as: "gone" };
  if (before.trashedAt === null) return { as: "there", status: before.status };
  mutate("post.restore", { id });
  const status = tables().post.get(id)?.status;
  if (status === "draft") return { as: "draft" };
  return { as: status === "scheduled" ? "scheduled" : "sending" };
}

/**
 * What the person is told about an Undo, or null where the list says it
 * all: the post is back in it. `leadsTo` is the screen that the post is
 * on now, for a notice that offers to go there.
 */
export function undoNotice(back: Restored): {
  title: string;
  description: string;
  leadsTo?: "drafts" | "sent";
} | null {
  switch (back.as) {
    case "scheduled":
      return null;
    case "sending":
      return {
        title: "Brought back, and publishing now",
        description: "Its time has come meanwhile.",
        leadsTo: "sent",
      };
    case "draft":
      return {
        title: "Brought back as a draft",
        description:
          "Its accounts are no longer connected, or this workspace has as many scheduled posts as it can have.",
        leadsTo: "drafts",
      };
    case "gone":
      return {
        title: "Nothing to undo: the post is gone",
        description: "It was deleted on another device as well.",
      };
    case "there": {
      const title = "Nothing to undo: the post was not deleted";
      if (back.status === "draft") {
        return {
          title,
          description:
            "Somebody had taken it back to the drafts before the delete reached pigy.",
          leadsTo: "drafts",
        };
      }
      if (back.status === "scheduled") {
        return {
          title,
          description:
            "It was no longer scheduled when the delete reached pigy, and has been scheduled again since.",
        };
      }
      return {
        title,
        description: "It had gone out before the delete reached pigy.",
        leadsTo: "sent",
      };
    }
  }
}
