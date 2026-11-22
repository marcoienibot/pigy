import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { MutationRejected, type RejectionCode } from "./mutators.ts";
import { lateMs, settingsId } from "./tables.ts";

/**
 * The mutators that say when a post goes out: a time that somebody chose,
 * the queue with its slots, and what the server does when a time has come.
 */

type Workspace = ReturnType<typeof memoryWorkspace>;

const id = (number: number) =>
  `01932c07-0000-7000-8000-${number.toString().padStart(12, "0")}`;
const channelId = id(900);
const otherChannelId = id(901);

const at = (iso: string) => Date.parse(iso);
const iso = (time: number | null | undefined) =>
  time == null ? null : new Date(time).toISOString();

const monday = 1;
const wednesday = 3;

// Monday 5 January 2026, 08:00 in Rome, an hour before the first slot.
const start = at("2026-01-05T07:00:00Z");

function rejectionOf(run: () => void): RejectionCode {
  try {
    run();
  } catch (error) {
    if (error instanceof MutationRejected) return error.code;
    throw error;
  }
  throw new Error("The mutation was not rejected");
}

function connect(workspace: Workspace, channel = channelId, accountId = "1") {
  workspace.mutate(
    "channel.connect",
    {
      id: channel,
      network: "mastodon",
      accountId,
      handle: `@${accountId}@mastodon.example`,
      name: "Ada",
      avatarUrl: null,
      profileUrl: null,
      expiresAt: null,
      limits: null,
    },
    1000,
    "server",
  );
}

/** A draft that goes to the channel, numbered `number`. */
function draft(workspace: Workspace, number: number, now = start) {
  const postId = id(number);
  workspace.mutate(
    "post.create",
    { id: postId, partId: id(100 + number), text: `Post ${number}` },
    now,
  );
  workspace.mutate(
    "target.add",
    { id: id(200 + number), postId, channelId },
    now,
  );
  return postId;
}

/**
 * A workspace in Rome with a channel and two slots: Monday and Wednesday
 * at 09:00.
 */
function scheduled() {
  const workspace = memoryWorkspace();
  connect(workspace);
  workspace.mutate("settings.setTimeZone", { timeZone: "Europe/Rome" }, start);
  workspace.mutate(
    "slot.add",
    { id: id(301), weekday: monday, minute: 9 * 60 },
    start,
  );
  workspace.mutate(
    "slot.add",
    { id: id(302), weekday: wednesday, minute: 9 * 60 },
    start,
  );
  return workspace;
}

const postOf = (workspace: Workspace, postId: string) => {
  const post = workspace.rows("post").find((row) => row.id === postId);
  if (!post) throw new Error("There is no such post");
  return post;
};

/** The queue as a person reads it: each post and its time, in order. */
const queueOf = (workspace: Workspace) =>
  workspace
    .rows("post")
    .filter((post) => post.queuePosition !== null)
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
    .map((post) => [post.id, iso(post.dueAt)]);

const firstMonday = "2026-01-05T08:00:00.000Z";
const firstWednesday = "2026-01-07T08:00:00.000Z";
const secondMonday = "2026-01-12T08:00:00.000Z";
const secondWednesday = "2026-01-14T08:00:00.000Z";

it("schedules a draft for a time: it is scheduled, and its targets stay as they were chosen", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = at("2026-02-01T10:00:00Z");

  workspace.mutate("post.schedule", { id: post, dueAt }, start + 5);

  expect(postOf(workspace, post)).toEqual({
    id: post,
    status: "scheduled",
    createdAt: start,
    updatedAt: start + 5,
    mode: "custom",
    dueAt,
    queuePosition: null,
    heldAt: null,
  });
  // `scheduled` is a status of the post alone.
  expect(workspace.rows("post_target").map(({ status }) => status)).toEqual([
    "pending",
  ]);
});

it("refuses to schedule or queue a post that goes nowhere", () => {
  const workspace = scheduled();
  const post = id(1);
  workspace.mutate("post.create", { id: post, partId: id(101), text: "Hi" });

  expect(
    rejectionOf(() =>
      workspace.mutate("post.schedule", { id: post, dueAt: start }),
    ),
  ).toBe("no_channels");
  expect(
    rejectionOf(() =>
      workspace.mutate("post.enqueue", { id: post, first: false }),
    ),
  ).toBe("no_channels");
  expect(postOf(workspace, post).status).toBe("draft");
});

