import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { MutationRejected, type RejectionCode } from "./mutators.ts";
import { ownTextMutations } from "./own-text.ts";
import {
  inReadingOrder,
  maxOwnTextLength,
  maxParts,
  maxPartTextLength,
  partsFor,
  postStatuses,
} from "./tables.ts";

const postId = "01932c07-0000-7000-8000-000000000001";
const partId = "01932c07-0000-7000-8000-000000000002";
const otherPostId = "01932c07-0000-7000-8000-000000000003";
const otherPartId = "01932c07-0000-7000-8000-000000000004";

/** The code that `run` is rejected with. Fails if it is not rejected. */
function rejectionOf(run: () => void): RejectionCode {
  try {
    run();
  } catch (error) {
    if (error instanceof MutationRejected) return error.code;
    throw error;
  }
  throw new Error("The mutation was not rejected");
}

it("creates a post as a draft with one part", () => {
  const workspace = memoryWorkspace();

  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);

  expect(workspace.rows("post")).toEqual([
    { id: postId, status: "draft", createdAt: 1000, updatedAt: 1000 },
  ]);
  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, targetId: null, position: 0, text: "Hello" },
  ]);
});

it("creates a post with no text yet", () => {
  const workspace = memoryWorkspace();

  // A draft exists from the moment the composer opens, before anything is
  // typed, and a draft whose text was cleared must stay valid.
  workspace.mutate("post.create", { id: postId, partId, text: "" });

  expect(workspace.rows("post_part")[0]?.text).toBe("");
});

it.each([
  ["the post", { id: postId, partId: otherPartId }],
  ["the part", { id: otherPostId, partId }],
])("refuses to create a post when %s exists already", (_name, ids) => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "First" });

  // The same IDs under a new mutation ID: an ID is made up by a client, and
  // a second create must not replace what the first one made.
  const code = rejectionOf(() =>
    workspace.mutate("post.create", { ...ids, text: "Second" }),
  );

  expect(code).toBe("already_exists");
  expect(workspace.rows("post")).toHaveLength(1);
  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, targetId: null, position: 0, text: "First" },
  ]);
});

it("replaces the text of a part and notes when the post changed", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);

  workspace.mutate("part.setText", { id: partId, text: "Hello, world" }, 5000);

  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, targetId: null, position: 0, text: "Hello, world" },
  ]);
  // Lists of posts are sorted by the last change, which a change of the
  // text of a part is.
  expect(workspace.rows("post")).toEqual([
    { id: postId, status: "draft", createdAt: 1000, updatedAt: 5000 },
  ]);
});

it("refuses to change the text of a part that does not exist", () => {
  const workspace = memoryWorkspace();

  // What a client that was offline sends after another device deleted the
  // post.
  const code = rejectionOf(() =>
    workspace.mutate("part.setText", { id: partId, text: "Too late" }),
  );

  expect(code).toBe("not_found");
  expect(workspace.rows("post_part")).toEqual([]);
});

it.each(postStatuses.filter((status) => status !== "draft"))(
  "refuses to change the text of a post that is %s",
  (status) => {
    const workspace = memoryWorkspace();
    // No mutator moves a post out of the draft status yet, so the rows are
    // stored directly.
    workspace.put("post", { id: postId, status, createdAt: 0, updatedAt: 0 });
    workspace.put("post_part", {
      id: partId,
      postId,
      targetId: null,
      position: 0,
      text: "Sent",
    });

    const code = rejectionOf(() =>
      workspace.mutate("part.setText", { id: partId, text: "Edited" }, 5000),
    );

    expect(code).toBe("not_a_draft");
    expect(workspace.rows("post_part")[0]?.text).toBe("Sent");
    expect(workspace.rows("post")[0]?.updatedAt).toBe(0);
  },
);

it("deletes a post with all its parts and nothing else", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Goes" });
  // A second part, as a thread has.
  workspace.mutate("part.add", {
    id: "01932c07-0000-7000-8000-000000000005",
    postId,
    channelId: null,
    afterId: partId,
    text: "Goes too",
  });
  workspace.mutate("post.create", {
    id: otherPostId,
    partId: otherPartId,
    text: "Stays",
  });

  workspace.mutate("post.delete", { id: postId });

  expect(workspace.rows("post").map((post) => post.id)).toEqual([otherPostId]);
  expect(workspace.rows("post_part").map((part) => part.id)).toEqual([
    otherPartId,
  ]);
});

it("accepts the deletion of a post that does not exist", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Stays" });

  // Two devices can delete the same post. The second deletion has nothing
  // left to do, which is not worth an error on that device.
  workspace.mutate("post.delete", { id: otherPostId });

  expect(workspace.rows("post")).toHaveLength(1);
});

it.each([
  "post.archive",
  // Properties that every object has. They are not mutators.
  "constructor",
  "toString",
  "__proto__",
])("refuses the unknown mutation %s", (name) => {
  const workspace = memoryWorkspace();

  expect(rejectionOf(() => workspace.mutate(name, { id: postId }))).toBe(
    "unknown_mutation",
  );
});

it.each([
  ["no arguments", undefined],
  ["a missing argument", { id: postId, partId }],
  ["an argument too many", { id: postId, partId, text: "", status: "sent" }],
  ["an ID that is not a UUIDv7", { id: "1", partId, text: "" }],
  ["a text of another type", { id: postId, partId, text: 5 }],
  [
    "a text that is too long",
    { id: postId, partId, text: "a".repeat(maxPartTextLength + 1) },
  ],
])("refuses to create a post with %s", (_name, args) => {
  const workspace = memoryWorkspace();

  expect(rejectionOf(() => workspace.mutate("post.create", args))).toBe(
    "invalid_arguments",
  );
  expect(workspace.rows("post")).toEqual([]);
});

it("accepts a text of the greatest length", () => {
  const workspace = memoryWorkspace();
  const text = "a".repeat(maxPartTextLength);

  workspace.mutate("post.create", { id: postId, partId, text });

  expect(workspace.rows("post_part")[0]?.text).toBe(text);
});

it("says which argument is wrong", () => {
  const workspace = memoryWorkspace();

  // The message ends up in front of whoever debugs a client.
  expect(() =>
    workspace.mutate("part.setText", { id: partId, text: null }),
  ).toThrow(/^text: /);
});

const channelId = "01932c07-0000-7000-8000-000000000006";
const otherChannelId = "01932c07-0000-7000-8000-000000000007";

/** What the server passes to `channel.connect` for an account. */
function account(fields: Record<string, unknown> = {}) {
  return {
    id: channelId,
    network: "mastodon",
    accountId: "1@mastodon.example",
    handle: "@ada@mastodon.example",
    name: "Ada Lovelace",
    avatarUrl: "https://mastodon.example/avatars/ada.png",
    profileUrl: "https://mastodon.example/@ada",
    expiresAt: null,
    limits,
    ...fields,
  };
}

/** What the instance of the account lets it post. */
const limits = {
  network: "mastodon",
  maxCharacters: 500,
  charactersPerUrl: 23,
} as const;

/** The channel that `account()` is stored as when it is connected at `at`. */
function channel(at: number, fields: Record<string, unknown> = {}) {
  return {
    ...account(fields),
    status: "connected",
    connectedAt: at,
    limitsCheckedAt: at,
  };
}

it("stores a connected account as a channel that is good to use", () => {
  const workspace = memoryWorkspace();

  workspace.mutate("channel.connect", account(), 1000, "server");

  expect(workspace.rows("channel")).toEqual([channel(1000)]);
});

it("brings the channel of an account up to date when the account is connected again", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");
  // What the publishing of a later phase does when the network refuses the
  // access. No mutator does it yet, so the row is stored directly.
  workspace.put("channel", {
    ...account(),
    network: "mastodon",
    status: "needs_reconnect",
    connectedAt: 1000,
    limitsCheckedAt: 1000,
  });

  // The server makes up a new ID every time: it does not know whether the
  // account has a channel.
  workspace.mutate(
    "channel.connect",
    account({ id: otherChannelId, name: "Ada", expiresAt: 9000 }),
    5000,
    "server",
  );

  // One channel, under the ID it had, because posts refer to it by that.
  expect(workspace.rows("channel")).toEqual([
    channel(5000, { name: "Ada", expiresAt: 9000 }),
  ]);
});

