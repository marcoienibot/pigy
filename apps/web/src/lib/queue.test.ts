import { settingsId } from "@pigy/core";
import { expect, it } from "vitest";
import {
  addMonths,
  entriesByDay,
  minuteFromInput,
  minuteLabel,
  monthName,
  movesOf,
  nextQueueTime,
  type Schedule,
  selectCalendar,
  selectQueue,
  selectSchedule,
  slotsByDay,
  suggestedTime,
  timeFromInput,
  timeToInput,
  weekdayName,
  weeksOf,
  whenDue,
} from "./queue.ts";
import {
  channel,
  id,
  part,
  post,
  tablesOf,
  target,
} from "./rows.test-support.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (time: number | null) =>
  time === null ? null : new Date(time).toISOString();

const rome = "Europe/Rome";

/** A scheduled post with one part and a target to `channelId`. */
function scheduledPost(
  text: string,
  channelId: string,
  fields: Parameters<typeof post>[0] = {},
) {
  const row = post({ status: "scheduled", mode: "custom", ...fields });
  return {
    post: row,
    part: part(row.id, { text }),
    target: target(row.id, channelId),
  };
}

function tablesWith(...made: ReturnType<typeof scheduledPost>[]) {
  return {
    post: made.map((one) => one.post),
    post_part: made.map((one) => one.part),
    post_target: made.map((one) => one.target),
  };
}

it("reads the schedule of a workspace that has set nothing: UTC, not paused, no slots", () => {
  expect(selectSchedule(tablesOf({}))).toEqual({
    timeZone: "UTC",
    zoneSet: false,
    paused: false,
    slots: [],
  });
});

it("lists the slots Monday first, each day in the order of its times", () => {
  const slot = (weekday: number, minute: number) => ({
    id: id(),
    weekday,
    minute,
  });
  const sunday = slot(0, 600);
  const mondayLate = slot(1, 1020);
  const mondayEarly = slot(1, 540);
  const schedule = selectSchedule(
    tablesOf({
      schedule_slot: [sunday, mondayLate, mondayEarly],
      settings: [{ id: settingsId, timeZone: rome, queuePaused: true }],
    }),
  );

  expect(schedule).toMatchObject({
    timeZone: rome,
    zoneSet: true,
    paused: true,
  });
  expect(schedule.slots).toEqual([mondayEarly, mondayLate, sunday]);
  // A day without a slot is not listed.
  expect(slotsByDay(schedule.slots)).toEqual([
    { weekday: 1, slots: [mondayEarly, mondayLate] },
    { weekday: 0, slots: [sunday] },
  ]);
});

it("lists the scheduled posts soonest first, the queue and the chosen times together, and those without a time last", () => {
  const ada = channel();
  const chosen = scheduledPost("Chosen", ada.id, { dueAt: 2000 });
  const queuedFirst = scheduledPost("Queued first", ada.id, {
    mode: "queue",
    dueAt: 1000,
    queuePosition: 0,
  });
  const queuedLater = scheduledPost("Queued later", ada.id, {
    mode: "queue",
    dueAt: 3000,
    queuePosition: 1,
  });
  // A draft and a post that went out are not the Queue screen's.
  const draft = scheduledPost("Draft", ada.id, { status: "draft", mode: null });
  const sent = scheduledPost("Sent", ada.id, { status: "sent", dueAt: 500 });
  const tables = tablesOf({
    channel: [ada],
    ...tablesWith(queuedLater, chosen, draft, sent, queuedFirst),
  });

  expect(
    selectQueue(tables).map(({ title, mode, dueAt }) => [title, mode, dueAt]),
  ).toEqual([
    ["Queued first", "queue", 1000],
    ["Chosen", "custom", 2000],
    ["Queued later", "queue", 3000],
  ]);
});

it("lists the posts of a paused queue in its order, after a post that has a time", () => {
  const ada = channel();
  const second = scheduledPost("Second", ada.id, {
    mode: "queue",
    queuePosition: 1,
  });
  const first = scheduledPost("First", ada.id, {
    mode: "queue",
    queuePosition: 0,
  });
  const chosen = scheduledPost("Chosen", ada.id, { dueAt: 9000 });
  const tables = tablesOf({
    channel: [ada],
    ...tablesWith(second, chosen, first),
  });

  expect(selectQueue(tables).map(({ title }) => title)).toEqual([
    "Chosen",
    "First",
    "Second",
  ]);
});

