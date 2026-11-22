import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { MutationRejected, type RejectionCode, requeues } from "./mutators.ts";
import { lateMs, maxScheduled, settingsId } from "./tables.ts";

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
    trashedAt: null,
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

it("takes a time that has passed, and takes the post up at once: a device can schedule without a connection", () => {
  const workspace = scheduled();
  const [recent = "", old = ""] = [1, 2].map((n) => draft(workspace, n));

  workspace.mutate("post.schedule", { id: recent, dueAt: start - 5000 }, start);
  workspace.mutate(
    "post.schedule",
    { id: old, dueAt: start - lateMs - 1 },
    start,
  );

  // What `post.due` would do with them, done by the mutation itself: no
  // mutation after it finds a post that is scheduled for the past.
  expect(postOf(workspace, recent)).toMatchObject({
    status: "sending",
    mode: "custom",
    dueAt: start - 5000,
  });
  expect(postOf(workspace, old)).toMatchObject({
    status: "scheduled",
    dueAt: start - lateMs - 1,
    heldAt: start,
    trashedAt: null,
  });
  // So taking the first back is refused, whether it comes in the same
  // message as the scheduling or in the next.
  expect(
    rejectionOf(() =>
      workspace.mutate("post.unschedule", { id: recent }, start),
    ),
  ).toBe("not_scheduled");
});

/** Ends the delivery of a post that was taken up: it is sent. */
function deliver(workspace: Workspace, postId: string) {
  for (const target of workspace.rows("post_target")) {
    if (target.postId === postId) {
      workspace.put("post_target", { ...target, status: "sent" });
    }
  }
  workspace.put("post", { ...postOf(workspace, postId), status: "sent" });
}

/** How many deliveries have been asked for: each is a post on a network. */
const asked = (workspace: Workspace) =>
  workspace.rows("post_target").filter(({ queuedAt }) => queuedAt !== null)
    .length;

it("puts a scheduled post aside: it is not due, has no place in the queue, and counts for nothing", () => {
  const workspace = scheduled();
  const [timed = "", queued = "", behind = ""] = [1, 2, 3].map((n) =>
    draft(workspace, n),
  );
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: timed, dueAt }, start);
  workspace.mutate("post.enqueue", { id: queued, first: false }, start);
  workspace.mutate("post.enqueue", { id: behind, first: false }, start);
  expect(queueOf(workspace)).toEqual([
    [queued, firstMonday],
    [behind, firstWednesday],
  ]);

  workspace.mutate("post.trash", { id: timed }, start + 10);
  workspace.mutate("post.trash", { id: queued }, start + 20);

  // Its row stays, with what says when it was to go out, for the Undo.
  expect(postOf(workspace, timed)).toMatchObject({
    status: "scheduled",
    mode: "custom",
    dueAt,
    trashedAt: start + 10,
  });
  // The queue has closed up behind the other: the post behind it has
  // its slot, and the one that was put aside has no time.
  expect(postOf(workspace, queued)).toMatchObject({
    mode: "queue",
    dueAt: null,
    trashedAt: start + 20,
  });
  expect(postOf(workspace, behind).dueAt).toBe(at(firstMonday));
  // The server does not take it up when its time has come.
  expect(
    rejectionOf(() =>
      workspace.mutate("post.due", { id: timed }, dueAt, "server"),
    ),
  ).toBe("not_current");
  // It is gone for every other mutator, as a deleted post is.
  for (const run of [
    () => workspace.mutate("post.publish", { id: timed }),
    () => workspace.mutate("post.schedule", { id: timed, dueAt }),
    () => workspace.mutate("post.enqueue", { id: timed, first: true }),
    () => workspace.mutate("post.move", { id: queued, afterId: null }),
    () => workspace.mutate("post.unschedule", { id: timed }),
  ]) {
    expect(rejectionOf(run)).toBe("not_found");
  }
  // Putting it aside again changes nothing: two devices can delete it.
  workspace.mutate("post.trash", { id: timed }, start + 500);
  expect(postOf(workspace, timed).trashedAt).toBe(start + 10);
  expect(asked(workspace)).toBe(0);
});

