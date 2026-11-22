import { expect, it } from "vitest";
import {
  addDays,
  canonicalTimeZone,
  isTimeZone,
  keptFormats,
  localTimeAt,
  maxFormats,
  offsetAt,
  sameTimeZone,
  slotTimes,
  timeOf,
} from "./zone.ts";

const hour = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);
const iso = (time: number) => new Date(time).toISOString();

/** The first `count` of the moments that `slotTimes` hands out. */
function first(count: number, ...args: Parameters<typeof slotTimes>): string[] {
  const times: string[] = [];
  for (const time of slotTimes(...args)) {
    if (times.length === count) break;
    times.push(iso(time));
  }
  return times;
}

const sunday = 0;
const monday = 1;
const friday = 5;

// In 2026 the clocks of Rome go forward on 29 March, at 01:00 UTC, from
// 02:00 to 03:00, and back on 25 October, at 01:00 UTC, from 03:00 to
// 02:00. Those of New York go forward on 8 March at 07:00 UTC and back on
// 1 November at 06:00 UTC. Sydney is the other way round: back on 5 April,
// forward on 4 October.

it("says how far a zone is ahead of UTC, in winter and in summer", () => {
  expect(offsetAt("Europe/Rome", at("2026-01-15T12:00:00Z"))).toBe(hour);
  expect(offsetAt("Europe/Rome", at("2026-07-15T12:00:00Z"))).toBe(2 * hour);
  expect(offsetAt("America/New_York", at("2026-01-15T12:00:00Z"))).toBe(
    -5 * hour,
  );
  // A zone that is not a whole number of hours from UTC.
  expect(offsetAt("Asia/Kolkata", at("2026-01-15T12:00:00Z"))).toBe(5.5 * hour);
  expect(offsetAt("UTC", at("2026-01-15T12:00:00Z"))).toBe(0);
});

it("changes the offset at the moment the clocks are changed, and not before", () => {
  expect(offsetAt("Europe/Rome", at("2026-03-29T00:59:59Z"))).toBe(hour);
  expect(offsetAt("Europe/Rome", at("2026-03-29T01:00:00Z"))).toBe(2 * hour);
  expect(offsetAt("Europe/Rome", at("2026-10-25T00:59:59Z"))).toBe(2 * hour);
  expect(offsetAt("Europe/Rome", at("2026-10-25T01:00:00Z"))).toBe(hour);
});

it("reads the clocks of a zone, with the day of the week", () => {
  // 23:30 on a Saturday in UTC is Sunday morning in Rome.
  expect(localTimeAt("Europe/Rome", at("2026-01-10T23:30:00Z"))).toEqual({
    year: 2026,
    month: 1,
    day: 11,
    weekday: sunday,
    minute: 30,
  });
  // And the evening of the year before in New York, when it is New Year
  // in UTC.
  expect(localTimeAt("America/New_York", at("2026-01-01T02:00:00Z"))).toEqual({
    year: 2025,
    month: 12,
    day: 31,
    weekday: 3,
    minute: 21 * 60,
  });
});

it("moves through the calendar by days, over the end of a month and of a year", () => {
  expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
    year: 2027,
    month: 1,
    day: 1,
    weekday: friday,
  });
  // 2028 is a leap year.
  expect(addDays({ year: 2028, month: 2, day: 28 }, 2)).toMatchObject({
    month: 3,
    day: 1,
  });
});

it("finds the moment of a time on the clocks of a zone", () => {
  const date = { year: 2026, month: 1, day: 15 };
  expect(iso(timeOf("Europe/Rome", date, 9 * 60))).toBe(
    "2026-01-15T08:00:00.000Z",
  );
  expect(iso(timeOf("America/New_York", date, 9 * 60))).toBe(
    "2026-01-15T14:00:00.000Z",
  );
  // The day begins on the day before in UTC, east of it.
  expect(iso(timeOf("Asia/Kolkata", date, 0))).toBe("2026-01-14T18:30:00.000Z");
});

it("finds the moment of a time on a day on which the clocks change, before and after the change", () => {
  const forward = { year: 2026, month: 3, day: 29 };
  expect(iso(timeOf("Europe/Rome", forward, 60))).toBe(
    "2026-03-29T00:00:00.000Z",
  );
  expect(iso(timeOf("Europe/Rome", forward, 12 * 60))).toBe(
    "2026-03-29T10:00:00.000Z",
  );
  const back = { year: 2026, month: 10, day: 25 };
  expect(iso(timeOf("Europe/Rome", back, 60))).toBe("2026-10-24T23:00:00.000Z");
  expect(iso(timeOf("Europe/Rome", back, 12 * 60))).toBe(
    "2026-10-25T11:00:00.000Z",
  );
});

