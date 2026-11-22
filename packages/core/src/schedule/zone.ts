/**
 * Time zones: what the time on the clocks of a place is at a moment, and
 * the other way round. Everything about the posting schedule of a
 * workspace is said in the time zone of the workspace, an IANA name such
 * as "Europe/Rome", and the mutators that give a queued post its time run
 * in the browser and in the Worker. So both compute with this, from the
 * time zone data of `Intl.DateTimeFormat`, which both have.
 *
 * The two can differ in the data that they have: a browser may know a rule
 * that a government changed last month, and the Worker not yet. The server
 * is the authority, as for everything that a mutator does: what a client
 * computed for display is replaced by what the server says.
 */

const dayMs = 24 * 60 * 60 * 1000;

/**
 * More than any zone is ahead of UTC, in milliseconds: the furthest is 14
 * hours ahead.
 */
const maxAheadMs = 15 * 60 * 60 * 1000;

/** The time on the clocks of a place: a day of the calendar and a time. */
export type LocalTime = {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 for Sunday to 6 for Saturday, as `Date.getDay()` has it. */
  weekday: number;
  /** Minutes since midnight on the clock: 0 to 1439. */
  minute: number;
};

/** A day of the calendar. */
export type LocalDate = Pick<LocalTime, "year" | "month" | "day">;

const formats = new Map<string, Intl.DateTimeFormat>();

function make(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

/** Whether this runtime knows the time zone `name`. */
export function isTimeZone(name: string): boolean {
  if (formats.has(name)) return true;
  try {
    formats.set(name, make(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * The format that reads the clocks of `zone`. A zone that this runtime
 * does not know is read as UTC: the server takes no zone that it does not
 * know, so this is only ever a browser that is behind the server, which
 * shows times that the server then corrects.
 */
function formatOf(zone: string): Intl.DateTimeFormat {
  const format = formats.get(zone);
  if (format) return format;
  if (isTimeZone(zone)) return formatOf(zone);
  return formatOf("UTC");
}

/** What the clocks of `zone` show at `time`, as if they were UTC's. */
function clockAt(zone: string, time: number): number {
  const read: Record<string, number> = {};
  for (const { type, value } of formatOf(zone).formatToParts(time)) {
    if (type !== "literal") read[type] = Number(value);
  }
  return Date.UTC(
    read.year ?? 0,
    (read.month ?? 1) - 1,
    read.day,
    read.hour,
    read.minute,
    read.second,
  );
}

/**
 * How far the clocks of `zone` are ahead of UTC at `time`, in
 * milliseconds: 3,600,000 for Rome in winter.
 */
export function offsetAt(zone: string, time: number): number {
  const seconds = Math.floor(time / 1000) * 1000;
  return clockAt(zone, seconds) - seconds;
}

/** What the clocks of `zone` show at `time`, to the minute. */
export function localTimeAt(zone: string, time: number): LocalTime {
  const clock = new Date(clockAt(zone, time));
  return {
    year: clock.getUTCFullYear(),
    month: clock.getUTCMonth() + 1,
    day: clock.getUTCDate(),
    weekday: clock.getUTCDay(),
    minute: clock.getUTCHours() * 60 + clock.getUTCMinutes(),
  };
}

/** The day `days` days after `date` in the calendar, with its weekday. */
export function addDays(
  { year, month, day }: LocalDate,
  days: number,
): LocalDate & Pick<LocalTime, "weekday"> {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    weekday: moved.getUTCDay(),
  };
}

/**
 * The moment at which the clocks of `zone` show `minute` minutes past
 * midnight on `date`, in milliseconds since the Unix epoch.
 *
 * Twice a year, in a zone with daylight saving, that is not one moment:
 *
 * - A time that the clocks skip, when they are put forward, is taken as
 *   that long after the time before the gap: where the clocks go from
 *   02:00 to 03:00, 02:30 is the moment at which they show 03:30. A slot
 *   at such a time is used on that day, and not left out.
 * - A time that the clocks show twice, when they are put back, is the
 *   first of the two. A slot at such a time is used once.
 *
 * This is what `Temporal` calls "compatible", and what most calendars do.
 */
export function timeOf(zone: string, date: LocalDate, minute: number): number {
  const key = `${zone} ${date.year}-${date.month}-${date.day} ${minute}`;
  const known = moments.get(key);
  if (known !== undefined) return known;
  const moment = momentOf(zone, date, minute);
  // The queue asks for the same days again with every change, so the
  // answers are kept: reading the clocks of a zone is the slow part of
  // giving the posts of a queue their times. Not without end.
  if (moments.size >= maxMoments) moments.clear();
  moments.set(key, moment);
  return moment;
}

/** The moments that `timeOf` has worked out, by zone, day and minute. */
const moments = new Map<string, number>();

/** How many moments are kept: some years of a full schedule. */
const maxMoments = 100_000;

function momentOf(zone: string, date: LocalDate, minute: number): number {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
  // How far the zone is ahead a day before and a day after: the same,
  // unless the clocks are changed in between. No zone changes them twice
  // in two days.
  const before = wanted - offsetAt(zone, wanted - dayMs);
  const after = wanted - offsetAt(zone, wanted + dayMs);
  if (before === after) return before;
  const shows = (time: number) => clockAt(zone, time) === wanted;
  const [first, second] = before < after ? [before, after] : [after, before];
  if (shows(first)) return first;
  if (shows(second)) return second;
  // No moment shows it: the clocks skipped it. The later of the two is
  // the time as the clocks stood before the gap, carried over it.
  return second;
}

/** A time of the week on the clocks of a place. */
export type WeeklyTime = {
  /** 0 for Sunday to 6 for Saturday. */
  weekday: number;
  /** Minutes since midnight: 0 to 1439. */
  minute: number;
};

/**
 * The moments after `after` at which the clocks of `zone` show one of the
 * weekly times `slots`, soonest first, without end: each is later than
 * the one before it. Nothing if there are no slots.
 *
 * On the day on which the clocks are put forward, two slots can fall on
 * one moment, one in the gap and one after it: that moment comes once.
 */
export function* slotTimes(
  zone: string,
  slots: readonly WeeklyTime[],
  after: number,
): Generator<number, void, undefined> {
  if (slots.length === 0) return;
  const minutes: number[][] = [[], [], [], [], [], [], []];
  for (const { weekday, minute } of slots) minutes[weekday]?.push(minute);
  const today = localTimeAt(zone, after);
  /** The moments of the slots of the day `days` days from today. */
  const timesOf = (days: number) => {
    const date = addDays(today, days);
    return (minutes[date.weekday] ?? []).map((minute) =>
      timeOf(zone, date, minute),
    );
  };
  /**
   * No slot of the day `days` days from today is a moment before this
   * one: no zone is further ahead of UTC than this.
   */
  const earliest = (days: number) => {
    const { year, month, day } = addDays(today, days);
    return Date.UTC(year, month - 1, day) - maxAheadMs;
  };
  // The days do not follow each other in their moments where the clocks
  // skip midnight: a slot late on one day is then carried over the gap,
  // to after a slot early on the next. So the moments of a day are kept
  // until no later day can have an earlier one, and come out in order.
  // From two days before: a slot of the day before today can be a moment
  // of today for the same reason.
  const waiting: number[] = [];
  let next = -2;
  let last = after;
  for (;;) {
    const first = waiting[0];
    if (first === undefined || earliest(next) <= first) {
      waiting.push(...timesOf(next));
      waiting.sort((a, b) => a - b);
      next += 1;
      continue;
    }
    waiting.shift();
    if (first <= last) continue;
    last = first;
    yield first;
  }
}