it("says of a scheduled post where it goes, what it begins with and whether it is held", () => {
  const ada = channel();
  const grace = channel({ handle: "@grace@mastodon.example", accountId: "2" });
  const made = scheduledPost("\n  A title \nand more\nlines", ada.id, {
    dueAt: 1000,
    heldAt: 5000,
  });
  const tables = tablesOf({
    channel: [grace, ada],
    post: [made.post],
    post_part: [made.part, part(made.post.id, { position: 1, text: "Two" })],
    post_target: [made.target, target(made.post.id, grace.id)],
  });

  expect(selectQueue(tables)).toEqual([
    {
      id: made.post.id,
      mode: "custom",
      dueAt: 1000,
      held: true,
      position: null,
      title: "A title",
      snippet: "and more lines Two",
      parts: 2,
      channels: [ada, grace],
    },
  ]);
});

it("names the post to go after for each way that a post of the queue can move", () => {
  const ada = channel();
  const [a, b, c] = [0, 1, 2].map((queuePosition) =>
    scheduledPost(`Post ${queuePosition}`, ada.id, {
      mode: "queue",
      dueAt: 1000 + queuePosition,
      queuePosition,
    }),
  );
  if (!a || !b || !c) throw new Error("Three posts");
  const chosen = scheduledPost("Chosen", ada.id, { dueAt: 5 });
  const items = selectQueue(
    tablesOf({ channel: [ada], ...tablesWith(a, b, c, chosen) }),
  );

  // The first cannot go up, the last cannot go down.
  expect(movesOf(items, a.post.id)).toEqual({ down: b.post.id });
  // Up from the second place is to the front.
  expect(movesOf(items, b.post.id)).toEqual({
    up: null,
    top: null,
    down: c.post.id,
  });
  // Up from the third is to after the first.
  expect(movesOf(items, c.post.id)).toEqual({ up: a.post.id, top: null });
  // A post with a time of its own is not in the queue.
  expect(movesOf(items, chosen.post.id)).toEqual({});
});

const weekly: Schedule = {
  timeZone: rome,
  zoneSet: true,
  paused: false,
  slots: [
    { id: id(), weekday: 1, minute: 540 },
    { id: id(), weekday: 3, minute: 540 },
  ],
};

it("says which slot a post that is added to the queue would get, and one that is shared next", () => {
  const ada = channel();
  const queued = scheduledPost("Queued", ada.id, {
    mode: "queue",
    dueAt: at("2026-01-05T08:00:00Z"),
    queuePosition: 0,
  });
  const items = selectQueue(
    tablesOf({ channel: [ada], ...tablesWith(queued) }),
  );
  // Monday 5 January 2026, 08:00 in Rome.
  const now = at("2026-01-05T07:00:00Z");

  // Behind the post that has Monday's slot.
  expect(iso(nextQueueTime(weekly, items, now))).toBe(
    "2026-01-07T08:00:00.000Z",
  );
  expect(iso(nextQueueTime(weekly, items, now, true))).toBe(
    "2026-01-05T08:00:00.000Z",
  );
  // A post whose time has come takes no slot: it is as good as gone.
  expect(iso(nextQueueTime(weekly, items, at("2026-01-05T08:00:30Z")))).toBe(
    "2026-01-07T08:00:00.000Z",
  );
});

it("has no time to offer for a queue that is paused or has no slots", () => {
  expect(nextQueueTime({ ...weekly, paused: true }, [], 0)).toBeNull();
  expect(nextQueueTime({ ...weekly, slots: [] }, [], 0)).toBeNull();
});

it("says when a post is due on the clocks of the zone, as somebody there would", () => {
  const now = at("2026-01-05T22:30:00Z");
  const say = (time: string, zone = rome) =>
    whenDue(at(time), now, zone, "en-GB");

  // 23:30 in Rome: half an hour later is tomorrow there, and today in UTC.
  expect(say("2026-01-05T22:45:00Z")).toBe("Today, 23:45");
  expect(say("2026-01-05T23:00:00Z")).toBe("Tomorrow, 00:00");
  expect(say("2026-01-05T23:00:00Z", "UTC")).toBe("Today, 23:00");
  expect(say("2026-01-04T12:00:00Z")).toBe("Yesterday, 13:00");
  expect(say("2026-01-12T08:00:00Z")).toBe("Mon 12 Jan, 09:00");
  // With the year where it is another one.
  expect(say("2027-01-12T08:00:00Z")).toBe("Tue, 12 Jan 2027, 09:00");
});

it("names weekdays, times of day and months", () => {
  expect(weekdayName(1, "long", "en-GB")).toBe("Monday");
  expect(weekdayName(0, "short", "en-GB")).toBe("Sun");
  expect(minuteLabel(9 * 60 + 5, "en-GB")).toBe("09:05");
  expect(minuteLabel(17 * 60, "en-US")).toBe("05:00 PM");
  expect(monthName({ year: 2026, month: 11 }, "en-GB")).toBe("November 2026");
});