it("takes a time that has passed: a device can schedule without a connection", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);

  workspace.mutate("post.schedule", { id: post, dueAt: start - 5000 }, start);

  expect(postOf(workspace, post)).toMatchObject({
    status: "scheduled",
    dueAt: start - 5000,
  });
});

it("gives a scheduled post another time", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);

  workspace.mutate("post.schedule", { id: post, dueAt: start + 9000 }, start);

  expect(postOf(workspace, post)).toMatchObject({
    status: "scheduled",
    mode: "custom",
    dueAt: start + 9000,
  });
});

it.each(["part.setText", "part.add", "target.add", "target.remove"] as const)(
  "refuses %s for a scheduled post: only a draft is edited",
  (name) => {
    const workspace = scheduled();
    connect(workspace, otherChannelId, "2");
    const post = draft(workspace, 1);
    workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);
    const args = {
      "part.setText": { id: id(101), text: "Changed" },
      "part.add": {
        id: id(150),
        postId: post,
        channelId: null,
        afterId: null,
        text: "More",
      },
      "target.add": { id: id(250), postId: post, channelId: otherChannelId },
      "target.remove": { postId: post, channelId },
    }[name];

    expect(rejectionOf(() => workspace.mutate(name, args))).toBe("not_a_draft");
  },
);

it("takes a scheduled post back to the drafts, where it can be edited again", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);

  workspace.mutate("post.unschedule", { id: post }, start + 7);

  expect(postOf(workspace, post)).toMatchObject({
    status: "draft",
    mode: null,
    dueAt: null,
    queuePosition: null,
    updatedAt: start + 7,
  });
  workspace.mutate("part.setText", { id: id(101), text: "Changed" });
  // A second device that takes it back too is not told off.
  workspace.mutate("post.unschedule", { id: post });
});

it("refuses to take back a post that has gone out", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.publish", { id: post }, start);

  expect(
    rejectionOf(() => workspace.mutate("post.unschedule", { id: post })),
  ).toBe("not_scheduled");
  expect(
    rejectionOf(() =>
      workspace.mutate("post.schedule", { id: post, dueAt: start }),
    ),
  ).toBe("not_a_draft");
  expect(
    rejectionOf(() =>
      workspace.mutate("post.enqueue", { id: post, first: true }),
    ),
  ).toBe("not_a_draft");
});

it("sends a scheduled post now when somebody asks, without what said when", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 9000 }, start);

  workspace.mutate("post.publish", { id: post }, start + 10);

  expect(postOf(workspace, post)).toMatchObject({
    status: "sending",
    mode: null,
    dueAt: null,
  });
  expect(workspace.rows("post_target")).toMatchObject([
    { status: "queued", queuedAt: start + 10 },
  ]);
});

it("gives the posts of the queue the slots after now, one each, in the order they were added", () => {
  const workspace = scheduled();
  const posts = [1, 2, 3].map((number) => draft(workspace, number));

  for (const post of posts) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }

  expect(queueOf(workspace)).toEqual([
    [posts[0], firstMonday],
    [posts[1], firstWednesday],
    [posts[2], secondMonday],
  ]);
  expect(postOf(workspace, posts[0] ?? "")).toMatchObject({
    status: "scheduled",
    mode: "queue",
  });
});

it("skips a slot whose time has passed when a post is added to the queue", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);

  // Monday 09:00 in Rome exactly: that slot is not after now.
  workspace.mutate("post.enqueue", { id: post, first: false }, at(firstMonday));

  expect(queueOf(workspace)).toEqual([[post, firstWednesday]]);
});

it("puts a post that is shared next at the front, and moves the others back by one slot", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = ""] = [1, 2, 3].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  workspace.mutate("post.enqueue", { id: c, first: true }, start);

  expect(queueOf(workspace)).toEqual([
    [c, firstMonday],
    [a, firstWednesday],
    [b, secondMonday],
  ]);
});

it("leaves a post where it is in the queue when it is added again, and moves it to the front when it is shared next", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  expect(queueOf(workspace).map(([post]) => post)).toEqual([a, b]);

  workspace.mutate("post.enqueue", { id: b, first: true }, start);
  expect(queueOf(workspace)).toEqual([
    [b, firstMonday],
    [a, firstWednesday],
  ]);
});