it("puts aside only a post that is scheduled, and says what the post is instead", () => {
  const workspace = scheduled();
  const [went = "", back = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.schedule", { id: went, dueAt: start + 1000 }, start);
  workspace.mutate("post.due", { id: went }, start + 1000, "server");
  deliver(workspace, went);

  // From the Queue screen of a device that has not heard that the post
  // went out, or that somebody took it back to the drafts: it stays, on
  // the Sent screen and in the drafts of every other.
  const refusal = (postId: string) => {
    try {
      workspace.mutate("post.trash", { id: postId });
    } catch (error) {
      if (error instanceof MutationRejected) return [error.code, error.message];
      throw error;
    }
    return undefined;
  };
  expect(refusal(went)).toEqual([
    "not_scheduled",
    "This post has gone out already",
  ]);
  expect(refusal(back)).toEqual([
    "not_scheduled",
    "This post is back in the drafts: somebody took it back",
  ]);
  expect(postOf(workspace, went).trashedAt).toBeNull();
  // A post that is gone is no error.
  workspace.mutate("post.trash", { id: id(77) });
});

it("restores a post that was put aside as it was: its time, or its place in the queue", () => {
  const workspace = scheduled();
  const [timed = "", first = "", second = "", third = ""] = [1, 2, 3, 4].map(
    (n) => draft(workspace, n),
  );
  const dueAt = start + 5000;
  workspace.mutate("post.schedule", { id: timed, dueAt }, start);
  for (const post of [first, second, third]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  workspace.mutate("post.trash", { id: timed }, start + 10);
  workspace.mutate("post.trash", { id: second }, start + 10);
  expect(queueOf(workspace).filter(([, time]) => time)).toEqual([
    [first, firstMonday],
    [third, firstWednesday],
  ]);

  workspace.mutate("post.restore", { id: timed }, start + 20);
  workspace.mutate("post.restore", { id: second }, start + 20);

  expect(postOf(workspace, timed)).toMatchObject({
    status: "scheduled",
    mode: "custom",
    dueAt,
    trashedAt: null,
  });
  // Between the two that it was between, each with the slot of its place.
  expect(queueOf(workspace)).toEqual([
    [first, firstMonday],
    [second, firstWednesday],
    [third, secondMonday],
  ]);
  // A second Undo, of another device, finds nothing to take back.
  const before = workspace.rows("post");
  workspace.mutate("post.restore", { id: timed }, start + 30);
  workspace.mutate("post.restore", { id: id(77) }, start + 30);
  expect(workspace.rows("post")).toEqual(before);
});

it("takes a restored post up as scheduling would when its time has passed, and makes a draft of one that has no account or no room", () => {
  const workspace = scheduled();
  const [recent = "", old = "", alone = "", crowded = ""] = [1, 2, 3, 4].map(
    (n) => draft(workspace, n),
  );
  // The third goes to an account of its own.
  connect(workspace, otherChannelId, "2");
  workspace.mutate("target.remove", { postId: alone, channelId }, start);
  workspace.mutate(
    "target.add",
    { id: id(250), postId: alone, channelId: otherChannelId },
    start,
  );
  for (const post of [recent, old, alone, crowded]) {
    workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);
    workspace.mutate("post.trash", { id: post }, start + 10);
  }
  // The account of the third is disconnected meanwhile.
  workspace.mutate(
    "channel.disconnect",
    { id: otherChannelId },
    start + 20,
    "server",
  );

  workspace.mutate("post.restore", { id: recent }, start + 2000);
  workspace.mutate("post.restore", { id: old }, start + 1000 + lateMs + 1);
  workspace.mutate("post.restore", { id: alone }, start + 2000);

  expect(postOf(workspace, recent).status).toBe("sending");
  expect(postOf(workspace, old)).toMatchObject({
    status: "scheduled",
    heldAt: start + 1000 + lateMs + 1,
    trashedAt: null,
  });
  expect(postOf(workspace, alone)).toMatchObject({
    status: "draft",
    mode: null,
    dueAt: null,
    trashedAt: null,
  });

  // As many posts are scheduled as a workspace can have: the post that
  // was put aside made room for the last of them, and has none itself.
  const have = workspace
    .rows("post")
    .filter((post) => post.status === "scheduled" && post.trashedAt === null);
  for (let number = have.length; number < maxScheduled; number += 1) {
    workspace.put("post", {
      ...postOf(workspace, old),
      id: id(1000 + number),
    });
  }
  workspace.mutate("post.restore", { id: crowded }, start + 3000);
  expect(postOf(workspace, crowded).status).toBe("draft");
});

it("does not count a post that was put aside among the scheduled posts of a workspace", () => {
  const workspace = scheduled();
  const [aside = "", post = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.schedule", { id: aside, dueAt: start + 1000 }, start);
  for (let number = 1; number < maxScheduled; number += 1) {
    workspace.put("post", {
      ...postOf(workspace, aside),
      id: id(1000 + number),
    });
  }
  expect(
    rejectionOf(() =>
      workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }),
    ),
  ).toBe("too_many_scheduled");

  workspace.mutate("post.trash", { id: aside }, start);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);
  expect(postOf(workspace, post).status).toBe("scheduled");
});