it("reads the time of a field on the clocks of the zone, and writes one back", () => {
  const time = timeFromInput("2026-07-15T09:30", rome);
  expect(iso(time)).toBe("2026-07-15T07:30:00.000Z");
  expect(timeToInput(time ?? 0, rome)).toBe("2026-07-15T09:30");
  // Another zone, another moment.
  expect(iso(timeFromInput("2026-07-15T09:30", "America/New_York"))).toBe(
    "2026-07-15T13:30:00.000Z",
  );
});

it("refuses what is no date and time", () => {
  expect(timeFromInput("", rome)).toBeNull();
  expect(timeFromInput("2026-07-15", rome)).toBeNull();
  expect(timeFromInput("2026-02-31T09:30", rome)).toBeNull();
  expect(timeFromInput("2026-07-15T24:00", rome)).toBeNull();
  expect(minuteFromInput("09:60")).toBeNull();
  expect(minuteFromInput("23:59")).toBe(1439);
});

it("suggests the next full hour that is a quarter of an hour away or more", () => {
  const suggest = (now: string) =>
    timeToInput(suggestedTime(at(now), rome), rome);

  expect(suggest("2026-01-05T07:10:00Z")).toBe("2026-01-05T09:00");
  // Ten minutes before the hour is too soon for that hour.
  expect(suggest("2026-01-05T07:50:00Z")).toBe("2026-01-05T10:00");
  expect(suggest("2026-01-05T22:50:00Z")).toBe("2026-01-06T01:00");
});

it("lays a month out in whole weeks, Monday first", () => {
  // November 2026 begins on a Sunday and ends on a Monday: six weeks.
  const weeks = weeksOf({ year: 2026, month: 11 });

  expect(weeks).toHaveLength(6);
  expect(weeks[0]?.map(({ key }) => key)).toEqual([
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ]);
  expect(weeks[0]?.map(({ inMonth }) => inMonth)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  expect(weeks.at(-1)?.[0]).toMatchObject({ key: "2026-11-30", inMonth: true });
  // February 2027 begins on a Monday and has four weeks exactly.
  expect(weeksOf({ year: 2027, month: 2 })).toHaveLength(4);
});

it("turns the year when it moves through the months", () => {
  expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({
    year: 2027,
    month: 1,
  });
  expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({
    year: 2025,
    month: 12,
  });
});

it("gives a post of the calendar its day and what it is: scheduled, queued, held, or what became of it", () => {
  const ada = channel();
  const chosen = scheduledPost("Chosen", ada.id, { dueAt: 3000 });
  const queued = scheduledPost("Queued", ada.id, {
    mode: "queue",
    dueAt: 2000,
    queuePosition: 0,
  });
  const held = scheduledPost("Held", ada.id, { dueAt: 1000, heldAt: 1500 });
  // A post of a paused queue has no day.
  const waiting = scheduledPost("Waiting", ada.id, {
    mode: "queue",
    queuePosition: 1,
  });
  const draft = scheduledPost("Draft", ada.id, { status: "draft", mode: null });
  const sent = scheduledPost("Sent", ada.id, { status: "sent" });
  sent.target = { ...sent.target, status: "sent", queuedAt: 400, sentAt: 500 };
  const failed = scheduledPost("Failed", ada.id, { status: "error" });
  failed.target = { ...failed.target, status: "error", queuedAt: 600 };
  const tables = tablesOf({
    channel: [ada],
    ...tablesWith(chosen, queued, held, waiting, draft, sent, failed),
  });

  expect(
    selectCalendar(tables).map(({ title, kind, time }) => [title, kind, time]),
  ).toEqual([
    // At the time it was sent, and not asked for.
    ["Sent", "sent", 500],
    ["Failed", "failed", 600],
    ["Held", "held", 1000],
    ["Queued", "queued", 2000],
    ["Chosen", "scheduled", 3000],
  ]);
});

it("puts a post of the calendar on its day in the zone of the workspace", () => {
  const entry = {
    id: id(),
    // Half past midnight on 6 January in Rome, still the 5th in UTC.
    time: at("2026-01-05T23:30:00Z"),
    kind: "scheduled" as const,
    title: "Late",
  };

  expect([...entriesByDay([entry], rome).keys()]).toEqual(["2026-01-06"]);
  expect([...entriesByDay([entry], "UTC").keys()]).toEqual(["2026-01-05"]);
});
