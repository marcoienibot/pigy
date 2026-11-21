import { describe, expect, it } from "vitest";
import { audienceOf, compose, selectDraftTargets } from "@/lib/publish";
import {
  blueskyLimits,
  channel,
  post,
  tablesOf,
  target,
} from "@/lib/rows.test-support";

const mastodon = channel();
const bluesky = channel({
  network: "bluesky",
  handle: "@ada.bsky.test",
  limits: blueskyLimits,
});

describe("compose", () => {
  it("leads to connecting an account when there is none", () => {
    expect(compose("Hello", [], new Set())).toEqual({
      choices: [],
      chosen: 0,
      blocked: "no-channels",
    });
  });

  it("asks for a channel while none is chosen", () => {
    const composer = compose("Hello", [mastodon, bluesky], new Set());
    expect(composer.blocked).toBe("none-chosen");
    expect(composer.choices.map(({ chosen }) => chosen)).toEqual([
      false,
      false,
    ]);
  });

  it("offers to publish a text that every chosen account takes", () => {
    const composer = compose(
      "Hello",
      [mastodon, bluesky],
      new Set([bluesky.id]),
    );
    expect(composer).toMatchObject({ chosen: 1, blocked: null });
  });

  it("says that an empty draft cannot go out once, and not for every account", () => {
    const composer = compose(
      "  \n ",
      [mastodon, bluesky],
      new Set([mastodon.id, bluesky.id]),
    );
    expect(composer.blocked).toBe("empty");
    // validateContent would say "The post has no text." for each of them.
    expect(composer.choices.map(({ refuses }) => refuses)).toEqual([[], []]);
  });

  it("says which account refuses a text, by the counting of its own network", () => {
    // Too long for Bluesky's 300 characters, and within Mastodon's 500.
    const text = "a".repeat(400);
    const composer = compose(
      text,
      [mastodon, bluesky],
      new Set([mastodon.id, bluesky.id]),
    );
    expect(composer.blocked).toBe("refused");
    expect(composer.choices).toMatchObject([
      { channel: mastodon, refuses: [] },
      {
        channel: bluesky,
        refuses: ["The post is 400 characters long. The limit is 300."],
      },
    ]);
    // Without Bluesky, the post can go.
    expect(
      compose(text, [mastodon, bluesky], new Set([mastodon.id])).blocked,
    ).toBeNull();
  });

  it("counts a link as Mastodon does: as a fixed number of characters", () => {
    // 470 characters, a space and a link of 60 are 531 characters as they
    // are typed, and 494 as Mastodon counts them, with the link as 23: the
    // post fits. With 490 it is 514, which does not.
    const link = `https://example.com/${"x".repeat(40)}`;
    const fits = `${"a".repeat(470)} ${link}`;
    expect(
      compose(fits, [mastodon], new Set([mastodon.id])).blocked,
    ).toBeNull();
    const over = `${"a".repeat(490)} ${link}`;
    expect(
      compose(over, [mastodon], new Set([mastodon.id])).choices,
    ).toMatchObject([
      { refuses: ["The post is 514 characters long. The limit is 500."] },
    ]);
  });

  it("says when a text takes more bytes than Bluesky allows", () => {
    // 150 characters, each a family of four, which takes 25 bytes.
    const text = "👨‍👩‍👧‍👦".repeat(150);
    const [choice] = compose(text, [bluesky], new Set([bluesky.id])).choices;
    expect(choice?.refuses).toEqual([
      expect.stringContaining("takes 3750 bytes, which is more than the 3000"),
    ]);
  });

  it("does not refuse what it cannot check: an account whose limits are not known yet", () => {
    const unknown = channel({ limits: null, limitsCheckedAt: null });
    const composer = compose(
      "a".repeat(5000),
      [unknown],
      new Set([unknown.id]),
    );
    expect(composer).toMatchObject({
      blocked: null,
      choices: [{ refuses: [] }],
    });
  });

  it("marks an account that something keeps from taking the post: one that needs connecting again, or a chosen one that refuses the text", () => {
    const broken = channel({ status: "needs_reconnect" });
    const long = "a".repeat(400);
    const troubled = (chosen: string[]) =>
      compose(long, [mastodon, bluesky, broken], new Set(chosen)).choices.map(
        (choice) => choice.troubled,
      );
    // Bluesky would refuse the text, which matters once it is chosen. The
    // broken account cannot take a post whether or not it is chosen.
    expect(troubled([])).toEqual([false, false, true]);
    expect(troubled([mastodon.id, bluesky.id])).toEqual([false, true, true]);
  });

  it("does not publish to an account that needs connecting again", () => {
    const broken = channel({ status: "needs_reconnect" });
    expect(compose("Hello", [broken], new Set()).choices).toMatchObject([
      { needsReconnect: true, chosen: false },
    ]);
    // Chosen before it broke: the post waits until it is connected again
    // or left out. That comes before what it would refuse.
    expect(
      compose("a".repeat(600), [broken], new Set([broken.id])).blocked,
    ).toBe("needs-reconnect");
  });
});

describe("selectDraftTargets", () => {
  it("has the chosen channels of every draft, and nothing of a post that went out", () => {
    const draft = post();
    const sent = post({ status: "sent" });
    const tables = tablesOf({
      post: [draft, sent],
      channel: [mastodon, bluesky],
      post_target: [
        target(draft.id, mastodon.id),
        target(draft.id, bluesky.id),
        target(sent.id, mastodon.id, { status: "sent" }),
      ],
    });
    const chosen = selectDraftTargets(tables);
    expect(chosen.get(draft.id)).toEqual(new Set([mastodon.id, bluesky.id]));
    expect(chosen.has(sent.id)).toBe(false);
  });
});

describe("audienceOf", () => {
  it("names the one account, and counts several", () => {
    const one = compose("Hi", [mastodon, bluesky], new Set([bluesky.id]));
    expect(audienceOf(one.choices)).toBe("@ada.bsky.test");
    const both = compose(
      "Hi",
      [mastodon, bluesky],
      new Set([mastodon.id, bluesky.id]),
    );
    expect(audienceOf(both.choices)).toBe("2 accounts");
  });
});