it("keeps the limits of a channel when its account is connected again and the network does not say", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  // The network was out of reach when it was asked what the account may
  // post. What it said last time is better than nothing.
  workspace.mutate(
    "channel.connect",
    account({ limits: null }),
    5000,
    "server",
  );

  expect(workspace.rows("channel")).toEqual([
    { ...channel(5000), limitsCheckedAt: 1000 },
  ]);
});

it("stores a channel without limits when the network has never said", () => {
  const workspace = memoryWorkspace();

  workspace.mutate(
    "channel.connect",
    account({ limits: null }),
    1000,
    "server",
  );

  expect(workspace.rows("channel")).toEqual([
    { ...channel(1000, { limits: null }), limitsCheckedAt: null },
  ]);
});

it("replaces the limits of a channel, and says when", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");
  const longer = { ...limits, maxCharacters: 5000 };

  workspace.mutate(
    "channel.setLimits",
    { id: channelId, limits: longer },
    7000,
    "server",
  );

  expect(workspace.rows("channel")).toEqual([
    { ...channel(1000, { limits: longer }), limitsCheckedAt: 7000 },
  ]);
  // The channel can be disconnected while its network is asked.
  expect(
    rejectionOf(() =>
      workspace.mutate(
        "channel.setLimits",
        { id: otherChannelId, limits },
        8000,
        "server",
      ),
    ),
  ).toBe("not_found");
});

it("moves the end of the access of a channel when its credentials are renewed", () => {
  const workspace = memoryWorkspace();
  workspace.mutate(
    "channel.connect",
    account({ expiresAt: 9000 }),
    1000,
    "server",
  );

  workspace.mutate(
    "channel.renew",
    { id: channelId, expiresAt: 20_000 },
    5000,
    "server",
  );

  // Nothing else about the channel changes: it was connected when it was.
  expect(workspace.rows("channel")).toEqual([
    channel(1000, { expiresAt: 20_000 }),
  ]);
  expect(
    rejectionOf(() =>
      workspace.mutate(
        "channel.renew",
        { id: otherChannelId, expiresAt: null },
        6000,
        "server",
      ),
    ),
  ).toBe("not_found");
});

it("marks a channel whose access was not renewed, and only the connection that was refused", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  // The word of the network about a connection from before this one.
  workspace.mutate(
    "channel.lapse",
    { id: channelId, connectedAt: 500 },
    2000,
    "server",
  );
  expect(workspace.rows("channel")).toEqual([channel(1000)]);

  workspace.mutate(
    "channel.lapse",
    { id: channelId, connectedAt: 1000 },
    3000,
    "server",
  );
  expect(workspace.rows("channel")).toEqual([
    { ...channel(1000), status: "needs_reconnect" },
  ]);
  // A channel that is gone is nothing to mark, and nothing to refuse.
  workspace.mutate(
    "channel.lapse",
    { id: otherChannelId, connectedAt: 1000 },
    4000,
    "server",
  );
});

it.each([
  ["another account of the network", { accountId: "2@mastodon.example" }],
  // The IDs of two networks are unrelated, also when they read the same.
  ["the account with the same ID on another network", { network: "bluesky" }],
])("gives %s a channel of its own", (_name, fields) => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  workspace.mutate(
    "channel.connect",
    account({ id: otherChannelId, ...fields }),
    1000,
    "server",
  );

  expect(workspace.rows("channel").map(({ id }) => id)).toEqual([
    channelId,
    otherChannelId,
  ]);
});

it("refuses to give a new channel the ID of another", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  const code = rejectionOf(() =>
    workspace.mutate(
      "channel.connect",
      account({ accountId: "2@mastodon.example" }),
      1000,
      "server",
    ),
  );

  // Storing it would have replaced the channel of the first account.
  expect(code).toBe("already_exists");
  expect(workspace.rows("channel")).toEqual([channel(1000)]);
});

it.each([
  ["an address that is not HTTPS", { avatarUrl: "http://mastodon.example/a" }],
  // A page shows the profile as a link. Followed, this would run a script.
  ["a script in place of an address", { profileUrl: "javascript:alert(1)" }],
  ["a network that pigy does not know", { network: "myspace" }],
  ["a status", { status: "needs_reconnect" }],
  ["an empty handle", { handle: "" }],
  // Limits name their network, and say nothing that pigy does not know.
  ["limits of no network", { limits: { maxCharacters: 500 } }],
])("refuses to store a channel with %s", (_name, fields) => {
  const workspace = memoryWorkspace();

  const code = rejectionOf(() =>
    workspace.mutate("channel.connect", account(fields), 1000, "server"),
  );

  expect(code).toBe("invalid_arguments");
  expect(workspace.rows("channel")).toEqual([]);
});

it("removes a channel, and accepts that it is gone already", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  workspace.mutate("channel.disconnect", { id: channelId }, 2000, "server");
  // Two tabs can disconnect the same channel.
  workspace.mutate("channel.disconnect", { id: channelId }, 3000, "server");

  expect(workspace.rows("channel")).toEqual([]);
});

it.each([
  ["channel.connect", account()],
  ["channel.setLimits", { id: channelId, limits }],
  ["channel.renew", { id: channelId, expiresAt: 5000 }],
  ["channel.lapse", { id: channelId, connectedAt: 1000 }],
  ["channel.disconnect", { id: channelId }],
])("refuses %s from a client", (name, args) => {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");

  // A channel is only as good as the credentials that the server keeps for
  // it, so a client can neither make one up nor drop one.
  expect(rejectionOf(() => workspace.mutate(name, args, 2000, "client"))).toBe(
    "not_allowed",
  );
  expect(workspace.rows("channel")).toEqual([channel(1000)]);
});

it("lets the server run what a client may", () => {
  const workspace = memoryWorkspace();

  // The REST API of a later phase creates posts this way.
  workspace.mutate(
    "post.create",
    { id: postId, partId, text: "Hello" },
    0,
    "server",
  );

  expect(workspace.rows("post")).toHaveLength(1);
});

// Targets: where a post goes, and how far each delivery has come.

const targetId = "01932c07-0000-7000-8000-000000000008";
const otherTargetId = "01932c07-0000-7000-8000-000000000009";
const resultId = "01932c07-0000-7000-8000-00000000000a";
const otherResultId = "01932c07-0000-7000-8000-00000000000b";

/**
 * A workspace with two connected accounts and a draft of two parts, at the
 * time 1000.
 */
function withDraft() {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account(), 1000, "server");
  workspace.mutate(
    "channel.connect",
    account({ id: otherChannelId, accountId: "2@mastodon.example" }),
    1000,
    "server",
  );
  workspace.mutate("post.create", { id: postId, partId, text: "One" }, 1000);
  workspace.mutate(
    "part.add",
    { id: otherPartId, postId, channelId: null, afterId: partId, text: "Two" },
    1000,
  );
  return workspace;
}

/** `withDraft()`, with the draft going to the first account. */
function withTarget() {
  const workspace = withDraft();
  workspace.mutate("target.add", { id: targetId, postId, channelId }, 2000);
  return workspace;
}

/** `withTarget()`, published, and with its delivery begun. */
function sending() {
  const workspace = withTarget();
  workspace.mutate("post.publish", { id: postId }, 3000);
  workspace.mutate("target.start", { id: targetId }, 4000, "server");
  return workspace;
}

type Workspace = ReturnType<typeof memoryWorkspace>;

const thirdPartId = "01932c07-0000-7000-8000-00000000000c";
const fourthPartId = "01932c07-0000-7000-8000-00000000000d";
const ownPartId = "01932c07-0000-7000-8000-00000000000e";
const otherOwnPartId = "01932c07-0000-7000-8000-00000000000f";

/**
 * The text of the parts of one text of the post, in the order they are
 * read in: the post's own, or the one written for `target`.
 */
const textsOf = (workspace: Workspace, target: string | null = null) =>
  inReadingOrder(
    workspace.rows("post_part").filter(({ targetId }) => targetId === target),
  ).map(({ text }) => text);

/** Adds a part to the post's own text, after `afterId`, at `now`. */
const add = (
  workspace: Workspace,
  id: string,
  afterId: string | null,
  text: string,
  now = 2000,
) =>
  workspace.mutate(
    "part.add",
    { id, postId, channelId: null, afterId, text },
    now,
  );

const statusOf = (workspace: Workspace) => workspace.rows("post")[0]?.status;

