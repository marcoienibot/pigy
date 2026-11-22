import {
  addDays,
  defaultSettings,
  defaultTimeZone,
  isTimeZone,
  type LocalDate,
  localTimeAt,
  type MutatorArgs,
  type MutatorName,
  ownParts,
  partsFor,
  type Row,
  settingsId,
  type Tables,
  timeOf,
} from "@pigy/core";
import { type Channel, selectChannels } from "@/lib/channels";
import { restoreOwnText } from "@/lib/drafts";

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

/** Whether the workspace has something that goes by its time zone. */
function goesByZone(tables: Tables): boolean {
  if (tables.schedule_slot.size > 0) return true;
  for (const post of tables.post.values()) {
    if (post.status === "scheduled") return true;
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
      return timeZone === device
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
    if (post.status === "scheduled") scheduled.set(post.id, post);
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
    if (post.status === "draft") continue;
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

// Deleting a scheduled post, and bringing it back.

/** What a scheduled post was, for the Undo of its deletion. */
export type TakenPost = {
  /** The ID that it had. */
  id: string;
  /** The texts of its parts, in order. */
  texts: string[];
  /** Where it went, each account with the text that was written for it. */
  targets: { channelId: string; own: string[] | null }[];
  /** When it was to go out: a time, or its place in the queue. */
  when:
    | { mode: "custom"; dueAt: number | null }
    | { mode: "queue"; afterId: string | null };
};

/** Reads what the scheduled post `id` is, before it is deleted. */
export function takePost(tables: Tables, id: string): TakenPost | undefined {
  const post = tables.post.get(id);
  if (!post) return undefined;
  const parts = [...tables.post_part.values()].filter(
    (part) => part.postId === id,
  );
  const targets = [...tables.post_target.values()].filter(
    (target) => target.postId === id,
  );
  const queue = inQueueOrder(selectQueue(tables));
  const place = queue.findIndex((item) => item.id === id);
  return {
    id,
    texts: ownParts(parts).map(({ text }) => text),
    targets: targets.map((target) => {
      const own = partsFor(parts, target.id);
      return {
        channelId: target.channelId,
        own: own.some((part) => part.targetId === target.id)
          ? own.map(({ text }) => text)
          : null,
      };
    }),
    when:
      post.mode === "queue"
        ? { mode: "queue", afterId: queue[place - 1]?.id ?? null }
        : { mode: "custom", dueAt: post.dueAt },
  };
}

/**
 * Deletes the scheduled post `id`, and only a scheduled one: a device
 * that has not heard that the post went out must not delete it from the
 * Sent screen of every other, and `bringBack` counts on the post being
 * there then.
 */
export function deleteScheduled(mutate: Mutate, id: string): void {
  mutate("post.delete", { id, ifScheduled: true });
}

/** What came of bringing a deleted post back. */
export type BroughtBack =
  /** A new post, scheduled as the deleted one was. */
  | { as: "scheduled"; id: string }
  /**
   * A new post that is a draft: no account of it is left, or its time
   * has passed.
   */
  | { as: "draft"; id: string }
  /**
   * Nothing: the post is there. The server did not delete it, because it
   * was on its way or had gone out by then.
   */
  | { as: "there"; id: string };

/**
 * Brings a scheduled post that was deleted back: a post that is deleted
 * is gone for every device, so this is a new one with the same text,
 * which goes to the same accounts, those that are still connected, and
 * at the same time or to the same place in the queue.
 *
 * The post must not go out twice, once as itself and once as its copy.
 * So nothing is brought back while the post is there, which it is again
 * when the server has refused to delete it. And the copy is scheduled
 * only if the post is gone, `ifGone` of the mutators: a device can press
 * Undo before it has heard what the server made of the delete, and
 * without a connection it hears nothing for hours. If the post went out
 * meanwhile, the copy stays a draft, and the person is told.
 */
export function bringBack(
  mutate: Mutate,
  tables: Tables,
  taken: TakenPost,
  now: number,
  newId: () => string,
): BroughtBack {
  if (tables.post.has(taken.id)) return { as: "there", id: taken.id };
  const id = newId();
  const [first = "", ...more] = taken.texts;
  let last = newId();
  mutate("post.create", { id, partId: last, text: first });
  for (const text of more) {
    const partId = newId();
    mutate("part.add", {
      id: partId,
      postId: id,
      channelId: null,
      afterId: last,
      text,
    });
    last = partId;
  }
  let chosen = 0;
  for (const { channelId, own } of taken.targets) {
    if (!tables.channel.has(channelId)) continue;
    chosen += 1;
    mutate("target.add", { id: newId(), postId: id, channelId });
    if (own) {
      restoreOwnText(
        mutate,
        id,
        channelId,
        own.map((text) => ({ text })),
        newId,
      );
    }
  }
  if (chosen === 0) return { as: "draft", id };
  if (taken.when.mode === "queue") {
    mutate("post.enqueue", { id, first: false, ifGone: taken.id });
    // Back to where it was, if the post before it is still in the queue.
    const { afterId } = taken.when;
    if (
      afterId === null ||
      inQueueOrder(selectQueue(tables)).some((item) => item.id === afterId)
    ) {
      mutate("post.move", { id, afterId });
    }
    return { as: "scheduled", id };
  }
  const { dueAt } = taken.when;
  if (dueAt === null || dueAt <= now) return { as: "draft", id };
  mutate("post.schedule", { id, dueAt, ifGone: taken.id });
  return { as: "scheduled", id };
}