it("moves a post within the queue, and the posts take the slots in the new order", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = ""] = [1, 2, 3].map((n) => draft(workspace, n));
  for (const post of [a, b, c]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }

  workspace.mutate("post.move", { id: a, afterId: c }, start);
  expect(queueOf(workspace)).toEqual([
    [b, firstMonday],
    [c, firstWednesday],
    [a, secondMonday],
  ]);

  workspace.mutate("post.move", { id: a, afterId: null }, start);
  expect(queueOf(workspace).map(([post]) => post)).toEqual([a, b, c]);
});

it("leaves one order behind when two devices reorder the queue at once", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = "", d = ""] = [1, 2, 3, 4].map((n) =>
    draft(workspace, n),
  );
  for (const post of [a, b, c, d]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }

  // Both saw a, b, c, d. One moves d to the front, the other moves a to
  // after b. The mutations name posts, not places, so both hold whichever
  // comes first, and every post has one place and one slot.
  workspace.mutate("post.move", { id: d, afterId: null }, start);
  workspace.mutate("post.move", { id: a, afterId: b }, start);

  expect(queueOf(workspace)).toEqual([
    [d, firstMonday],
    [b, firstWednesday],
    [a, secondMonday],
    [c, secondWednesday],
  ]);
  expect(
    workspace
      .rows("post")
      .map(({ queuePosition }) => queuePosition)
      .sort(),
  ).toEqual([0, 1, 2, 3]);
});

it("leaves a post where it is when the post to go after has left the queue", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = ""] = [1, 2, 3].map((n) => draft(workspace, n));
  for (const post of [a, b, c]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  workspace.mutate("post.unschedule", { id: c }, start);

  workspace.mutate("post.move", { id: a, afterId: c }, start);

  expect(queueOf(workspace).map(([post]) => post)).toEqual([a, b]);
});

it("refuses to move a post that is not in the queue", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);

  expect(
    rejectionOf(() =>
      workspace.mutate("post.move", { id: post, afterId: null }),
    ),
  ).toBe("not_scheduled");
  expect(
    rejectionOf(() =>
      workspace.mutate("post.move", { id: id(77), afterId: null }),
    ),
  ).toBe("not_found");
});

it.each([
  ["taken back to the drafts", "post.unschedule", {}],
  ["deleted", "post.delete", {}],
  ["sent now", "post.publish", {}],
  ["given a time of its own", "post.schedule", { dueAt: start + 1000 }],
] as const)("closes the queue up behind a post that is %s", (_, name, args) => {
  const workspace = scheduled();
  const [a = "", b = "", c = ""] = [1, 2, 3].map((n) => draft(workspace, n));
  for (const post of [a, b, c]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }

  workspace.mutate(name, { id: a, ...args }, start);

  expect(queueOf(workspace)).toEqual([
    [b, firstMonday],
    [c, firstWednesday],
  ]);
});

it("moves a post from a time of its own into the queue", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);

  workspace.mutate("post.enqueue", { id: post, first: false }, start);

  expect(postOf(workspace, post)).toMatchObject({
    mode: "queue",
    queuePosition: 0,
  });
  expect(queueOf(workspace)).toEqual([[post, firstMonday]]);
});

it("gives a queued post no time while the workspace has no slot, and one when a slot is added", () => {
  const workspace = memoryWorkspace();
  connect(workspace);
  const post = draft(workspace, 1);

  workspace.mutate("post.enqueue", { id: post, first: false }, start);
  expect(queueOf(workspace)).toEqual([[post, null]]);

  // No time zone is set: the slot is in UTC.
  workspace.mutate(
    "slot.add",
    { id: id(301), weekday: monday, minute: 9 * 60 },
    start,
  );
  expect(queueOf(workspace)).toEqual([[post, "2026-01-05T09:00:00.000Z"]]);
});

it("moves the queued posts to the slots that are left when one is removed, and takes their times when none is", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  // Monday goes: Wednesdays are left.
  workspace.mutate("slot.remove", { id: id(301) }, start);
  expect(queueOf(workspace)).toEqual([
    [a, firstWednesday],
    [b, secondWednesday],
  ]);

  workspace.mutate("slot.remove", { id: id(302) }, start);
  expect(queueOf(workspace)).toEqual([
    [a, null],
    [b, null],
  ]);
  // Removing a slot that is gone is nothing to tell anybody.
  workspace.mutate("slot.remove", { id: id(302) }, start);
});