/** The targets of the post by their channel, as status and attempt. */
const targetsOf = (workspace: Workspace) =>
  Object.fromEntries(
    workspace
      .rows("post_target")
      .map(({ channelId: channel, status, attempt }) => [
        channel,
        `${status} ${attempt}`,
      ]),
  );

it("chooses a channel for a draft", () => {
  const workspace = withTarget();

  expect(workspace.rows("post_target")).toEqual([
    {
      id: targetId,
      postId,
      channelId,
      status: "pending",
      attempt: 0,
      error: null,
      queuedAt: null,
      sentAt: null,
      disconnected: false,
    },
  ]);
  // Where a draft goes is part of the draft.
  expect(workspace.rows("post")[0]?.updatedAt).toBe(2000);
});

it("keeps the target that came first when a channel is chosen twice", () => {
  const workspace = withTarget();

  // A second device chose the same channel before it had heard of the
  // first, and made up an ID of its own.
  workspace.mutate(
    "target.add",
    { id: otherTargetId, postId, channelId },
    5000,
  );

  expect(workspace.rows("post_target").map(({ id }) => id)).toEqual([targetId]);
  // Nothing changed, so the draft is as old as it was.
  expect(workspace.rows("post")[0]?.updatedAt).toBe(2000);
});

it("takes a channel back from a draft, by the post and the channel", () => {
  const workspace = withTarget();

  workspace.mutate("target.remove", { postId, channelId }, 5000);
  // Two devices can take the same channel back.
  workspace.mutate("target.remove", { postId, channelId }, 6000);

  expect(workspace.rows("post_target")).toEqual([]);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(5000);
});

it.each([
  [
    "a post that is gone",
    { id: targetId, postId: otherPostId, channelId },
    "not_found",
  ],
  [
    "an account that is not connected",
    { id: targetId, postId, channelId: otherPostId },
    "not_found",
  ],
  [
    "the ID of another target",
    { id: targetId, postId, channelId: otherChannelId },
    "already_exists",
  ],
])("refuses to send a draft to %s", (_name, args, code) => {
  const workspace = withTarget();

  expect(rejectionOf(() => workspace.mutate("target.add", args))).toBe(code);
  expect(workspace.rows("post_target")).toHaveLength(1);
});

it("publishes a draft: the post is sending and its targets wait their turn", () => {
  const workspace = withTarget();
  workspace.mutate(
    "target.add",
    { id: otherTargetId, postId, channelId: otherChannelId },
    2500,
  );

  workspace.mutate("post.publish", { id: postId }, 3000);

  expect(workspace.rows("post")).toEqual([
    { id: postId, status: "sending", createdAt: 1000, updatedAt: 3000 },
  ]);
  expect(workspace.rows("post_target")).toMatchObject([
    { id: targetId, status: "queued", attempt: 0, queuedAt: 3000 },
    { id: otherTargetId, status: "queued", attempt: 0, queuedAt: 3000 },
  ]);
});

it("refuses to publish a draft that goes nowhere", () => {
  const workspace = withDraft();

  expect(
    rejectionOf(() => workspace.mutate("post.publish", { id: postId })),
  ).toBe("no_channels");
  expect(statusOf(workspace)).toBe("draft");
});

it("publishes a post once", () => {
  const workspace = withTarget();
  workspace.mutate("post.publish", { id: postId }, 3000);

  // A second device pressed the button too, or the same one twice.
  expect(
    rejectionOf(() => workspace.mutate("post.publish", { id: postId }, 3500)),
  ).toBe("not_a_draft");
  expect(workspace.rows("post_target")[0]?.queuedAt).toBe(3000);
});

it("leaves a post as it is from the moment it is published", () => {
  const workspace = withTarget();
  workspace.mutate("post.publish", { id: postId }, 3000);

  // What goes out is what was there when publishing was asked for: every
  // step of a delivery is handed the same content.
  expect(
    rejectionOf(() =>
      workspace.mutate("part.setText", { id: partId, text: "Other" }),
    ),
  ).toBe("not_a_draft");
  expect(
    rejectionOf(() => workspace.mutate("target.remove", { postId, channelId })),
  ).toBe("not_a_draft");
  expect(
    rejectionOf(() =>
      workspace.mutate("target.add", {
        id: otherTargetId,
        postId,
        channelId: otherChannelId,
      }),
    ),
  ).toBe("not_a_draft");
  // Neither can its parts be added to, removed or moved, nor an account
  // be given another text or lose the one it has: a delivery that is
  // tried again compares what it finds on the network with what it sent.
  const edits: [string, unknown][] = [
    [
      "part.add",
      { id: thirdPartId, postId, channelId: null, afterId: null, text: "" },
    ],
    ["part.remove", { id: otherPartId }],
    ["part.move", { id: otherPartId, afterId: null }],
    [
      "target.customize",
      { postId, channelId, parts: [{ id: thirdPartId, text: "Own" }] },
    ],
    ["target.followPost", { postId, channelId }],
  ];
  for (const [name, args] of edits) {
    expect(
      rejectionOf(() => workspace.mutate(name, args)),
      name,
    ).toBe("not_a_draft");
  }
  expect(textsOf(workspace)).toEqual(["One", "Two"]);
  // Deleted now, it would leave posts on the networks that nothing in
  // pigy knows of.
  expect(
    rejectionOf(() => workspace.mutate("post.delete", { id: postId })),
  ).toBe("sending");
  expect(workspace.rows("post_part")[0]?.text).toBe("One");
  expect(workspace.rows("post_target")).toHaveLength(1);
});

it("begins a delivery when no other to the channel is under way", () => {
  const workspace = sending();
  // A second post to the same account, published after the first.
  workspace.mutate(
    "post.create",
    { id: otherPostId, partId: resultId, text: "Next" },
    4100,
  );
  workspace.mutate(
    "target.add",
    { id: otherTargetId, postId: otherPostId, channelId },
    4200,
  );
  workspace.mutate("post.publish", { id: otherPostId }, 4300);

  expect(workspace.rows("post_target")).toMatchObject([
    { id: targetId, status: "sending", attempt: 1 },
    { id: otherTargetId, status: "queued", attempt: 0 },
  ]);
  // An adapter cannot tell two deliveries to one account apart that go out
  // together, so the second waits whoever asks.
  expect(
    rejectionOf(() =>
      workspace.mutate("target.start", { id: otherTargetId }, 4400, "server"),
    ),
  ).toBe("not_current");
  // A delivery begins once.
  expect(
    rejectionOf(() =>
      workspace.mutate("target.start", { id: targetId }, 4400, "server"),
    ),
  ).toBe("not_current");

  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 1, status: "sent" },
    5000,
    "server",
  );
  workspace.mutate("target.start", { id: otherTargetId }, 5100, "server");

  expect(workspace.rows("post_target")).toMatchObject([
    { id: targetId, status: "sent" },
    { id: otherTargetId, status: "sending", attempt: 1 },
  ]);
});

it("records the parts of a delivery as they are published", () => {
  const workspace = sending();
  const first = { id: resultId, remoteId: "111", url: "https://m.example/111" };
  const second = { id: otherResultId, remoteId: "112", url: null };

  workspace.mutate(
    "target.progress",
    { id: targetId, attempt: 1, parts: [first] },
    5000,
    "server",
  );

  expect(workspace.rows("target_part_result")).toEqual([
    { ...first, targetId, partId },
  ]);

  // The report after the second part lists both. The first keeps its row:
  // the ID that is passed for it this time is one that nobody has seen.
  workspace.mutate(
    "target.progress",
    {
      id: targetId,
      attempt: 1,
      parts: [{ ...first, id: otherTargetId }, second],
    },
    6000,
    "server",
  );

  expect(workspace.rows("target_part_result")).toEqual([
    { ...first, targetId, partId },
    { ...second, targetId, partId: otherPartId },
  ]);
  // The delivery goes on: nothing has ended.
  expect(targetsOf(workspace)).toEqual({ [channelId]: "sending 1" });
  expect(statusOf(workspace)).toBe("sending");
});

it("refuses a report of more parts than the post has", () => {
  const workspace = sending();
  const part = (id: string) => ({ id, remoteId: "1", url: null });

  expect(
    rejectionOf(() =>
      workspace.mutate(
        "target.progress",
        {
          id: targetId,
          attempt: 1,
          parts: [part(resultId), part(otherResultId), part(otherTargetId)],
        },
        5000,
        "server",
      ),
    ),
  ).toBe("invalid_arguments");
  // Nothing of a mutation that is refused stays.
  expect(workspace.rows("target_part_result")).toEqual([]);
});