it("carries a time that the clocks skip over the gap", () => {
  // 02:30 does not exist in Rome on this day. It is taken for half an
  // hour after 02:00 as the clocks stood, which they show as 03:30.
  const time = timeOf("Europe/Rome", { year: 2026, month: 3, day: 29 }, 150);
  expect(iso(time)).toBe("2026-03-29T01:30:00.000Z");
  expect(localTimeAt("Europe/Rome", time).minute).toBe(3 * 60 + 30);
  // The same in a zone west of UTC.
  expect(
    iso(timeOf("America/New_York", { year: 2026, month: 3, day: 8 }, 150)),
  ).toBe("2026-03-08T07:30:00.000Z");
  // And in the south, where the clocks go forward in October.
  expect(
    iso(timeOf("Australia/Sydney", { year: 2026, month: 10, day: 4 }, 150)),
  ).toBe("2026-10-03T16:30:00.000Z");
});

it("takes the first of the two moments at which the clocks show a time twice", () => {
  // 02:30 comes twice in Rome on this day: at 00:30 UTC, in summer time,
  // and at 01:30 UTC.
  expect(
    iso(timeOf("Europe/Rome", { year: 2026, month: 10, day: 25 }, 150)),
  ).toBe("2026-10-25T00:30:00.000Z");
  expect(
    iso(timeOf("America/New_York", { year: 2026, month: 11, day: 1 }, 90)),
  ).toBe("2026-11-01T05:30:00.000Z");
  expect(
    iso(timeOf("Australia/Sydney", { year: 2026, month: 4, day: 5 }, 150)),
  ).toBe("2026-04-04T15:30:00.000Z");
});

const weekly = [
  { weekday: monday, minute: 9 * 60 },
  { weekday: friday, minute: 17 * 60 },
];

it("hands out the slots of a week in the order of their time, and turns to the next week", () => {
  // A Friday evening in Rome, after the slot of that day.
  expect(first(4, "Europe/Rome", weekly, at("2026-01-16T17:00:00Z"))).toEqual([
    "2026-01-19T08:00:00.000Z",
    "2026-01-23T16:00:00.000Z",
    "2026-01-26T08:00:00.000Z",
    "2026-01-30T16:00:00.000Z",
  ]);
});

it("hands out a slot of the same day only if its time is still to come", () => {
  // Friday 16:59 in Rome: the slot at 17:00 is a minute away.
  expect(first(1, "Europe/Rome", weekly, at("2026-01-16T15:59:00Z"))).toEqual([
    "2026-01-16T16:00:00.000Z",
  ]);
  // At 17:00 sharp it has passed: a slot is a moment after the one asked.
  expect(first(1, "Europe/Rome", weekly, at("2026-01-16T16:00:00Z"))).toEqual([
    "2026-01-19T08:00:00.000Z",
  ]);
});

it("goes by the day of the week of the zone, not of UTC", () => {
  // Monday 00:30 in Kolkata is still Sunday in UTC.
  expect(
    first(
      1,
      "Asia/Kolkata",
      [{ weekday: monday, minute: 30 }],
      at("2026-01-17T00:00:00Z"),
    ),
  ).toEqual(["2026-01-18T19:00:00.000Z"]);
});

it("keeps a slot at the same time on the clocks when they are changed", () => {
  const mondays = [{ weekday: monday, minute: 9 * 60 }];
  // 09:00 in Rome is 08:00 UTC before the last Sunday of March, and 07:00
  // after it.
  expect(first(2, "Europe/Rome", mondays, at("2026-03-22T12:00:00Z"))).toEqual([
    "2026-03-23T08:00:00.000Z",
    "2026-03-30T07:00:00.000Z",
  ]);
  expect(first(2, "Europe/Rome", mondays, at("2026-10-18T12:00:00Z"))).toEqual([
    "2026-10-19T07:00:00.000Z",
    "2026-10-26T08:00:00.000Z",
  ]);
});

it("uses a slot at a time that the clocks skip once, at the end of the gap, also when another slot is there", () => {
  const slots = [
    { weekday: sunday, minute: 150 },
    { weekday: sunday, minute: 210 },
  ];
  // On 29 March, 02:30 is carried to the moment that shows 03:30, where
  // the other slot is: one moment, handed out once. A week later they are
  // two again.
  expect(first(3, "Europe/Rome", slots, at("2026-03-28T12:00:00Z"))).toEqual([
    "2026-03-29T01:30:00.000Z",
    "2026-04-05T00:30:00.000Z",
    "2026-04-05T01:30:00.000Z",
  ]);
});

