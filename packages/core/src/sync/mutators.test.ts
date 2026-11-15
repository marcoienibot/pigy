import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { MutationRejected, type RejectionCode } from "./mutators.ts";
import { maxPartTextLength, postStatuses } from "./tables.ts";

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
    { id: partId, postId, position: 0, text: "Hello" },
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
    { id: partId, postId, position: 0, text: "First" },
  ]);
});

it("replaces the text of a part and notes when the post changed", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);

  workspace.mutate("part.setText", { id: partId, text: "Hello, world" }, 5000);

  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, position: 0, text: "Hello, world" },
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
  // A second part, as a thread has. No mutator adds one yet.
  workspace.put("post_part", {
    id: "01932c07-0000-7000-8000-000000000005",
    postId,
    position: 1,
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
  "post.publish",
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