it.each([
  ["sent", { status: "sent" }, { error: null, sentAt: 5000 }, "sent"],
  [
    "failed",
    { status: "error", error: "No", refusedConnection: null },
    { error: "No", sentAt: null },
    "error",
  ],
  [
    "of unknown outcome",
    { status: "uncertain", error: "Look", refusedConnection: null },
    { error: "Look", sentAt: null },
    "error",
  ],
] as const)(
  "ends a delivery as %s, and the post with its last target",
  (_name, end, target, post) => {
    const workspace = sending();

    workspace.mutate(
      "target.end",
      { id: targetId, attempt: 1, ...end },
      5000,
      "server",
    );

    expect(workspace.rows("post_target")).toMatchObject([
      { status: end.status, attempt: 1, ...target },
    ]);
    expect(workspace.rows("post")).toMatchObject([
      { status: post, updatedAt: 5000 },
    ]);
    // The channel is as good as it was.
    expect(workspace.rows("channel")[0]?.status).toBe("connected");
  },
);

it("keeps a post sending until the last of its targets has ended", () => {
  const workspace = withTarget();
  workspace.mutate(
    "target.add",
    { id: otherTargetId, postId, channelId: otherChannelId },
    2500,
  );
  workspace.mutate("post.publish", { id: postId }, 3000);
  workspace.mutate("target.start", { id: targetId }, 4000, "server");
  workspace.mutate("target.start", { id: otherTargetId }, 4001, "server");

  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    5000,
    "server",
  );

  // One has failed and the other is on its way: the post is not over, and
  // has not changed.
  expect(workspace.rows("post")).toMatchObject([
    { status: "sending", updatedAt: 3000 },
  ]);

  workspace.mutate(
    "target.end",
    { id: otherTargetId, attempt: 1, status: "sent" },
    6000,
    "server",
  );

  // Its targets ended differently, so the post is in `error`. Which of
  // them arrived, the targets say.
  expect(workspace.rows("post")).toMatchObject([
    { status: "error", updatedAt: 6000 },
  ]);
  expect(targetsOf(workspace)).toEqual({
    [channelId]: "error 1",
    [otherChannelId]: "sent 1",
  });
});

it("marks the channel when a delivery ends because its access is refused", () => {
  const workspace = sending();

  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "Connect the account again",
      // The connection that the channel has: it was made at 1000.
      refusedConnection: 1000,
    },
    5000,
    "server",
  );

  expect(
    workspace.rows("channel").map(({ id, status }) => [id, status]),
  ).toEqual([
    [channelId, "needs_reconnect"],
    [otherChannelId, "connected"],
  ]);
});

it("leaves a channel alone that was connected again since its access was refused", () => {
  const workspace = sending();
  // The network has refused the access of the connection made at 1000.
  // Before the delivery says so, the person connects the account again:
  // the channel keeps its ID, and has another access.
  workspace.mutate("channel.connect", account(), 4500, "server");

  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "Connect the account again",
      refusedConnection: 1000,
    },
    5000,
    "server",
  );

  // The delivery has failed all the same: it was refused.
  expect(workspace.rows("post_target")).toMatchObject([
    { status: "error", error: "Connect the account again" },
  ]);
  // The access that the channel has now was never tried. Marked, every
  // later delivery would fail without trying it.
  expect(workspace.rows("channel")).toMatchObject([
    { id: channelId, status: "connected", connectedAt: 4500 },
    { id: otherChannelId, status: "connected" },
  ]);
});

it("tries a delivery that failed again, at the end of the queue", () => {
  const workspace = sending();
  workspace.mutate(
    "target.progress",
    {
      id: targetId,
      attempt: 1,
      parts: [{ id: resultId, remoteId: "111", url: null }],
    },
    4500,
    "server",
  );
  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    5000,
    "server",
  );

  workspace.mutate("target.retry", { id: targetId }, 6000);

  // It waits its turn like a delivery that is new, and keeps what it has
  // published: the next attempt goes on from there.
  expect(workspace.rows("post_target")).toEqual([
    {
      id: targetId,
      postId,
      channelId,
      status: "queued",
      attempt: 1,
      error: null,
      queuedAt: 6000,
      sentAt: null,
      disconnected: false,
    },
  ]);
  expect(workspace.rows("target_part_result")).toHaveLength(1);
  expect(workspace.rows("post")).toMatchObject([
    { status: "sending", updatedAt: 6000 },
  ]);

  workspace.mutate("target.start", { id: targetId }, 7000, "server");

  expect(targetsOf(workspace)).toEqual({ [channelId]: "sending 2" });
});

it.each(["pending", "queued", "sending", "sent"] as const)(
  "refuses to try a delivery again that is %s",
  (status) => {
    const workspace = withTarget();
    const [target] = workspace.rows("post_target");
    if (!target) throw new Error("The draft has no target");
    workspace.put("post_target", { ...target, status });

    expect(
      rejectionOf(() => workspace.mutate("target.retry", { id: targetId })),
    ).toBe("not_failed");
    expect(workspace.rows("post_target")[0]?.status).toBe(status);
  },
);

it("refuses to try a delivery again whose account is disconnected", () => {
  const workspace = sending();
  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    5000,
    "server",
  );
  workspace.mutate("channel.disconnect", { id: channelId }, 6000, "server");

  expect(
    rejectionOf(() => workspace.mutate("target.retry", { id: targetId }, 7000)),
  ).toBe("not_found");
  // What has ended stays, for the record, with the reason it had.
  expect(workspace.rows("post_target")).toMatchObject([
    { status: "error", error: "No", channelId },
  ]);
});

it("refuses the report of a delivery that is no longer under way", () => {
  const workspace = sending();
  const progress = {
    id: targetId,
    attempt: 1,
    parts: [{ id: resultId, remoteId: "111", url: null }],
  };
  const sent = { id: targetId, attempt: 1, status: "sent" } as const;
  workspace.mutate(
    "target.end",
    {
      id: targetId,
      attempt: 1,
      status: "error",
      error: "No",
      refusedConnection: null,
    },
    5000,
    "server",
  );

  // The delivery has ended: a report that comes after it changes nothing.
  for (const [name, args] of [
    ["target.progress", progress],
    ["target.end", sent],
  ] as const) {
    expect(
      rejectionOf(() => workspace.mutate(name, args, 5500, "server")),
    ).toBe("not_current");
  }

  // Nor does a report of the first attempt once a second is under way: a
  // run that pigy gave up on must not speak for the one that took over.
  workspace.mutate("target.retry", { id: targetId }, 6000);
  workspace.mutate("target.start", { id: targetId }, 7000, "server");
  for (const [name, args] of [
    ["target.progress", progress],
    ["target.end", sent],
  ] as const) {
    expect(
      rejectionOf(() => workspace.mutate(name, args, 7500, "server")),
    ).toBe("not_current");
  }
  expect(targetsOf(workspace)).toEqual({ [channelId]: "sending 2" });
  expect(workspace.rows("target_part_result")).toEqual([]);
});

it("ends what was to go to an account that is disconnected", () => {
  const workspace = sending();
  // A second post is a draft that goes to the same account, a third waits
  // behind the first, and a fourth went there before.
  const ids = [
    ["01932c07-0000-7000-8000-000000000011", "pending"],
    ["01932c07-0000-7000-8000-000000000012", "queued"],
    ["01932c07-0000-7000-8000-000000000013", "sent"],
  ] as const;
  for (const [id, status] of ids) {
    workspace.put("post", { id, status: "draft", createdAt: 0, updatedAt: 0 });
    workspace.put("post_target", {
      id,
      postId: id,
      channelId,
      status,
      attempt: 0,
      error: null,
      queuedAt: null,
      sentAt: null,
      disconnected: false,
    });
  }
  workspace.mutate(
    "target.progress",
    {
      id: targetId,
      attempt: 1,
      parts: [{ id: resultId, remoteId: "111", url: null }],
    },
    4500,
    "server",
  );

  workspace.mutate("channel.disconnect", { id: channelId }, 6000, "server");

  const message = "The account was disconnected before the post was sent.";
  expect(
    workspace
      .rows("post_target")
      .map(({ id, status, error }) => [id, status, error]),
  ).toEqual([
    // The delivery that was under way fails, and so does the one that
    // waited. Neither can go on without the access that went with the
    // channel.
    [targetId, "error", message],
    [ids[1][0], "error", message],
    // What was sent stays as it is. The draft simply goes there no more.
    [ids[2][0], "sent", null],
  ]);
  // What the first had published is still published, and still listed.
  expect(workspace.rows("target_part_result")).toHaveLength(1);
  // Each post has the status that its targets leave it with.
  expect(
    Object.fromEntries(
      workspace.rows("post").map(({ id, status }) => [id, status]),
    ),
  ).toEqual({
    [postId]: "error",
    [ids[0][0]]: "draft",
    [ids[1][0]]: "error",
    [ids[2][0]]: "draft",
  });
});