it("deletes for good only a post that was put aside, with the texts of its accounts", () => {
  const workspace = scheduled();
  const [aside = "", waits = "", went = ""] = [1, 2, 3].map((n) =>
    draft(workspace, n),
  );
  workspace.mutate("target.customize", {
    postId: aside,
    channelId,
    parts: [{ id: id(501), text: "For Ada" }],
  });
  for (const post of [aside, waits, went]) {
    workspace.mutate("post.schedule", { id: post, dueAt: start + 1000 }, start);
  }
  workspace.mutate("post.trash", { id: aside }, start + 10);
  // The text of its account has stayed with it, for the Undo.
  expect(
    workspace.rows("post_part").filter(({ postId }) => postId === aside),
  ).toHaveLength(2);
  workspace.mutate("post.due", { id: went }, start + 1000, "server");
  deliver(workspace, went);

  // The second step of a deletion whose first was refused, or undone,
  // or never made: nothing is deleted.
  workspace.mutate("post.delete", { id: waits, ifTrashed: true });
  workspace.mutate("post.delete", { id: went, ifTrashed: true });
  workspace.mutate("post.delete", { id: id(77), ifTrashed: true });
  expect(workspace.rows("post").map(({ id }) => id)).toEqual([
    aside,
    waits,
    went,
  ]);

  workspace.mutate("post.delete", { id: aside, ifTrashed: true });
  expect(workspace.rows("post").map(({ id }) => id)).toEqual([waits, went]);
  expect(
    workspace.rows("post_part").filter(({ postId }) => postId === aside),
  ).toEqual([]);
  expect(
    workspace.rows("post_target").filter(({ postId }) => postId === aside),
  ).toEqual([]);
});

// The two orders in which an Undo once published a post twice, when it
// made a copy of the deleted post and scheduled that. What a device does
// without a connection reaches the server later, in the order it was
// done, after whatever the server and the other devices did meanwhile.

it("publishes a post once when its delete and its Undo arrive after it went out and its record was deleted", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start);

  // The phone has deleted the post and pressed Undo, without a
  // connection. Meanwhile the server publishes the post at its time,
  // and another device deletes its record from Sent.
  workspace.mutate("post.due", { id: post }, dueAt, "server");
  expect(asked(workspace)).toBe(1);
  deliver(workspace, post);
  workspace.mutate("post.delete", { id: post }, dueAt + 10);

  // The phone is back. Nothing of the post is there for its three steps
  // to be about, and none of them makes a post.
  workspace.mutate("post.trash", { id: post }, dueAt + 20);
  workspace.mutate("post.restore", { id: post }, dueAt + 21);
  workspace.mutate("post.delete", { id: post, ifTrashed: true }, dueAt + 22);

  expect(workspace.rows("post")).toEqual([]);
  expect(workspace.rows("post_target")).toEqual([]);
});

it("leaves one post when two devices delete the same scheduled post and both press Undo", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = start + 60_000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start);

  // Each without a connection, so each arrives as a whole.
  for (const arrives of [start + 100, start + 200]) {
    workspace.mutate("post.trash", { id: post }, arrives);
    workspace.mutate("post.restore", { id: post }, arrives + 1);
  }

  expect(workspace.rows("post")).toMatchObject([
    { id: post, status: "scheduled", dueAt, trashedAt: null },
  ]);
  workspace.mutate("post.due", { id: post }, dueAt, "server");
  expect(asked(workspace)).toBe(1);
});

