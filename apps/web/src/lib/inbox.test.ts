import { describe, expect, it } from "vitest";
import { inboxWords, readAll, selectInbox, selectUnread } from "./inbox.ts";
import {
  channel,
  id,
  part,
  post,
  tablesOf,
  target,
} from "./rows.test-support.ts";

const now = Date.UTC(2026, 10, 14, 10);
const day = 24 * 60 * 60 * 1000;

/** The notification of the inbox about `postId`. */
const ofPost = (postId: string, fields = {}) => ({
  id: postId,
  kind: "post_failed" as const,
  postId,
  channelId: null,
  createdAt: 1000,
  readAt: null,
  ...fields,
});

/** The notification of the inbox about the channel `channelId`. */
const ofChannel = (
  channelId: string,
  kind: "channel_needs_reconnect" | "channel_expiring",
  fields = {},
) => ({
  id: channelId,
  kind,
  postId: null,
  channelId,
  createdAt: 1000,
  readAt: null,
  ...fields,
});

/** A post that went to `statuses.length` accounts, which ended so. */
function ended(...statuses: ("sent" | "error" | "uncertain")[]) {
  const failed = post({ status: "error" });
  const channels = statuses.map((_, index) =>
    channel({ accountId: String(index), handle: `@account${index}` }),
  );
  return {
    failed,
    tables: tablesOf({
      post: [failed],
      post_part: [part(failed.id, { text: "Hello, world" })],
      channel: channels,
      post_target: statuses.map((status, index) =>
        target(failed.id, channels[index]?.id ?? "", { status }),
      ),
      notification: [ofPost(failed.id)],
    }),
  };
}

const wordsOf = (tables: ReturnType<typeof tablesOf>) =>
  selectInbox(tables).map((item) => inboxWords(item, now));