it("deletes a post that has ended with its targets and what they published", () => {
  const workspace = sending();
  workspace.mutate(
    "target.progress",
    {
      id: targetId,
      attempt: 1,
      parts: [{ id: resultId, remoteId: "111", url: null }],
    },
    4500,
    "server",
  );
  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 1, status: "sent" },
    5000,
    "server",
  );

  workspace.mutate("post.delete", { id: postId }, 6000);

  expect(workspace.rows("post")).toEqual([]);
  expect(workspace.rows("post_part")).toEqual([]);
  expect(workspace.rows("post_target")).toEqual([]);
  expect(workspace.rows("target_part_result")).toEqual([]);
});

it.each([
  ["target.start", { id: targetId }],
  ["target.progress", { id: targetId, attempt: 1, parts: [] }],
  ["target.end", { id: targetId, attempt: 1, status: "sent" }],
])("refuses %s from a client", (name, args) => {
  const workspace = sending();
  // Back to where `target.start` would apply.
  const [target] = workspace.rows("post_target");
  if (!target) throw new Error("The post has no target");
  if (name === "target.start") {
    workspace.put("post_target", { ...target, status: "queued" });
  }
  const before = workspace.rows("post_target");

  // What a delivery has done is the word of the server, which did it. A
  // client that could say so would mark as sent what never left.
  expect(rejectionOf(() => workspace.mutate(name, args, 5000, "client"))).toBe(
    "not_allowed",
  );
  expect(workspace.rows("post_target")).toEqual(before);
});

it("adds a part after the part that it names, or first", () => {
  const workspace = withDraft();

  add(workspace, thirdPartId, partId, "One and a half", 2000);
  add(workspace, fourthPartId, null, "Zero", 3000);

  expect(textsOf(workspace)).toEqual(["Zero", "One", "One and a half", "Two"]);
  // The parts of a text are numbered from 0 with no gap, whatever was
  // added where.
  expect(
    inReadingOrder(workspace.rows("post_part")).map(({ position }) => position),
  ).toEqual([0, 1, 2, 3]);
  // A part is part of the draft.
  expect(workspace.rows("post")[0]?.updatedAt).toBe(3000);
});

it("keeps both parts that two devices add at the same place", () => {
  const workspace = withDraft();

  // Both devices saw "One", "Two" and added a part after "One". The server
  // runs one mutation and then the other, each on the rows as they are.
  add(workspace, thirdPartId, partId, "From the first device");
  add(workspace, fourthPartId, partId, "From the second device");

  // Neither is lost, no two parts share a position, and the parts that
  // were there keep their order.
  expect(textsOf(workspace)).toEqual([
    "One",
    "From the second device",
    "From the first device",
    "Two",
  ]);
  expect(
    workspace
      .rows("post_part")
      .map(({ position }) => position)
      .sort(),
  ).toEqual([0, 1, 2, 3]);
});

it("adds a part at the end when the part to go after is gone", () => {
  const workspace = withDraft();
  // Another device removed "Two" before this one's part, which was to
  // follow it, arrived.
  workspace.mutate("part.remove", { id: otherPartId });

  add(workspace, thirdPartId, otherPartId, "Three");

  // What was typed into the part is kept.
  expect(textsOf(workspace)).toEqual(["One", "Three"]);
});

it("refuses a part with the ID of another, and one for a post that is gone", () => {
  const workspace = withDraft();

  expect(rejectionOf(() => add(workspace, otherPartId, partId, "Again"))).toBe(
    "already_exists",
  );
  expect(
    rejectionOf(() =>
      workspace.mutate("part.add", {
        id: thirdPartId,
        postId: otherPostId,
        channelId: null,
        afterId: null,
        text: "Nowhere",
      }),
    ),
  ).toBe("not_found");
  expect(textsOf(workspace)).toEqual(["One", "Two"]);
});

it("refuses one part more than a text can have", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "1" });
  const id = (index: number) =>
    `01932c07-0000-7000-8000-1${index.toString().padStart(11, "0")}`;
  for (let index = 1; index < maxParts; index += 1) {
    add(workspace, id(index), null, String(index));
  }

  expect(rejectionOf(() => add(workspace, id(maxParts), null, "More"))).toBe(
    "too_many_parts",
  );
  expect(workspace.rows("post_part")).toHaveLength(maxParts);
});

it("removes a part and closes the gap", () => {
  const workspace = withDraft();
  add(workspace, thirdPartId, otherPartId, "Three");

  workspace.mutate("part.remove", { id: otherPartId }, 4000);
  // Two devices can remove the same part.
  workspace.mutate("part.remove", { id: otherPartId }, 5000);

  expect(textsOf(workspace)).toEqual(["One", "Three"]);
  expect(
    inReadingOrder(workspace.rows("post_part")).map(({ position }) => position),
  ).toEqual([0, 1]);
  // The second removal changed nothing, so the draft is as old as the
  // first made it.
  expect(workspace.rows("post")[0]?.updatedAt).toBe(4000);
});

it("refuses to remove the only part of a post", () => {
  const workspace = withDraft();
  workspace.mutate("part.remove", { id: otherPartId });

  // A post always has a part: the editor has a field to type into.
  expect(
    rejectionOf(() => workspace.mutate("part.remove", { id: partId })),
  ).toBe("last_part");
  expect(textsOf(workspace)).toEqual(["One"]);
});

it("moves a part to after the part that it names, or to the beginning", () => {
  const workspace = withDraft();
  add(workspace, thirdPartId, otherPartId, "Three");

  workspace.mutate("part.move", { id: partId, afterId: thirdPartId }, 4000);
  expect(textsOf(workspace)).toEqual(["Two", "Three", "One"]);

  workspace.mutate("part.move", { id: thirdPartId, afterId: null }, 5000);
  expect(textsOf(workspace)).toEqual(["Three", "Two", "One"]);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(5000);

  // To where it is already: nothing changes, and the draft is no newer.
  workspace.mutate(
    "part.move",
    { id: otherPartId, afterId: thirdPartId },
    6000,
  );
  expect(textsOf(workspace)).toEqual(["Three", "Two", "One"]);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(5000);
});

it("keeps every part when two devices move parts at once", () => {
  const workspace = withDraft();
  add(workspace, thirdPartId, otherPartId, "Three");

  // Both devices saw "One", "Two", "Three". The first moved "Three" to
  // the beginning, the second moved "One" down by one, to after "Two".
  workspace.mutate("part.move", { id: thirdPartId, afterId: null });
  workspace.mutate("part.move", { id: partId, afterId: otherPartId });

  // Each move is carried out on what the one before left: every part is
  // there once, and each is where its move put it.
  expect(textsOf(workspace)).toEqual(["Three", "Two", "One"]);
  expect(
    workspace
      .rows("post_part")
      .map(({ position }) => position)
      .sort(),
  ).toEqual([0, 1, 2]);
});

it("leaves a part where it is when the part to go after is gone, and refuses to move one that is gone", () => {
  const workspace = withDraft();
  add(workspace, thirdPartId, otherPartId, "Three");
  workspace.mutate("part.remove", { id: otherPartId });

  workspace.mutate("part.move", { id: thirdPartId, afterId: otherPartId });
  // After itself is nowhere.
  workspace.mutate("part.move", { id: thirdPartId, afterId: thirdPartId });

  expect(textsOf(workspace)).toEqual(["One", "Three"]);
  expect(
    rejectionOf(() =>
      workspace.mutate("part.move", { id: otherPartId, afterId: null }),
    ),
  ).toBe("not_found");
});

/** `withTarget()`, with a text of two parts written for its account. */
function customized() {
  const workspace = withTarget();
  workspace.mutate(
    "target.customize",
    {
      postId,
      channelId,
      parts: [
        { id: ownPartId, text: "Own one" },
        { id: otherOwnPartId, text: "Own two" },
      ],
    },
    3000,
  );
  return workspace;
}