it("keeps a post deleted that one device deleted for good, whatever the Undo of another says afterwards", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  workspace.mutate("post.schedule", { id: post, dueAt: start + 60_000 }, start);

  // One device deletes the post and lets its Undo pass. The other had
  // deleted it too, and pressed Undo, and is heard of last.
  workspace.mutate("post.trash", { id: post }, start + 100);
  workspace.mutate("post.delete", { id: post, ifTrashed: true }, start + 200);
  workspace.mutate("post.trash", { id: post }, start + 300);
  workspace.mutate("post.restore", { id: post }, start + 301);

  expect(workspace.rows("post")).toEqual([]);
});

it("keeps a scheduled post that lost its only account put aside, and gone from the queue of nobody", () => {
  const workspace = scheduled();
  const [aside = "", queued = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: aside, first: false }, start);
  workspace.mutate("post.enqueue", { id: queued, first: false }, start);
  workspace.mutate("post.trash", { id: aside }, start + 10);

  workspace.mutate(
    "channel.disconnect",
    { id: channelId },
    start + 20,
    "server",
  );

  // The one that was not put aside is a draft again, as before. The
  // other does not come back among the drafts by a disconnect: it is
  // deleted but for its Undo.
  expect(postOf(workspace, queued).status).toBe("draft");
  expect(postOf(workspace, aside)).toMatchObject({
    status: "scheduled",
    trashedAt: start + 10,
  });
});