it("keeps the slots of a day in the order of their moments where a skipped time overtakes a later one", () => {
  const slots = [
    { weekday: sunday, minute: 150 },
    { weekday: sunday, minute: 180 },
  ];
  // 03:00 is the moment the gap ends, and 02:30 is carried past it: the
  // slot at 03:00 comes first on this day, and neither is lost.
  expect(first(2, "Europe/Rome", slots, at("2026-03-28T12:00:00Z"))).toEqual([
    "2026-03-29T01:00:00.000Z",
    "2026-03-29T01:30:00.000Z",
  ]);
});

it("uses a slot at a time that the clocks show twice once", () => {
  const slots = [{ weekday: sunday, minute: 150 }];
  expect(first(2, "Europe/Rome", slots, at("2026-10-24T12:00:00Z"))).toEqual([
    "2026-10-25T00:30:00.000Z",
    "2026-11-01T01:30:00.000Z",
  ]);
  // Asked between the two moments that show 02:30, the slot has passed.
  expect(first(1, "Europe/Rome", slots, at("2026-10-25T01:00:00Z"))).toEqual([
    "2026-11-01T01:30:00.000Z",
  ]);
});

it("keeps the slots of two days in the order of their moments where the clocks skip the hour before midnight", () => {
  const saturday = 6;
  const slots = [
    { weekday: saturday, minute: 23 * 60 + 30 },
    { weekday: sunday, minute: 0 },
  ];
  // The clocks of Nuuk go from 23:00 on Saturday 28 March 2026 to 00:00
  // on Sunday, at 01:00 UTC. Saturday's 23:30 is carried to the moment
  // that shows 00:30 on Sunday, which is after Sunday's own slot at
  // midnight: the slot of the later day comes first, and is not lost. A
  // week later they are in the order of their days again, an hour ahead
  // of UTC less than before.
  expect(first(4, "America/Nuuk", slots, at("2026-03-28T12:00:00Z"))).toEqual([
    "2026-03-29T01:00:00.000Z",
    "2026-03-29T01:30:00.000Z",
    "2026-04-05T00:30:00.000Z",
    "2026-04-05T01:00:00.000Z",
  ]);
});

it("computes with a zone that is three quarters of an hour off the hour", () => {
  // The Chatham Islands are 12:45 ahead of UTC, and 13:45 in summer. In
  // 2026 their clocks go back on 5 April, from 03:45 to 02:45, at 14:00
  // UTC of the 4th, and forward on 27 September, from 02:45 to 03:45, at
  // 14:00 UTC of the 26th.
  const zone = "Pacific/Chatham";
  expect(offsetAt(zone, at("2026-01-15T00:00:00Z"))).toBe(13.75 * hour);
  expect(offsetAt(zone, at("2026-07-15T00:00:00Z"))).toBe(12.75 * hour);
  expect(iso(timeOf(zone, { year: 2026, month: 6, day: 1 }, 9 * 60))).toBe(
    "2026-05-31T20:15:00.000Z",
  );
  // 03:00 on 5 April is shown twice: the first time counts.
  expect(iso(timeOf(zone, { year: 2026, month: 4, day: 5 }, 3 * 60))).toBe(
    "2026-04-04T13:15:00.000Z",
  );
  // 03:00 on 27 September is skipped: it is the moment that shows 04:00.
  expect(iso(timeOf(zone, { year: 2026, month: 9, day: 27 }, 3 * 60))).toBe(
    "2026-09-26T14:15:00.000Z",
  );
});

it("computes with a zone whose clocks change by half an hour", () => {
  // Lord Howe Island is 10:30 ahead of UTC, and 11:00 in summer. In 2026
  // its clocks go back on 5 April, from 02:00 to 01:30, at 15:00 UTC of
  // the 4th, and forward on 4 October, from 02:00 to 02:30, at 15:30 UTC
  // of the 3rd.
  const zone = "Australia/Lord_Howe";
  expect(offsetAt(zone, at("2026-01-15T00:00:00Z"))).toBe(11 * hour);
  expect(offsetAt(zone, at("2026-07-15T00:00:00Z"))).toBe(10.5 * hour);
  // 01:45 on 5 April is shown twice: the first time counts.
  expect(iso(timeOf(zone, { year: 2026, month: 4, day: 5 }, 105))).toBe(
    "2026-04-04T14:45:00.000Z",
  );
  // 02:15 on 4 October is skipped: it is the moment that shows 02:45.
  expect(iso(timeOf(zone, { year: 2026, month: 10, day: 4 }, 135))).toBe(
    "2026-10-03T15:45:00.000Z",
  );
  // So a slot at 02:15 and one at 02:45 are one moment on that day, and
  // two a week later.
  const slots = [
    { weekday: sunday, minute: 135 },
    { weekday: sunday, minute: 165 },
  ];
  expect(first(3, zone, slots, at("2026-10-03T00:00:00Z"))).toEqual([
    "2026-10-03T15:45:00.000Z",
    "2026-10-10T15:15:00.000Z",
    "2026-10-10T15:45:00.000Z",
  ]);
});