it("gives an account a text of its own, which leaves the post's alone", () => {
  const workspace = customized();

  expect(textsOf(workspace, targetId)).toEqual(["Own one", "Own two"]);
  expect(textsOf(workspace)).toEqual(["One", "Two"]);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(3000);
  // The parts of the two texts are edited apart, with the same mutators.
  workspace.mutate("part.setText", { id: ownPartId, text: "Own, edited" });
  workspace.mutate("part.remove", { id: otherOwnPartId });
  workspace.mutate("part.add", {
    id: thirdPartId,
    postId,
    channelId,
    afterId: ownPartId,
    text: "Own three",
  });
  workspace.mutate("part.move", { id: thirdPartId, afterId: null });
  expect(textsOf(workspace, targetId)).toEqual(["Own three", "Own, edited"]);
  expect(textsOf(workspace)).toEqual(["One", "Two"]);
});

it("hands a target the text that is written for it, and the others the post's", () => {
  const workspace = customized();
  workspace.mutate("target.add", {
    id: otherTargetId,
    postId,
    channelId: otherChannelId,
  });
  const parts = workspace.rows("post_part");

  expect(partsFor(parts, targetId).map(({ text }) => text)).toEqual([
    "Own one",
    "Own two",
  ]);
  expect(partsFor(parts, otherTargetId).map(({ text }) => text)).toEqual([
    "One",
    "Two",
  ]);
});

it("keeps the text that came first when two devices give an account its own", () => {
  const workspace = customized();

  // A second device began from the post's text before it had heard of
  // the first.
  workspace.mutate(
    "target.customize",
    { postId, channelId, parts: [{ id: thirdPartId, text: "Late" }] },
    4000,
  );

  // The account has one text, whole, and not parts of both.
  expect(textsOf(workspace, targetId)).toEqual(["Own one", "Own two"]);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(3000);
});

it.each([
  [
    "an account that the post does not go to",
    { postId, channelId: otherChannelId, parts: [{ id: ownPartId, text: "" }] },
    "not_found",
  ],
  [
    "the ID of another part",
    { postId, channelId, parts: [{ id: partId, text: "" }] },
    "already_exists",
  ],
  [
    "the same ID twice",
    {
      postId,
      channelId,
      parts: [
        { id: ownPartId, text: "" },
        { id: ownPartId, text: "" },
      ],
    },
    "already_exists",
  ],
  ["no parts", { postId, channelId, parts: [] }, "invalid_arguments"],
  [
    // One mutation has to fit one message of the protocol.
    "more text than one mutation carries",
    {
      postId,
      channelId,
      parts: Array.from({ length: 5 }, (_, index) => ({
        id: `01932c07-0000-7000-8000-20000000000${index}`,
        text: "x".repeat(maxOwnTextLength / 5 + 1),
      })),
    },
    "invalid_arguments",
  ],
])("refuses a text of its own for %s", (_name, args, code) => {
  const workspace = withTarget();

  expect(rejectionOf(() => workspace.mutate("target.customize", args))).toBe(
    code,
  );
  // Nothing of a text that is refused stays.
  expect(workspace.rows("post_part")).toHaveLength(2);
});

it("refuses a part for the text of an account that has none of its own", () => {
  const workspace = withTarget();

  // A text for an account begins as a whole. A part that arrives after
  // another device dropped the text must not begin one of a single part.
  expect(
    rejectionOf(() =>
      workspace.mutate("part.add", {
        id: thirdPartId,
        postId,
        channelId,
        afterId: null,
        text: "Stray",
      }),
    ),
  ).toBe("not_found");
  expect(workspace.rows("post_part")).toHaveLength(2);
});

it.each([
  ["left out", "target.remove", { postId, channelId }, "client"],
  ["disconnected", "channel.disconnect", { id: channelId }, "server"],
] as const)(
  "refuses a part for the text of an account that was %s meanwhile, and leaves the post's text alone",
  (_name, name, args, source) => {
    const workspace = customized();
    // Another device takes the account away, and its text with it, while
    // this one is offline in the middle of that text.
    workspace.mutate(name, args, 4000, source);

    // What the first device then sends: a part after one of the text that
    // is gone. Without a target, nothing says whose text the part is for,
    // and it must not be taken for one of the post's own.
    expect(
      rejectionOf(() =>
        workspace.mutate(
          "part.add",
          {
            id: thirdPartId,
            postId,
            channelId,
            afterId: ownPartId,
            text: "For one account only",
          },
          5000,
        ),
      ),
    ).toBe("not_found");
    // The text that every other account gets is as it was.
    expect(textsOf(workspace)).toEqual(["One", "Two"]);
    expect(workspace.rows("post_part")).toHaveLength(2);
  },
);

it("puts a part that continues a text after the part that it names, or nowhere", () => {
  const workspace = customized();
  const add = (afterId: string) =>
    workspace.mutate("part.add", {
      id: thirdPartId,
      postId,
      channelId,
      afterId,
      mustFollow: true,
      text: "Own three",
    });

  // A part of the post's own text is of the post and not of this text,
  // and the part goes to the end after such a one without `mustFollow`.
  expect(rejectionOf(() => add(partId))).toBe("not_found");
  expect(textsOf(workspace, targetId)).toEqual(["Own one", "Own two"]);

  add(ownPartId);
  expect(textsOf(workspace, targetId)).toEqual([
    "Own one",
    "Own three",
    "Own two",
  ]);
});

it("never puts a part of a text that is brought back into the text that the account was given meanwhile", () => {
  const workspace = withTarget();
  // A text that an account had and that is brought back, of more than
  // one mutation carries: the last of its parts comes with a `part.add`.
  const old = Array.from({ length: 5 }, (_, index) =>
    `Old ${index} `.padEnd(9000, "x"),
  );
  expect(old.join("").length).toBeGreaterThan(maxOwnTextLength);
  let next = 0;
  const mutations = ownTextMutations(postId, channelId, old, () => {
    next += 1;
    return `01932c07-0000-7000-8000-10000000000${next}`;
  });
  expect(mutations.map(({ name }) => name)).toEqual([
    "target.customize",
    "part.add",
  ]);
  // Before they run, the account is given a text anew: by the person, who
  // then presses the Undo of an older notice, or by another device.
  workspace.mutate("target.customize", {
    postId,
    channelId,
    parts: [{ id: ownPartId, text: "New" }],
  });

  const refused: string[] = [];
  for (const { name, args } of mutations) {
    try {
      workspace.mutate(name, args);
    } catch (error) {
      if (!(error instanceof MutationRejected)) throw error;
      refused.push(`${name}: ${error.code}`);
    }
  }

  // The text that came first stays as it is. The `target.customize`
  // does nothing, as for two devices, and the part that was to go on
  // from what it would have made has nothing to go after: it is
  // refused, with its text, and not put at the end of the other text.
  expect(textsOf(workspace, targetId)).toEqual(["New"]);
  expect(refused).toEqual(["part.add: not_found"]);
});

it("refuses to remove the only part of the text of an account", () => {
  const workspace = customized();
  workspace.mutate("part.remove", { id: otherOwnPartId });

  // The post has three parts in all, and this text has one.
  expect(
    rejectionOf(() => workspace.mutate("part.remove", { id: ownPartId })),
  ).toBe("last_part");
});

it("gives an account the post's text again", () => {
  const workspace = customized();

  workspace.mutate("target.followPost", { postId, channelId }, 4000);
  // Two devices can do so.
  workspace.mutate("target.followPost", { postId, channelId }, 5000);

  expect(textsOf(workspace, targetId)).toEqual([]);
  expect(textsOf(workspace)).toEqual(["One", "Two"]);
  expect(workspace.rows("post_target")).toHaveLength(1);
  expect(workspace.rows("post")[0]?.updatedAt).toBe(4000);
});

it.each([
  ["target.remove", { postId, channelId }, "client"],
  ["channel.disconnect", { id: channelId }, "server"],
  ["post.delete", { id: postId }, "client"],
] as const)(
  "takes the text of an account away with %s",
  (name, args, source) => {
    const workspace = customized();

    workspace.mutate(name, args, 4000, source);

    // A part that names a target which is gone would be a text that nobody
    // gets and nothing removes.
    expect(textsOf(workspace, targetId)).toEqual([]);
    expect(workspace.rows("post_target")).toEqual([]);
  },
);

