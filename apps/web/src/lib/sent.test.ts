import { describe, expect, it } from "vitest";
import {
  channel,
  part,
  post,
  result,
  tablesOf,
  target,
} from "@/lib/rows.test-support";
import {
  canDelete,
  postStatusWords,
  selectSent,
  targetExplanation,
} from "@/lib/sent";

const ada = channel({ handle: "@ada@mastodon.example" });
const grace = channel({ handle: "@grace@mastodon.example" });
const bluesky = channel({ network: "bluesky", handle: "@ada.bsky.test" });

describe("selectSent", () => {
  it("lists what was published, the one published last first, and no draft", () => {
    const draft = post();
    const older = post({ status: "sent", updatedAt: 900 });
    const newer = post({ status: "sending", updatedAt: 100 });
    const sent = selectSent(
      tablesOf({
        post: [draft, older, newer],
        post_part: [part(draft.id), part(older.id), part(newer.id)],
        channel: [ada],
        post_target: [
          target(draft.id, ada.id),
          target(older.id, ada.id, { status: "sent", queuedAt: 10 }),
          target(newer.id, ada.id, { status: "queued", queuedAt: 20 }),
        ],
      }),
    );
    // By when they were published, not by when they last changed: a
    // delivery that ends changes its post, which would move it up.
    expect(sent.map(({ id }) => id)).toEqual([newer.id, older.id]);
  });

  it("counts a post from the first of its targets, which a retry of another does not move", () => {
    const first = post({ status: "sending" });
    const second = post({ status: "sent" });
    const sent = selectSent(
      tablesOf({
        post: [first, second],
        post_part: [part(first.id), part(second.id)],
        channel: [ada, grace],
        post_target: [
          target(first.id, ada.id, { status: "sent", queuedAt: 10 }),
          // Tried again later than the second post was published.
          target(first.id, grace.id, { status: "queued", queuedAt: 50 }),
          target(second.id, ada.id, { status: "sent", queuedAt: 20 }),
        ],
      }),
    );
    expect(sent.map(({ id, publishedAt }) => [id, publishedAt])).toEqual([
      [second.id, 20],
      [first.id, 10],
    ]);
  });

  it("lists the targets in the order of their channels, a disconnected one last and not to be tried again", () => {
    const published = post({ status: "error" });
    const gone = target(published.id, "01900000-0000-7000-8000-0000000fffff", {
      status: "error",
      error: "The account was disconnected before the post was sent.",
      queuedAt: 1,
    });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [grace, bluesky, ada],
        post_target: [
          gone,
          target(published.id, grace.id, { status: "error", queuedAt: 1 }),
          target(published.id, ada.id, { status: "sent", queuedAt: 1 }),
          target(published.id, bluesky.id, {
            status: "uncertain",
            queuedAt: 1,
          }),
        ],
      }),
    );
    // By network as the Channels screen lists them, Mastodon first, and by
    // handle within a network. A delivery that was sent has nothing to try
    // again.
    expect(
      item?.targets.map((one) => [one.channel?.handle ?? null, one.canRetry]),
    ).toEqual([
      ["@ada@mastodon.example", false],
      ["@grace@mastodon.example", true],
      ["@ada.bsky.test", true],
      [null, false],
    ]);
  });

  it("does not offer to try again for an account that needs connecting again", () => {
    const broken = channel({ status: "needs_reconnect" });
    const published = post({ status: "error" });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [broken],
        post_target: [
          target(published.id, broken.id, { status: "error", queuedAt: 1 }),
        ],
      }),
    );
    // It would fail at once, without asking the network: what is offered
    // is to connect the account again.
    expect(item?.targets[0]).toMatchObject({
      canRetry: false,
      reconnect: true,
    });
  });

  it("asks to connect an account again only for a delivery that failed", () => {
    const broken = channel({ status: "needs_reconnect" });
    const published = post({ status: "error" });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [broken, grace],
        post_target: [
          // Sent before the account broke: nothing is left to try.
          target(published.id, broken.id, { status: "sent", queuedAt: 1 }),
          // Failed for another reason, at an account that works.
          target(published.id, grace.id, { status: "error", queuedAt: 1 }),
        ],
      }),
    );
    expect(item?.targets.map((one) => one.reconnect)).toEqual([false, false]);
  });

  it("has the published parts of a thread in the order of the post", () => {
    const thread = post({ status: "sending" });
    const first = part(thread.id, { position: 0, text: "One" });
    const second = part(thread.id, { position: 1, text: "Two" });
    const delivery = target(thread.id, ada.id, {
      status: "sending",
      queuedAt: 1,
    });
    const [item] = selectSent(
      tablesOf({
        post: [thread],
        post_part: [second, first],
        channel: [ada],
        post_target: [delivery],
        target_part_result: [
          result(delivery.id, second.id, { remoteId: "2" }),
          result(delivery.id, first.id, { remoteId: "1" }),
          // Of a part that the post no longer has: nowhere to show it.
          result(delivery.id, "01900000-0000-7000-8000-0000000eeeee", {
            remoteId: "3",
          }),
        ],
      }),
    );
    expect(item?.parts.map(({ text }) => text)).toEqual(["One", "Two"]);
    expect(item?.targets[0]?.published.map(({ remoteId }) => remoteId)).toEqual(
      ["1", "2"],
    );
  });
});

describe("postStatusWords", () => {
  const of = (status: "sending" | "sent" | "error", targets: string[]) => {
    const published = post({ status });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [ada, grace],
        post_target: targets.map((targetStatus, index) =>
          target(published.id, index === 0 ? ada.id : grace.id, {
            status: targetStatus as "sent",
            queuedAt: 1,
          }),
        ),
      }),
    );
    if (!item) throw new Error("The post is not listed");
    return item;
  };

  it("says that a post arrived in part when some of its targets did", () => {
    expect(postStatusWords(of("error", ["sent", "error"])).label).toBe(
      "Partly sent",
    );
    expect(postStatusWords(of("error", ["uncertain", "error"])).label).toBe(
      "Failed",
    );
  });

  it("offers to delete a post once it has ended, and not while it is sent", () => {
    expect(canDelete(of("sending", ["sending"]))).toBe(false);
    expect(canDelete(of("error", ["error"]))).toBe(true);
    expect(canDelete(of("sent", ["sent"]))).toBe(true);
  });
});

describe("targetExplanation", () => {
  /** What the screen says under an unknown delivery to `to`. */
  const unknownTo = (to: ReturnType<typeof channel>) => {
    const published = post({ status: "error" });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [to],
        post_target: [
          target(published.id, to.id, { status: "uncertain", queuedAt: 1 }),
        ],
      }),
    );
    const [unknown] = item?.targets ?? [];
    return unknown ? targetExplanation(unknown) : null;
  };

  it("says of an unknown delivery to LinkedIn that LinkedIn gives pigy no way to look, which the other networks do", () => {
    const linkedin = channel({
      network: "linkedin",
      handle: "Ada Lovelace",
      limits: { network: "linkedin", maxCharacters: 3000 },
    });
    expect(unknownTo(linkedin)).toContain("LinkedIn gives it no way to look");
    // On Mastodon pigy looks itself when it can: a delivery is unknown
    // there only when something went wrong in pigy.
    expect(unknownTo(channel())).not.toContain("no way to look");
    expect(unknownTo(channel())).toContain("Look at the account first");
  });
});
