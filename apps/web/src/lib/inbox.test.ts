import { describe, expect, it } from "vitest";
import { inboxWords, selectInbox, selectUnread } from "./inbox.ts";
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