it("records what a delivery has published by the parts that its account gets", () => {
  const workspace = customized();
  workspace.mutate("target.add", {
    id: otherTargetId,
    postId,
    channelId: otherChannelId,
  });
  workspace.mutate("post.publish", { id: postId }, 4000);
  workspace.mutate("target.start", { id: targetId }, 5000, "server");
  workspace.mutate("target.start", { id: otherTargetId }, 5001, "server");
  const report = (id: string, results: string[]) =>
    workspace.mutate(
      "target.progress",
      {
        id,
        attempt: 1,
        parts: results.map((result) => ({
          id: result,
          remoteId: result,
          url: null,
        })),
      },
      6000,
      "server",
    );

  report(targetId, [resultId, otherResultId]);
  report(otherTargetId, [thirdPartId, fourthPartId]);

  // Each result names the part that was published there: the account's
  // own for the one, the post's for the other.
  expect(
    workspace
      .rows("target_part_result")
      .map(({ targetId: target, partId: part }) => [target, part]),
  ).toEqual([
    [targetId, ownPartId],
    [targetId, otherOwnPartId],
    [otherTargetId, partId],
    [otherTargetId, otherPartId],
  ]);
});
// Notifications: what the inbox says of posts and channels.

const failed = {
  id: targetId,
  attempt: 1,
  status: "error",
  error: "The network refused the post.",
  refusedConnection: null,
} as const;

/** The notification that the inbox has of the post, made at `at`. */
const ofPost = (at: number, readAt: number | null = null) => ({
  id: postId,
  kind: "post_failed",
  postId,
  channelId: null,
  createdAt: at,
  readAt,
});

/** `sending()`, with the post going to both accounts, both under way. */
function sendingToTwo() {
  const workspace = withTarget();
  workspace.mutate(
    "target.add",
    { id: otherTargetId, postId, channelId: otherChannelId },
    2500,
  );
  workspace.mutate("post.publish", { id: postId }, 3000);
  workspace.mutate("target.start", { id: targetId }, 4000, "server");
  workspace.mutate("target.start", { id: otherTargetId }, 4001, "server");
  return workspace;
}

it("tells the inbox of a post whose delivery has failed", () => {
  const workspace = sending();

  workspace.mutate("target.end", failed, 5000, "server");

  expect(workspace.rows("notification")).toEqual([ofPost(5000)]);
});

it("tells the inbox of a post whose delivery nobody knows the end of", () => {
  const workspace = sending();

  workspace.mutate(
    "target.end",
    { ...failed, status: "uncertain" },
    5000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([ofPost(5000)]);
});

it("says nothing of a post that has arrived", () => {
  const workspace = sending();

  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 1, status: "sent" },
    5000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([]);
});

it("tells the inbox of a post once, when the last of its deliveries has ended", () => {
  const workspace = sendingToTwo();

  workspace.mutate("target.end", failed, 5000, "server");
  // The other delivery is still under way: the post has not ended, and
  // how it ends is said in one notification, not in one per delivery.
  expect(workspace.rows("notification")).toEqual([]);

  workspace.mutate(
    "target.end",
    { ...failed, id: otherTargetId },
    6000,
    "server",
  );
  expect(workspace.rows("notification")).toEqual([ofPost(6000)]);
});

it("tells the inbox of a post that arrived only in part", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");

  workspace.mutate(
    "target.end",
    { id: otherTargetId, attempt: 1, status: "sent" },
    6000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([ofPost(6000)]);
});

it("takes the notification of a post back while the post is tried again, and tells anew if it fails again", () => {
  const workspace = sending();
  workspace.mutate("target.end", failed, 5000, "server");
  workspace.mutate(
    "notification.read",
    { notifications: [{ id: postId, createdAt: 5000 }] },
    5500,
  );

  workspace.mutate("target.retry", { id: targetId }, 6000);
  // The post is on its way: that it failed is no longer what is so.
  expect(workspace.rows("notification")).toEqual([]);

  workspace.mutate("target.start", { id: targetId }, 6500, "server");
  workspace.mutate("target.end", { ...failed, attempt: 2 }, 7000, "server");
  // Unread again: it is news, though the person had read the first.
  expect(workspace.rows("notification")).toEqual([ofPost(7000)]);
});

it("takes the notification of a post away when a later try arrives", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");
  workspace.mutate(
    "target.end",
    { id: otherTargetId, attempt: 1, status: "sent" },
    6000,
    "server",
  );
  workspace.mutate("target.retry", { id: targetId }, 7000);
  workspace.mutate("target.start", { id: targetId }, 7500, "server");

  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 2, status: "sent" },
    8000,
    "server",
  );

  expect(statusOf(workspace)).toBe("sent");
  expect(workspace.rows("notification")).toEqual([]);
});

it("deletes the notification of a post with the post", () => {
  const workspace = sending();
  workspace.mutate("target.end", failed, 5000, "server");

  workspace.mutate("post.delete", { id: postId }, 6000);

  expect(workspace.rows("notification")).toEqual([]);
});

it("says nothing in the inbox of a post that failed because its account was disconnected", () => {
  const workspace = sending();

  // The person has done that themselves, a moment ago.
  workspace.mutate("channel.disconnect", { id: channelId }, 5000, "server");

  expect(statusOf(workspace)).toBe("error");
  expect(workspace.rows("notification")).toEqual([]);
});

/** Whether each target of the post ended by a disconnect, by its ID. */
const disconnectedOf = (workspace: ReturnType<typeof memoryWorkspace>) =>
  Object.fromEntries(
    workspace
      .rows("post_target")
      .map(({ id, disconnected }) => [id, disconnected]),
  );

it("says nothing anew of a failure that the person was told of, when the delivery that they tried again arrives", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");
  workspace.mutate(
    "target.end",
    { ...failed, id: otherTargetId },
    6000,
    "server",
  );
  expect(workspace.rows("notification")).toEqual([ofPost(6000)]);

  // The person tries one of the two again, and that one arrives.
  workspace.mutate("target.retry", { id: targetId }, 7000);
  workspace.mutate("target.start", { id: targetId }, 7500, "server");
  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 2, status: "sent" },
    8000,
    "server",
  );

  // The post is in `error` for the other delivery, which failed before
  // and which the person left alone. Nothing has gone wrong since they
  // were told: "A post was not sent" right after the try that worked
  // would be about that one.
  expect(statusOf(workspace)).toBe("error");
  expect(workspace.rows("notification")).toEqual([]);
});

it("tells the inbox anew when the delivery that was tried again fails again, next to one that failed before", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");
  workspace.mutate(
    "target.end",
    { ...failed, id: otherTargetId },
    6000,
    "server",
  );
  workspace.mutate("target.retry", { id: targetId }, 7000);
  workspace.mutate("target.start", { id: targetId }, 7500, "server");

  workspace.mutate("target.end", { ...failed, attempt: 2 }, 8000, "server");

  expect(workspace.rows("notification")).toEqual([ofPost(8000)]);
});

it("tells the inbox of a delivery that failed and was tried again while another was still under way", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");
  // The post has not ended, so this try belongs to the same sending.
  workspace.mutate("target.retry", { id: targetId }, 5500);
  workspace.mutate("target.start", { id: targetId }, 5600, "server");
  workspace.mutate(
    "target.end",
    { id: otherTargetId, attempt: 1, status: "sent" },
    6000,
    "server",
  );
  expect(workspace.rows("notification")).toEqual([]);

  workspace.mutate("target.end", { ...failed, attempt: 2 }, 7000, "server");

  expect(workspace.rows("notification")).toEqual([ofPost(7000)]);
});

it("says nothing in the inbox of a post whose other account the person disconnected while it was sent", () => {
  const workspace = sendingToTwo();
  workspace.mutate(
    "channel.disconnect",
    { id: otherChannelId },
    5000,
    "server",
  );
  // The target says that it ended so, which is what tells it from one
  // that failed by itself.
  expect(disconnectedOf(workspace)).toEqual({
    [targetId]: false,
    [otherTargetId]: true,
  });

  workspace.mutate(
    "target.end",
    { id: targetId, attempt: 1, status: "sent" },
    6000,
    "server",
  );

  // The post has not arrived everywhere, because of what the person did
  // themselves: nothing failed.
  expect(statusOf(workspace)).toBe("error");
  expect(workspace.rows("notification")).toEqual([]);
});