describe("the inbox", () => {
  it("lists the notifications, the newest first", () => {
    const first = post({ status: "error" });
    const second = post({ status: "error" });
    const tables = tablesOf({
      post: [first, second],
      notification: [
        ofPost(first.id, { createdAt: 1000 }),
        ofPost(second.id, { createdAt: 2000 }),
      ],
    });

    expect(selectInbox(tables).map(({ id }) => id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("counts what is not read", () => {
    const first = post({ status: "error" });
    const second = post({ status: "error" });
    const tables = tablesOf({
      post: [first, second],
      notification: [ofPost(first.id, { readAt: 1500 }), ofPost(second.id)],
    });

    expect(selectUnread(tables)).toBe(1);
    expect(selectInbox(tables).map(({ unread }) => unread)).toEqual([
      true,
      false,
    ]);
  });

  it("leaves out a notification whose post or channel the copy does not have", () => {
    // A patch can bring one before the other, in either direction.
    const tables = tablesOf({
      notification: [ofPost(id()), ofChannel(id(), "channel_expiring")],
    });

    expect(selectInbox(tables)).toEqual([]);
    expect(selectUnread(tables)).toBe(0);
  });

  it("counts the unread ones about posts and about channels, and only those that it shows", () => {
    const failed = post({ status: "error" });
    const account = channel();
    const tables = tablesOf({
      post: [failed],
      channel: [account],
      notification: [
        ofPost(failed.id),
        ofChannel(account.id, "channel_needs_reconnect"),
        // Unread, and about a post and a channel that the copy lacks.
        ofPost(id()),
        ofChannel(id(), "channel_expiring"),
        // Read.
        ofPost(post({ status: "error" }).id, { readAt: 1500 }),
      ],
    });

    expect(selectUnread(tables)).toBe(2);
    // The count is what the list has, which is made another way.
    expect(selectInbox(tables).filter(({ unread }) => unread)).toHaveLength(2);
  });

  it("shows the first part of the post's own text and the deliveries of each post, with many posts in the inbox", () => {
    // The parts and the targets of all posts are found in one pass, so
    // each has to end up with its own post.
    const posts = [post({ status: "error" }), post({ status: "error" })];
    const account = channel({ handle: "@ada" });
    const [first, second] = posts.map(({ id: postId }, index) => ({
      targetId: target(postId, account.id, { status: "error" }),
      parts: [
        part(postId, { text: `Second part ${index}`, position: 1 }),
        part(postId, { text: `First part ${index}`, position: 0 }),
      ],
    }));
    const tables = tablesOf({
      post: posts,
      channel: [account],
      post_part: [...(first?.parts ?? []), ...(second?.parts ?? [])],
      post_target: [first?.targetId, second?.targetId].filter(
        (row) => row !== undefined,
      ),
      notification: posts.map(({ id: postId }, index) =>
        ofPost(postId, { createdAt: 1000 + index }),
      ),
    });

    expect(
      selectInbox(tables).map((item) =>
        item.kind === "post_failed"
          ? [item.text, item.deliveries.length]
          : null,
      ),
    ).toEqual([
      ["First part 1", 1],
      ["First part 0", 1],
    ]);
  });
});

describe("a scheduled post that was held", () => {
  /** A post that the server holds, with the notification that says so. */
  function held() {
    const late = post({
      status: "scheduled",
      mode: "custom",
      dueAt: 500,
      heldAt: 1000,
    });
    const account = channel({ handle: "@ada" });
    return {
      late,
      tables: tablesOf({
        post: [late],
        // The text of an account is not what the inbox quotes.
        post_part: [
          part(late.id, { text: "Second", position: 1 }),
          part(late.id, { text: "Out on Monday", position: 0 }),
        ],
        channel: [account],
        // Not sent yet: its target has no outcome to tell of.
        post_target: [target(late.id, account.id, { status: "pending" })],
        notification: [ofPost(late.id, { kind: "post_held" as const })],
      }),
    };
  }

  it("is in the inbox with the words of the post, and counts as unread", () => {
    const { tables, late } = held();

    expect(selectInbox(tables)).toEqual([
      {
        id: late.id,
        kind: "post_held",
        postId: late.id,
        text: "Out on Monday",
        createdAt: 1000,
        unread: true,
      },
    ]);
    expect(selectUnread(tables)).toBe(1);
  });

  it("says that the post missed its time, and offers the queue, where it is decided", () => {
    const { tables } = held();

    // Not the words of a post that failed: nothing was sent, and no
    // account refused anything.
    expect(wordsOf(tables)).toEqual([
      {
        title: "A scheduled post missed its time and was not sent",
        detail: "Out on Monday",
        action: "Decide in the queue",
      },
    ]);
  });

  it("is left out while the copy does not have the post", () => {
    const tables = tablesOf({
      notification: [ofPost(id(), { kind: "post_held" as const })],
    });

    expect(selectInbox(tables)).toEqual([]);
    expect(selectUnread(tables)).toBe(0);
  });
});

describe("marking all as read", () => {
  it("names every unread notification as it was seen, in mutations of a hundred at most", () => {
    const posts = Array.from({ length: 102 }, () => post({ status: "error" }));
    const tables = tablesOf({
      post: posts,
      notification: posts.map(({ id: postId }, index) =>
        // One is read already, which leaves 101.
        ofPost(postId, {
          createdAt: 1000 + index,
          readAt: index === 0 ? 1500 : null,
        }),
      ),
    });

    const mutations = readAll(selectInbox(tables));

    // The mutator takes a hundred at once: the 101st goes in a second.
    expect(mutations.map(({ notifications }) => notifications.length)).toEqual([
      100, 1,
    ]);
    const named = mutations.flatMap(({ notifications }) => notifications);
    expect(new Set(named.map(({ id: named }) => named)).size).toBe(101);
    // Each with the time that the device saw, which is what keeps a
    // newer notification under the same ID from being read by this.
    expect(named).toContainEqual({ id: posts[1]?.id, createdAt: 1001 });
    expect(named).not.toContainEqual(
      expect.objectContaining({ id: posts[0]?.id }),
    );
  });

  it("makes no mutation when everything is read", () => {
    const failed = post({ status: "error" });
    const tables = tablesOf({
      post: [failed],
      notification: [ofPost(failed.id, { readAt: 1500 })],
    });

    expect(readAll(selectInbox(tables))).toEqual([]);
  });
});

describe("what a notification says", () => {
  it("names the account that a post did not reach, with the words of the post", () => {
    const { tables, failed } = ended("error");

    expect(wordsOf(tables)).toEqual([
      {
        title: "A post was not sent to @account0",
        detail: "Hello, world",
        action: "See the post",
      },
    ]);
    expect(selectInbox(tables)[0]).toMatchObject({ postId: failed.id });
  });

  it("names only the accounts that a post did not reach", () => {
    const { tables } = ended("sent", "error", "uncertain");

    expect(wordsOf(tables)[0]?.title).toBe(
      "A post was not sent to @account1 and @account2",
    );
  });

  it("counts the accounts beyond the first two when there are many", () => {
    const { tables } = ended("error", "error", "error", "error");

    expect(wordsOf(tables)[0]?.title).toBe(
      "A post was not sent to @account0, @account1 and 2 more",
    );
  });

  it("says that nobody knows where a post ended when nothing is known to have failed", () => {
    const { tables } = ended("sent", "uncertain");

    expect(wordsOf(tables)[0]?.title).toBe(
      "pigy cannot tell whether a post reached @account1",
    );
  });

  it("says so of an account that was disconnected since", () => {
    const failed = post({ status: "error" });
    const tables = tablesOf({
      post: [failed],
      post_target: [target(failed.id, id(), { status: "error" })],
      notification: [ofPost(failed.id)],
    });

    expect(wordsOf(tables)[0]).toMatchObject({
      title: "A post was not sent to an account that is no longer connected",
      detail: "Empty post",
    });
  });

  it("says that an account needs connecting again, and by which network", () => {
    const broken = channel({ status: "needs_reconnect" });
    const tables = tablesOf({
      channel: [broken],
      notification: [ofChannel(broken.id, "channel_needs_reconnect")],
    });

    expect(wordsOf(tables)).toEqual([
      {
        title: "pigy can no longer post to @ada@mastodon.example",
        detail:
          "Mastodon no longer takes the access that pigy was given. Connect the account again to go on posting.",
        action: "Connect again",
      },
    ]);
  });

  it("says when an access ends, and names an account of LinkedIn with its network", () => {
    const member = channel({
      network: "linkedin",
      handle: "Ada Lovelace",
      name: "Ada Lovelace",
      expiresAt: now + 7 * day,
    });
    const tables = tablesOf({
      channel: [member],
      notification: [ofChannel(member.id, "channel_expiring")],
    });

    const [words] = wordsOf(tables);
    expect(words?.title).toBe(
      "pigy's access to Ada Lovelace on LinkedIn is about to end",
    );
    // The day, in the words of the device.
    expect(words?.detail).toMatch(
      /^It ends on .*21.*, and LinkedIn does not let pigy renew it\./,
    );
  });

  it("says of an access that pigy renews that it could not, and when it ends", () => {
    const account = channel({
      network: "threads",
      handle: "@ada",
      name: "Ada",
      expiresAt: now + 6 * day,
    });
    const tables = tablesOf({
      channel: [account],
      notification: [ofChannel(account.id, "channel_expiring")],
    });

    // Not that Threads does not let pigy renew: it does, every week.
    expect(wordsOf(tables)[0]?.detail).toMatch(
      /^pigy could not renew it, and it ends on .*20.*\. Connect the account again before then/,
    );
  });

  it("says that an access has ended once it has", () => {
    const member = channel({ network: "linkedin", expiresAt: now - 1 });
    const tables = tablesOf({
      channel: [member],
      notification: [ofChannel(member.id, "channel_expiring")],
    });

    expect(wordsOf(tables)[0]?.detail).toBe(
      "It has ended: connect the account again to go on posting.",
    );
  });
});