it("schedules no more posts than a workspace can have", () => {
  const workspace = scheduled();
  const [has = "", post = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.schedule", { id: has, dueAt: start + 1000 }, start);
  for (let number = 1; number < maxScheduled; number += 1) {
    // Without a mutator, which would take as long for each as the test
    // has for all of them: the test is about the one that is refused.
    workspace.put("post", {
      id: id(1000 + number),
      status: "scheduled",
      createdAt: start,
      updatedAt: start,
      mode: "custom",
      dueAt: start + lateMs,
      queuePosition: null,
      heldAt: null,
      trashedAt: null,
    });
  }

  expect(
    rejectionOf(() =>
      workspace.mutate(
        "post.schedule",
        { id: post, dueAt: start + 1000 },
        start,
      ),
    ),
  ).toBe("too_many_scheduled");
  expect(
    rejectionOf(() =>
      workspace.mutate("post.enqueue", { id: post, first: false }, start),
    ),
  ).toBe("too_many_scheduled");
  // One that is scheduled already is given another time all the same.
  workspace.mutate("post.schedule", { id: has, dueAt: start + 2000 }, start);
  expect(postOf(workspace, has).dueAt).toBe(start + 2000);
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
  // Each has a place of its own. The places say the order and nothing
  // else: numbers can be left out.
  const places = workspace.rows("post").map((post) => post.queuePosition);
  expect(new Set(places).size).toBe(4);
});

it("changes no other post when a post enters the queue at either end or leaves it", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = "", d = ""] = [1, 2, 3, 4].map((n) =>
    draft(workspace, n),
  );
  workspace.mutate("queue.setPaused", { paused: true }, start);
  for (const post of [a, b]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  // The rows that a mutation wrote: a row that it left alone is the same
  // object after it. The queue is paused, so that no post changes its
  // time, which a post at the front would have the others do.
  const written = (mutate: () => void) => {
    const before = new Set<unknown>(workspace.rows("post"));
    mutate();
    return workspace
      .rows("post")
      .filter((row) => !before.has(row))
      .map(({ id }) => id);
  };

  expect(
    written(() =>
      workspace.mutate("post.enqueue", { id: c, first: false }, start),
    ),
  ).toEqual([c]);
  expect(
    written(() =>
      workspace.mutate("post.enqueue", { id: d, first: true }, start),
    ),
  ).toEqual([d]);
  expect(queueOf(workspace).map(([post]) => post)).toEqual([d, a, b, c]);
  expect(
    written(() => workspace.mutate("post.unschedule", { id: a }, start)),
  ).toEqual([a]);
  expect(queueOf(workspace).map(([post]) => post)).toEqual([d, b, c]);
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

it("stores a time zone under its one name, however a client wrote it", () => {
  const workspace = memoryWorkspace();

  workspace.mutate("settings.setTimeZone", { timeZone: "eUrOpE/rOmE" });

  // Not as it came: a device in Rome would be told that the times are
  // in another zone than its own, "eUrOpE/rOmE".
  expect(workspace.rows("settings")).toMatchObject([
    { timeZone: "Europe/Rome" },
  ]);
  // The same zone in another spelling is no change, and does not give
  // the posts of the queue their times anew.
  const before = requeues.count;
  workspace.mutate("settings.setTimeZone", { timeZone: "EUROPE/ROME" });
  expect(requeues.count).toBe(before);
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
    trashedAt: null,
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
    trashedAt: null,
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
  workspace.mutate("post.schedule", { id: post, dueAt: start + 1 }, start);
  due(workspace, post, start + 2 * lateMs);
  // Held, which is something that was done to the post: it says when.
  expect(postOf(workspace, post)).toMatchObject({
    heldAt: start + 2 * lateMs,
    trashedAt: null,
    updatedAt: start + 2 * lateMs,
  });

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

it("touches no other post of the queue when the first goes out at its slot", () => {
  const workspace = scheduled();
  const [a = "", b = "", c = ""] = [1, 2, 3].map((n) => draft(workspace, n));
  for (const post of [a, b, c]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  const before = new Set<unknown>(workspace.rows("post"));

  due(workspace, a, at(firstMonday));

  // A row that the mutation did not write is the same object after it:
  // the others keep their places, which leave out the one of the post
  // that went, and their times. So a client hears of one row.
  expect(
    workspace
      .rows("post")
      .filter((row) => !before.has(row))
      .map(({ id }) => id),
  ).toEqual([a]);
  expect(queueOf(workspace)).toEqual([
    [b, firstWednesday],
    [c, secondMonday],
  ]);
});

it("sends one post of the queue when the time of several has come, and gives the others the slots after now", () => {
  const workspace = scheduled();
  // Slots on Monday every quarter of an hour from 09:00 to 09:30, and at
  // 10:00 and 10:15, besides the one on Wednesday.
  [15, 30, 60, 75].forEach((later, index) => {
    workspace.mutate(
      "slot.add",
      { id: id(310 + index), weekday: monday, minute: 9 * 60 + later },
      start,
    );
  });
  const [a = "", b = "", c = "", d = ""] = [1, 2, 3, 4].map((n) =>
    draft(workspace, n),
  );
  for (const post of [a, b, c, d]) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  expect(queueOf(workspace).map(([, time]) => time)).toEqual([
    "2026-01-05T08:00:00.000Z",
    "2026-01-05T08:15:00.000Z",
    "2026-01-05T08:30:00.000Z",
    "2026-01-05T09:00:00.000Z",
  ]);

  // Nobody looked until 09:50: three posts are late, none by an hour.
  const late = at("2026-01-05T08:50:00Z");
  due(workspace, a, late);

  // The first goes out. The two behind it do not follow it at once, to
  // the same accounts: they take the slots after now, and the fourth
  // moves back behind them.
  expect(postOf(workspace, a).status).toBe("sending");
  expect(queueOf(workspace)).toEqual([
    [b, "2026-01-05T09:00:00.000Z"],
    [c, "2026-01-05T09:15:00.000Z"],
    [d, firstWednesday],
  ]);
  // They were given another time, which is something done to them.
  expect(postOf(workspace, b).updatedAt).toBe(late);
  expect(postOf(workspace, d).updatedAt).toBe(start);
  // And are not due any more.
  expect(rejectionOf(() => due(workspace, b, late))).toBe("not_current");
});

it("gives a queued post that is found too late the next slot, and keeps the order of the queue", () => {
  const workspace = scheduled();
  const [a = "", b = ""] = [1, 2].map((n) => draft(workspace, n));
  workspace.mutate("post.enqueue", { id: a, first: false }, start);
  workspace.mutate("post.enqueue", { id: b, first: false }, start);

  // The server was away from before Monday's slot until Thursday: both
  // slots of the week have passed.
  // Taking up the first gives every post of the queue that was due
  // another slot: one mutation, whichever of them it names.
  const thursday = at("2026-01-08T12:00:00Z");
  due(workspace, a, thursday);

  expect(queueOf(workspace)).toEqual([
    [a, secondMonday],
    [b, secondWednesday],
  ]);
  expect(postOf(workspace, a)).toMatchObject({
    status: "scheduled",
    heldAt: null,
    trashedAt: null,
    updatedAt: thursday,
  });
});

it("gives the posts of the queue their times once when an account is disconnected, however many leave the queue", () => {
  const workspace = scheduled();
  connect(workspace, otherChannelId, "2");
  const posts = Array.from({ length: 40 }, (_, index) =>
    draft(workspace, index + 1),
  );
  // One post goes to the other account too, and stays in the queue.
  const [stays = ""] = posts;
  workspace.mutate("target.add", {
    id: id(260),
    postId: stays,
    channelId: otherChannelId,
  });
  for (const post of posts) {
    workspace.mutate("post.enqueue", { id: post, first: false }, start);
  }
  const before = requeues.count;

  workspace.mutate("channel.disconnect", { id: channelId }, start, "server");

  // Once, and not once for each post that left: that is the difference
  // between a disconnect that takes a moment and one that does not end.
  expect(requeues.count - before).toBe(1);
  expect(queueOf(workspace)).toEqual([[stays, firstMonday]]);
  expect(
    workspace.rows("post").filter(({ status }) => status === "draft"),
  ).toHaveLength(39);
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

/** A post with a time that somebody chose, held since `heldAt`. */
function held(workspace: Workspace, number = 1) {
  const post = draft(workspace, number);
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start + 1);
  const heldAt = dueAt + lateMs + 1;
  due(workspace, post, heldAt);
  return { post, dueAt, heldAt };
}

it("tells in the inbox of a post that is held, and not of one that goes out late", () => {
  const workspace = scheduled();
  const onTime = draft(workspace, 2);
  workspace.mutate("post.schedule", { id: onTime, dueAt: start + 1000 }, start);
  due(workspace, onTime, start + 1000 + lateMs);
  // Sent an hour late: nothing for anybody to decide.
  expect(workspace.rows("notification")).toEqual([]);

  const { post, heldAt } = held(workspace);

  // Under the ID of the post, like what the inbox says of a post that
  // failed: a post is never both.
  expect(workspace.rows("notification")).toEqual([
    {
      id: post,
      kind: "post_held",
      postId: post,
      channelId: null,
      createdAt: heldAt,
      readAt: null,
    },
  ]);
});

it.each([
  ["sent now", "post.publish", {}],
  ["given another time", "post.schedule", { dueAt: start + 9 * lateMs }],
  ["put into the queue", "post.enqueue", { first: false }],
  ["taken back to the drafts", "post.unschedule", {}],
  ["put aside", "post.trash", {}],
  ["deleted", "post.delete", {}],
] as const)(
  "takes what the inbox says of a held post away when the post is %s",
  (_, name, args) => {
    const workspace = scheduled();
    const { post, heldAt } = held(workspace);
    // Another post is held too, and stays so: only the one that is
    // released loses its notification.
    const other = held(workspace, 2).post;

    workspace.mutate(name, { id: post, ...args }, heldAt + 1000);

    expect(workspace.rows("notification").map(({ id }) => id)).toEqual([other]);
  },
);

it("takes what the inbox says of a held post away when its only account is disconnected", () => {
  const workspace = scheduled();
  const { post, heldAt } = held(workspace);

  workspace.mutate(
    "channel.disconnect",
    { id: channelId },
    heldAt + 1,
    "server",
  );

  // The post is a draft again, with nothing to decide about its time.
  expect(postOf(workspace, post)).toMatchObject({
    status: "draft",
    heldAt: null,
  });
  expect(workspace.rows("notification")).toEqual([]);
});

it("tells anew of a held post that is given a time which is too late as well", () => {
  const workspace = scheduled();
  const { post, heldAt } = held(workspace);
  workspace.mutate(
    "notification.read",
    { notifications: [{ id: post, createdAt: heldAt }] },
    heldAt + 1,
  );

  // As a device does that was without a connection for hours.
  const again = heldAt + 10 * lateMs;
  workspace.mutate("post.schedule", { id: post, dueAt: heldAt + 2 }, again);

  expect(postOf(workspace, post).heldAt).toBe(again);
  // A new one, unread: what was read was about the time before.
  expect(workspace.rows("notification")).toMatchObject([
    { id: post, kind: "post_held", createdAt: again, readAt: null },
  ]);
});

it("says nothing a second time of a held post that comes back from being put aside", () => {
  const workspace = scheduled();
  const { post, heldAt } = held(workspace);
  workspace.mutate("post.trash", { id: post }, heldAt + 1);

  workspace.mutate("post.restore", { id: post }, heldAt + 2);

  // Held as it was, by the time at which it was first held.
  expect(postOf(workspace, post)).toMatchObject({
    status: "scheduled",
    heldAt,
    trashedAt: null,
  });
  expect(workspace.rows("notification")).toEqual([]);
});

it("tells of a post whose time passed by more than an hour while it was put aside", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start + 1);
  workspace.mutate("post.trash", { id: post }, start + 2);
  const back = dueAt + lateMs + 1;

  workspace.mutate("post.restore", { id: post }, back);

  expect(postOf(workspace, post).heldAt).toBe(back);
  expect(workspace.rows("notification")).toMatchObject([
    { id: post, kind: "post_held", createdAt: back },
  ]);
});

it("tells of a post that goes out at its time and fails like of any post that failed", () => {
  const workspace = scheduled();
  const post = draft(workspace, 1);
  const dueAt = start + 1000;
  workspace.mutate("post.schedule", { id: post, dueAt }, start + 1);
  due(workspace, post, dueAt);
  workspace.mutate("target.start", { id: id(201) }, dueAt + 1, "server");

  workspace.mutate(
    "target.end",
    {
      id: id(201),
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    dueAt + 2,
    "server",
  );

  // The delivery is of the round that began when the post was taken up:
  // that is what the inbox goes by.
  expect(workspace.rows("notification")).toEqual([
    {
      id: post,
      kind: "post_failed",
      postId: post,
      channelId: null,
      createdAt: dueAt + 2,
      readAt: null,
    },
  ]);
});

it("says that a post failed in the place of that it was held, when a held post is sent and fails", () => {
  const workspace = scheduled();
  const { post, heldAt } = held(workspace);
  workspace.mutate("post.publish", { id: post }, heldAt + 1);
  workspace.mutate("target.start", { id: id(201) }, heldAt + 2, "server");

  workspace.mutate(
    "target.end",
    {
      id: id(201),
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    heldAt + 3,
    "server",
  );

  expect(workspace.rows("notification")).toMatchObject([
    { id: post, kind: "post_failed", createdAt: heldAt + 3 },
  ]);
});

it("leaves a post that is being sent as it is, whatever is done to the queue, the slots and the settings", () => {
  // The inbox tells of a delivery by whether it was asked for since the
  // post last began to be sent, which `updatedAt` of the post says:
  // nothing may write it while the post is `sending`.
  const workspace = scheduled();
  const sending = draft(workspace, 1);
  workspace.mutate("post.enqueue", { id: sending, first: false }, start + 1);
  const queued = draft(workspace, 2);
  workspace.mutate("post.enqueue", { id: queued, first: false }, start + 2);
  // It goes out at its slot, and the other post stays in the queue.
  due(workspace, sending, at(firstMonday));
  const before = postOf(workspace, sending);
  expect(before).toMatchObject({
    status: "sending",
    updatedAt: at(firstMonday),
  });

  let time = at(firstMonday);
  const run = (
    name: Parameters<Workspace["mutate"]>[0],
    args: object,
    source: "client" | "server" = "client",
  ) => {
    time += 1;
    try {
      // The arguments are those of the mutator that is named.
      workspace.mutate(name, args as never, time, source);
    } catch (error) {
      // Refusing is one way to leave the post alone.
      if (!(error instanceof MutationRejected)) throw error;
    }
  };
  // Everything that scheduling has, about the post itself:
  run("post.schedule", { id: sending, dueAt: time + lateMs });
  run("post.enqueue", { id: sending, first: true });
  run("post.move", { id: sending, afterId: queued });
  run("post.unschedule", { id: sending });
  run("post.trash", { id: sending });
  run("post.restore", { id: sending });
  run("post.due", { id: sending }, "server");
  // And about the queue around it, which gives its posts their times anew:
  run("post.move", { id: queued, afterId: null });
  run("slot.add", { id: id(303), weekday: 5, minute: 600 });
  run("slot.remove", { id: id(301) });
  run("queue.setPaused", { paused: true });
  run("queue.setPaused", { paused: false });
  run("settings.setTimeZone", { timeZone: "America/New_York" });
  run("post.unschedule", { id: queued });

  // The queue did change: the mutations were not all refused.
  expect(postOf(workspace, queued).status).toBe("draft");
  expect(postOf(workspace, sending)).toEqual(before);
});