it("tells the inbox of a delivery that failed by itself when the last one ends because its account is disconnected", () => {
  const workspace = sendingToTwo();
  workspace.mutate("target.end", failed, 5000, "server");
  expect(workspace.rows("notification")).toEqual([]);

  // What ends the post is the disconnect, and what the person has not
  // heard of is the failure before it.
  workspace.mutate(
    "channel.disconnect",
    { id: otherChannelId },
    6000,
    "server",
  );

  expect(statusOf(workspace)).toBe("error");
  expect(workspace.rows("notification")).toEqual([ofPost(6000)]);
});

it("tells the inbox that a channel needs connecting again when its network would not renew its access", () => {
  const workspace = withTarget();

  workspace.mutate(
    "channel.lapse",
    { id: channelId, connectedAt: 1000 },
    5000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([
    {
      id: channelId,
      kind: "channel_needs_reconnect",
      postId: null,
      channelId,
      createdAt: 5000,
      readAt: null,
    },
  ]);
});

it("says nothing of a channel that was connected again before its network's refusal to renew was recorded", () => {
  const workspace = withTarget();
  workspace.mutate("channel.connect", account(), 4500, "server");

  workspace.mutate(
    "channel.lapse",
    { id: channelId, connectedAt: 1000 },
    5000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([]);
});

it("tells the inbox that a channel needs connecting again, next to the post that found out", () => {
  const workspace = sending();

  workspace.mutate(
    "target.end",
    { ...failed, refusedConnection: 1000 },
    5000,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([
    {
      id: channelId,
      kind: "channel_needs_reconnect",
      postId: null,
      channelId,
      createdAt: 5000,
      readAt: null,
    },
    ofPost(5000),
  ]);
});

it("says nothing of a channel that was connected again before its refusal was recorded", () => {
  const workspace = sending();
  workspace.mutate("channel.connect", account(), 4500, "server");

  workspace.mutate(
    "target.end",
    { ...failed, refusedConnection: 1000 },
    5000,
    "server",
  );

  // Only the post: the channel has an access that nothing has refused.
  expect(workspace.rows("notification")).toEqual([ofPost(5000)]);
});

it.each([
  ["connected again", "channel.connect", account()],
  ["disconnected", "channel.disconnect", { id: channelId }],
])(
  "takes the notification of a channel away when the channel is %s",
  (_how, name, args) => {
    const workspace = sending();
    workspace.mutate(
      "target.end",
      { ...failed, refusedConnection: 1000 },
      5000,
      "server",
    );

    workspace.mutate(name, args, 6000, "server");

    // What is left is about the post, which is still not sent.
    expect(workspace.rows("notification")).toEqual([ofPost(5000)]);
  },
);

const week = 7 * 24 * 60 * 60 * 1000;

/** A workspace with a channel whose access ends at `expiresAt`. */
function withAccessUntil(expiresAt: number | null) {
  const workspace = memoryWorkspace();
  workspace.mutate("channel.connect", account({ expiresAt }), 1000, "server");
  return workspace;
}

it("tells the inbox that the access of a channel ends within a week", () => {
  const workspace = withAccessUntil(10 * week);

  workspace.mutate(
    "channel.warnOfExpiry",
    { id: channelId },
    9 * week,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([
    {
      id: channelId,
      kind: "channel_expiring",
      postId: null,
      channelId,
      createdAt: 9 * week,
      readAt: null,
    },
  ]);
});

it.each([
  ["does not end", null, 9 * week],
  ["ends later than in a week", 10 * week, 9 * week - 1],
  ["has ended", 10 * week, 10 * week],
])("says nothing of an access that %s", (_what, expiresAt, now) => {
  const workspace = withAccessUntil(expiresAt);

  workspace.mutate("channel.warnOfExpiry", { id: channelId }, now, "server");

  expect(workspace.rows("notification")).toEqual([]);
});

it("does not put a reminder in the place of the word that a channel needs connecting again", () => {
  const workspace = withAccessUntil(10 * week);
  const [connected] = workspace.rows("channel");
  if (!connected) throw new Error("The channel is not there");
  workspace.put("channel", { ...connected, status: "needs_reconnect" });

  workspace.mutate(
    "channel.warnOfExpiry",
    { id: channelId },
    9 * week,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([]);
});

it("takes the reminder away when the access is renewed", () => {
  const workspace = withAccessUntil(10 * week);
  workspace.mutate(
    "channel.warnOfExpiry",
    { id: channelId },
    9 * week,
    "server",
  );

  workspace.mutate(
    "channel.renew",
    { id: channelId, expiresAt: 20 * week },
    9 * week + 1,
    "server",
  );

  expect(workspace.rows("notification")).toEqual([]);
});

it("marks notifications as read, and leaves the time of one that was read before", () => {
  const workspace = sending();
  workspace.mutate(
    "target.end",
    { ...failed, refusedConnection: 1000 },
    5000,
    "server",
  );
  workspace.mutate(
    "notification.read",
    { notifications: [{ id: postId, createdAt: 5000 }] },
    6000,
  );

  // Both, as "mark all read" on a device that has not heard of the first
  // reading, and one that is gone, which another device has dismissed.
  workspace.mutate(
    "notification.read",
    {
      notifications: [postId, channelId, otherPostId].map((id) => ({
        id,
        createdAt: 5000,
      })),
    },
    7000,
  );

  expect(
    workspace.rows("notification").map(({ id, readAt }) => [id, readAt]),
  ).toEqual([
    [channelId, 7000],
    [postId, 6000],
  ]);
});

it("dismisses a notification, and leaves what it was about", () => {
  const workspace = sending();
  workspace.mutate("target.end", failed, 5000, "server");

  workspace.mutate(
    "notification.dismiss",
    { id: postId, createdAt: 5000 },
    6000,
  );
  // A second device does the same: nothing to do, and no refusal.
  workspace.mutate(
    "notification.dismiss",
    { id: postId, createdAt: 5000 },
    6001,
  );

  expect(workspace.rows("notification")).toEqual([]);
  expect(statusOf(workspace)).toBe("error");
});

/**
 * A post that failed, was tried again and failed again: the inbox has a
 * second notification about it, under the same ID, made at 7000. A device
 * that was away since the first one has seen the one of 5000.
 */
function failedTwice() {
  const workspace = sending();
  workspace.mutate("target.end", failed, 5000, "server");
  workspace.mutate("target.retry", { id: targetId }, 6000);
  workspace.mutate("target.start", { id: targetId }, 6500, "server");
  workspace.mutate("target.end", { ...failed, attempt: 2 }, 7000, "server");
  return workspace;
}

it("does not dismiss a notification that came after the one that the device saw", () => {
  const workspace = failedTwice();

  // The device dismissed the first one while it was offline.
  workspace.mutate(
    "notification.dismiss",
    { id: postId, createdAt: 5000 },
    8000,
  );

  // The second is news that nobody has seen: it stays, unread.
  expect(workspace.rows("notification")).toEqual([ofPost(7000)]);

  // Dismissed as it is now, it goes.
  workspace.mutate(
    "notification.dismiss",
    { id: postId, createdAt: 7000 },
    8001,
  );
  expect(workspace.rows("notification")).toEqual([]);
});

it("does not mark a notification as read that came after the one that the device saw", () => {
  const workspace = failedTwice();

  workspace.mutate(
    "notification.read",
    { notifications: [{ id: postId, createdAt: 5000 }] },
    8000,
  );

  expect(workspace.rows("notification")).toEqual([ofPost(7000)]);

  workspace.mutate(
    "notification.read",
    { notifications: [{ id: postId, createdAt: 7000 }] },
    8001,
  );
  expect(workspace.rows("notification")).toEqual([ofPost(7000, 8001)]);
});

it("removes the notifications that the server names as old", () => {
  const workspace = sending();
  workspace.mutate(
    "target.end",
    { ...failed, refusedConnection: 1000 },
    5000,
    "server",
  );

  workspace.mutate("notification.prune", { ids: [postId] }, 6000, "server");

  expect(workspace.rows("notification").map(({ id }) => id)).toEqual([
    channelId,
  ]);
});

it.each([
  ["channel.warnOfExpiry", { id: channelId }],
  ["notification.prune", { ids: [postId] }],
])("refuses a client that sends %s", (name, args) => {
  const workspace = sending();

  expect(rejectionOf(() => workspace.mutate(name, args, 5000))).toBe(
    "not_allowed",
  );
});