it("hands out the slots of a zone of the southern hemisphere over the end of its summer time", () => {
  // The clocks of Sydney go back on 5 April 2026, from 03:00 to 02:00, at
  // 16:00 UTC of the 4th: 02:30 is shown twice, and the slot is used the
  // first time. A week later it is an hour later by UTC.
  const slots = [{ weekday: sunday, minute: 150 }];
  expect(
    first(2, "Australia/Sydney", slots, at("2026-04-03T00:00:00Z")),
  ).toEqual(["2026-04-04T15:30:00.000Z", "2026-04-11T16:30:00.000Z"]);
});

it("hands out nothing without slots", () => {
  expect(first(1, "Europe/Rome", [], at("2026-01-16T17:00:00Z"))).toEqual([]);
});

it("knows a zone of the IANA database and no other", () => {
  expect(isTimeZone("Europe/Rome")).toBe(true);
  expect(isTimeZone("UTC")).toBe(true);
  expect(isTimeZone("Europe/Atlantis")).toBe(false);
  expect(isTimeZone("")).toBe(false);
});

/** `name` in every way to write it in capitals and small letters. */
function spellings(name: string, count: number): string[] {
  const letters = [...name].flatMap((character, index) =>
    /[a-z]/i.test(character) ? [index] : [],
  );
  return Array.from({ length: count }, (_, number) =>
    [...name]
      .map((character, index) => {
        const bit = letters.indexOf(index);
        // The bits of the number say which letters are capitals.
        return bit >= 0 && (number >> bit) & 1
          ? character.toUpperCase()
          : character.toLowerCase();
      })
      .join(""),
  );
}

it("keeps nothing of the zones that it is asked about, however they are written", () => {
  // Computed with once, so that the zone itself is among what is kept.
  offsetAt("Europe/Rome", 0);
  const before = keptFormats();
  const names = spellings("Europe/Rome", 500);
  expect(new Set(names).size).toBe(500);

  // What a client can send: every spelling is a name of the zone, and a
  // format for each would be tens of megabytes in the memory that the
  // objects of all workspaces share.
  for (const name of names) {
    expect(isTimeZone(name)).toBe(true);
    expect(canonicalTimeZone(name)).toBe("Europe/Rome");
  }

  expect(keptFormats()).toBe(before);
});

it("keeps the formats of the zones that it computes with, up to a bound", () => {
  // More names than are kept, each computed with.
  for (const name of spellings("Europe/Rome", maxFormats * 3)) {
    expect(offsetAt(name, at("2026-01-15T12:00:00Z"))).toBe(60 * 60 * 1000);
    expect(keptFormats()).toBeLessThanOrEqual(maxFormats);
  }
  // Names that it does not know are kept too, and count: a browser that
  // is behind the server computes with one for every time that it shows.
  for (let number = 0; number < maxFormats * 3; number += 1) {
    expect(offsetAt(`Europe/Atlantis${number}`, 0)).toBe(0);
    expect(keptFormats()).toBeLessThanOrEqual(maxFormats);
  }
});

it("takes two names for one zone where they are spellings or names of the same, and not otherwise", () => {
  expect(sameTimeZone("Europe/Rome", "europe/rome")).toBe(true);
  // An older name of a zone and its newer one, which runtimes do not
  // agree on which to report.
  expect(sameTimeZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
  expect(sameTimeZone("Europe/Rome", "Europe/Paris")).toBe(false);
  // Unknown to this runtime: the same only as they are written.
  expect(sameTimeZone("Europe/Atlantis", "Europe/Atlantis")).toBe(true);
  expect(sameTimeZone("Europe/Atlantis", "europe/atlantis")).toBe(false);
  expect(canonicalTimeZone("Europe/Atlantis")).toBeNull();
});

it("reads a zone that it does not know as UTC", () => {
  const time = at("2026-07-15T12:00:00Z");
  expect(offsetAt("Europe/Atlantis", time)).toBe(0);
  expect(
    iso(timeOf("Europe/Atlantis", { year: 2026, month: 7, day: 15 }, 60)),
  ).toBe("2026-07-15T01:00:00.000Z");
});