it("adds a slot once: a second one at the same time of the week changes nothing", () => {
  const workspace = scheduled();

  workspace.mutate(
    "slot.add",
    { id: id(399), weekday: monday, minute: 9 * 60 },
    start,
  );

  expect(workspace.rows("schedule_slot").map(({ id: slot }) => slot)).toEqual([
    id(301),
    id(302),
  ]);
});

it("refuses a slot at a time that no day has", () => {
  const workspace = scheduled();

  expect(
    rejectionOf(() =>
      workspace.mutate("slot.add", { id: id(399), weekday: 7, minute: 0 }),
    ),
  ).toBe("invalid_arguments");
  expect(
    rejectionOf(() =>
      workspace.mutate("slot.add", { id: id(399), weekday: 1, minute: 1440 }),
    ),
  ).toBe("invalid_arguments");
});

it("moves the queued posts to the slots as they are in another time zone", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.enqueue", { id: post, first: false }, start);

  // 09:00 on Monday in New York is six hours after 09:00 in Rome.
  workspace.mutate(
    "settings.setTimeZone",
    { timeZone: "America/New_York" },
    start,
  );

  expect(queueOf(workspace)).toEqual([[post, "2026-01-05T14:00:00.000Z"]]);
  expect(workspace.rows("settings")).toEqual([
    { id: settingsId, timeZone: "America/New_York", queuePaused: false },
  ]);
});

it("sets the time zone of a device only for a workspace that has none", () => {
  const workspace = memoryWorkspace();
  const ifUnset = (timeZone: string) =>
    workspace.mutate("settings.setTimeZone", { timeZone, onlyIfUnset: true });

  ifUnset("Europe/Rome");
  ifUnset("Asia/Tokyo");

  expect(workspace.rows("settings")).toMatchObject([
    { timeZone: "Europe/Rome" },
  ]);
});

it("refuses a time zone that it does not know", () => {
  const workspace = memoryWorkspace();

  expect(
    rejectionOf(() =>
      workspace.mutate("settings.setTimeZone", { timeZone: "Mars/Olympus" }),
    ),
  ).toBe("invalid_arguments");
  expect(workspace.rows("settings")).toEqual([]);
});

it("takes the times of the queued posts while the queue is paused, and gives them the slots after the pause when it goes on", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);
  const exact = draft(workspace, 3);
  workspace.mutate("post.schedule", { id: exact, dueAt: start + 1000 }, start);

  workspace.mutate("queue.setPaused", { paused: true }, start);

  expect(queueOf(workspace)).toEqual([
    [a, null],
    [b, null],
  ]);
  // A post with a time that somebody chose is not of the queue.
  expect(postOf(workspace, exact).dueAt).toBe(start + 1000);

  // A post that is added meanwhile waits like the others.
  const c = draft(workspace, 4);
  workspace.mutate("post.enqueue", { id: c, first: false }, start);
  expect(queueOf(workspace).at(-1)).toEqual([c, null]);

  // On Tuesday the queue goes on: the Monday slot passed and was not
  // used, and the posts take the slots from Wednesday on.
  workspace.mutate(
    "queue.setPaused",
    { paused: false },
    at("2026-01-06T12:00:00Z"),
  );
  expect(queueOf(workspace)).toEqual([
    [a, firstWednesday],
    [b, secondMonday],
    [c, secondWednesday],
  ]);
});

it("keeps the time of a queued post that is due when the queue changes behind it", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);

  // A moment after the slot of the first post, before the server has
  // taken it up, another is added: the first is as good as gone, and is
  // not moved to a later slot.
  workspace.mutate(
    "post.enqueue",
    { id: b, first: false },
    at(firstMonday) + 500,
  );

  expect(queueOf(workspace)).toEqual([
    [a, firstMonday],
    [b, firstWednesday],
  ]);
});

const due = (workspace: Workspace, post: string, now: number) =>
  workspace.mutate("post.due", { id: post }, now, "server");

it("sends a post whose time has come, and keeps what said when", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start);

  due(workspace, post, dueAt);

  expect(postOf(workspace, post)).toMatchObject({
    status: "sending",
    mode: "custom",
    dueAt,
    heldAt: null,
  });
  expect(workspace.rows("post_target")).toMatchObject([
    { status: "queued", queuedAt: dueAt },
  ]);
});

it("is the server's alone, and only for a post whose time has come", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);

  expect(
    rejectionOf(() =>
      workspace.mutate("post.due", { id: post }, start + 1000, "client"),
    ),
  ).toBe("not_allowed");
  // A millisecond early.
  expect(rejectionOf(() => due(workspace, post, start + 999))).toBe(
    "not_current",
  );
  expect(postOf(workspace, post).status).toBe("scheduled");
});

it("sends a post that is an hour late, and holds one that is later", () => {
  const workspace = scheduled();
  const [onTime = "", late = ""] = [1, 2].map((n) => draft(workspace, n));
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: onTime, dueAt }, start);
  workspace.mutate("post.schedule", { id: late, dueAt }, start);

  due(workspace, onTime, dueAt + lateMs);
  due(workspace, late, dueAt + lateMs + 1);

  expect(postOf(workspace, onTime).status).toBe("sending");
  // Held: still scheduled, with the time that it missed, and nothing was
  // asked of its targets.
  expect(postOf(workspace, late)).toMatchObject({
    status: "scheduled",
    dueAt,
    heldAt: dueAt + lateMs + 1,
  });
  expect(
    workspace.rows("post_target").find(({ postId }) => postId === late)?.status,
  ).toBe("pending");
  // It is not due a second time.
  expect(rejectionOf(() => due(workspace, late, dueAt + lateMs + 2))).toBe(
    "not_current",
  );
});

it.each([
  ["given another time", "post.schedule", { dueAt: start + 9 * lateMs }],
  ["put into the queue", "post.enqueue", { first: false }],
  ["taken back to the drafts", "post.unschedule", {}],
] as const)("is held no more once a held post is %s", (_, name, args) => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start }, start);
  due(workspace, post, start + 2 * lateMs);
  expect(postOf(workspace, post).heldAt).not.toBeNull();

  workspace.mutate(name, { id: post, ...args }, start + 3 * lateMs);

  expect(postOf(workspace, post).heldAt).toBeNull();
});

it("sends a queued post at its slot, and the others keep theirs", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  due(workspace, a, at(firstMonday));

  expect(postOf(workspace, a)).toMatchObject({
    status: "sending",
    mode: "queue",
    dueAt: at(firstMonday),
    queuePosition: null,
  });
  expect(queueOf(workspace)).toEqual([[b, firstWednesday]]);
});

it("gives a queued post that is found too late the next slot, and keeps the order of the queue", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  // The server was away from before Monday's slot until Thursday: both
  // slots of the week have passed.
  const thursday = at("2026-01-08T12:00:00Z");
  due(workspace, a, thursday);
  due(workspace, b, thursday);

  expect(queueOf(workspace)).toEqual([
    [a, secondMonday],
    [b, secondWednesday],
  ]);
  expect(postOf(workspace, a)).toMatchObject({
    status: "scheduled",
    heldAt: null,
  });
});

it("takes a disconnected account off a scheduled post, and makes a draft of one that has no other", () => {
  const workspace = scheduled();
  connect(workspace, otherChannelId, "2");
  const [both = "", one = "", queued = ""] = [1, 2, 3].map((n) =>
    draft(workspace, n),
  );
  workspace.mutate("target.add", {
    id: id(260),
    postId: both,
    channelId: otherChannelId,
  });
  workspace.mutate("post.schedule", { id: both, dueAt: start + 1000 }, start);
  workspace.mutate("post.schedule", { id: one, dueAt: start + 1000 }, start);
  workspace.mutate("post.enqueue", { id: queued, first: false }, start);

  workspace.mutate("channel.disconnect", { id: channelId }, start, "server");

  // The post that has another account goes there when its time comes.
  expect(postOf(workspace, both).status).toBe("scheduled");
  expect(
    workspace
      .rows("post_target")
      .map(({ postId, channelId: channel }) => [postId, channel]),
  ).toEqual([[both, otherChannelId]]);
  // The others have nowhere to go: they are drafts, out of the queue.
  expect(postOf(workspace, one)).toMatchObject({
    status: "draft",
    dueAt: null,
  });
  expect(postOf(workspace, queued)).toMatchObject({
    status: "draft",
    mode: null,
    queuePosition: null,
  });
});
