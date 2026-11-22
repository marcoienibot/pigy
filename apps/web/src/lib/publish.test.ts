import { describe, expect, it } from "vitest";
import {
  audienceOf,
  blockedReason,
  compose as composeParts,
  gaugesOf,
  meterOf,
  ownTextsOf,
  partMetersOf,
  readersOf,
  selectDraftTargets,
  selectOwnTexts,
  wholeMetersOf,
} from "@/lib/publish";
import {
  blueskyLimits,
  channel,
  part,
  post,
  tablesOf,
  target,
} from "@/lib/rows.test-support";

/** `compose` for a post of one part, which is what most of these are. */
const compose = (
  text: string,
  ...rest: Parameters<typeof composeParts> extends [unknown, ...infer Rest]
    ? Rest
    : never
) => composeParts([{ text }], ...rest);

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
      emptyParts: [],
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

describe("compose, for a thread and for the text of one account", () => {
  const both = new Set([mastodon.id, bluesky.id]);

  it("says which part of a thread an account refuses", () => {
    // The second part is too long for Bluesky and fits Mastodon.
    const composer = composeParts(
      [{ text: "One" }, { text: "b".repeat(301) }],
      [mastodon, bluesky],
      both,
    );
    expect(composer.blocked).toBe("refused");
    expect(composer.choices.map(({ refuses }) => refuses)).toEqual([
      [],
      ["Part 2 is 301 characters long. The limit is 300."],
    ]);
  });

  it("names the empty parts of a thread once, for the draft", () => {
    const composer = composeParts(
      [{ text: "One" }, { text: " " }, { text: "Three" }, { text: "" }],
      [mastodon, bluesky],
      both,
    );
    expect(composer).toMatchObject({ blocked: "empty", emptyParts: [1, 3] });
    expect(composer.choices.map(({ refuses }) => refuses)).toEqual([[], []]);
    expect(blockedReason(composer, 4)).toBe(
      "Parts 2, 4 are empty: write something in them, or remove them.",
    );
    expect(blockedReason({ blocked: "empty", emptyParts: [1] }, 2)).toBe(
      "Part 2 is empty: write something in it, or remove it.",
    );
    // A post of one part has no part to name.
    expect(blockedReason({ blocked: "empty", emptyParts: [0] }, 1)).toBe(
      "Write something to publish.",
    );
  });

  it("checks an account on the text that was written for it, and the others on the post's", () => {
    // The post's text is too long for Bluesky, which gets a shorter one.
    const long = [{ text: "a".repeat(400) }];
    const refusedBy = (own: Map<string, { text: string }[]>) =>
      composeParts(long, [mastodon, bluesky], both, own);

    expect(refusedBy(new Map()).blocked).toBe("refused");
    const composer = refusedBy(new Map([[bluesky.id, [{ text: "Short" }]]]));
    expect(composer.blocked).toBeNull();
    expect(composer.choices).toMatchObject([
      { channel: mastodon, own: false, refuses: [] },
      { channel: bluesky, own: true, refuses: [] },
    ]);
    // And the other way round: what is written for Mastodon is what
    // Mastodon is checked on.
    expect(
      refusedBy(
        new Map([
          [bluesky.id, [{ text: "Short" }]],
          [mastodon.id, [{ text: "One" }, { text: "m".repeat(501) }]],
        ]),
      ).choices[0]?.refuses,
    ).toEqual(["Part 2 is 501 characters long. The limit is 500."]);
  });

  it("tells the account whose own text has an empty part, and lets an empty post go that nobody gets", () => {
    const unknown = channel({ limits: null, limitsCheckedAt: null });
    // Every chosen account has a text of its own, so the post's own, which
    // is empty, goes nowhere and keeps nothing back.
    const composer = composeParts(
      [{ text: "" }],
      [mastodon, unknown],
      new Set([mastodon.id, unknown.id]),
      new Map([
        [mastodon.id, [{ text: "Hello" }]],
        // An empty part is refused also where the limits are not known:
        // no network takes one.
        [unknown.id, [{ text: "One" }, { text: "" }]],
      ]),
    );
    expect(composer.emptyParts).toEqual([]);
    expect(composer.blocked).toBe("refused");
    expect(composer.choices.map(({ refuses }) => refuses)).toEqual([
      [],
      ["Part 2 of its own text is empty."],
    ]);
  });

  it("takes a text of its own only for an account that is chosen", () => {
    // What is left of a text whose account was left out counts for
    // nothing: the account is offered as one that follows the post.
    const composer = composeParts(
      [{ text: "Hello" }],
      [mastodon],
      new Set(),
      new Map([[mastodon.id, [{ text: "" }]]]),
    );
    expect(composer.choices).toMatchObject([{ own: false, refuses: [] }]);
  });

  it("says in advance that a network without threads gets a thread as one post", () => {
    const linkedin = channel({
      network: "linkedin",
      handle: "Ada Lovelace",
      limits: null,
      limitsCheckedAt: null,
    });
    const joined = (parts: { text: string }[], chosen: string[]) =>
      composeParts(parts, [mastodon, linkedin], new Set(chosen)).choices.map(
        (choice) => choice.joined,
      );
    const thread = [{ text: "One" }, { text: "Two" }];
    // Mastodon posts a thread as replies. LinkedIn joins it, which only
    // matters once it is chosen, and for more than one part.
    expect(joined(thread, [mastodon.id, linkedin.id])).toEqual([false, true]);
    expect(joined(thread, [mastodon.id])).toEqual([false, false]);
    expect(joined([{ text: "One" }], [linkedin.id])).toEqual([false, false]);
  });
});

describe("the counters of a part", () => {
  const elsewhere = channel({
    handle: "@ada@other.example",
    limits: { network: "mastodon", maxCharacters: 1000, charactersPerUrl: 23 },
  });
  const twin = channel({ handle: "@grace@mastodon.example" });

  it("counts for the accounts that get the text that is shown", () => {
    const { choices } = composeParts(
      [{ text: "Hello" }],
      [mastodon, bluesky, twin],
      new Set([mastodon.id, bluesky.id]),
      new Map([[bluesky.id, [{ text: "Hi" }]]]),
    );
    // The post's text: the chosen accounts without a text of their own.
    expect(readersOf(choices, null)).toEqual([mastodon]);
    // The text of one account: that account.
    expect(readersOf(choices, bluesky.id)).toEqual([bluesky]);
  });

  it("has one counter for the accounts that take the same, named by their network", () => {
    const unknown = channel({ limits: null, limitsCheckedAt: null });
    expect(
      gaugesOf([mastodon, twin, bluesky, unknown]).map(({ label }) => label),
    ).toEqual(["Mastodon", "Bluesky"]);
  });

  it("names the accounts where two servers of one network take different lengths", () => {
    expect(gaugesOf([mastodon, elsewhere]).map(({ label }) => label)).toEqual([
      "Mastodon (@ada@mastodon.example)",
      "Mastodon (@ada@other.example)",
    ]);
  });

  it("counts as the network does, and warns near the limit and over it", () => {
    const [gauge] = gaugesOf([mastodon]);
    if (!gauge) throw new Error("Mastodon has limits");
    const tone = (text: string) => {
      const { count, max, tone } = meterOf(gauge, text);
      return `${count}/${max} ${tone}`;
    };
    expect(tone("a".repeat(449))).toBe("449/500 ok");
    expect(tone("a".repeat(450))).toBe("450/500 near");
    expect(tone("a".repeat(500))).toBe("500/500 near");
    expect(tone("a".repeat(501))).toBe("501/500 over");
    // A link is 23 characters to Mastodon, however long it is.
    expect(tone(`https://example.com/${"x".repeat(100)}`)).toBe("23/500 ok");
  });

  it("is over the limit for a text that fits the characters of Bluesky and not its bytes", () => {
    const [gauge] = gaugesOf([bluesky]);
    if (!gauge) throw new Error("Bluesky has limits");
    // 150 characters, each a family of four, which takes 25 bytes.
    expect(meterOf(gauge, "👨‍👩‍👧‍👦".repeat(150))).toMatchObject({
      count: 150,
      max: 300,
      tone: "over",
      description: "Bluesky: 3750 of 3000 bytes",
    });
  });
});

describe("the counters of a thread on a network that makes one post of it", () => {
  const linkedin = channel({
    network: "linkedin",
    handle: "Grace Hopper",
    limits: { network: "linkedin", maxCharacters: 3000 },
  });
  const read = (meters: { label: string; count: number; max: number }[]) =>
    meters.map(({ label, count, max }) => `${label} ${count}/${max}`);
  // Each part is half of what LinkedIn takes, and the three together
  // are over it: what the counters of the parts used to hide.
  const thread = [1, 2, 3].map(() => ({ text: "a".repeat(1500) }));

  it("counts the parts together, with what stands between them, and not each against the limit of the post", () => {
    const gauges = gaugesOf([mastodon, linkedin]);
    // Under a part: Mastodon, where the part is a post. Not LinkedIn,
    // whose limit is not the part's.
    expect(read(partMetersOf(gauges, "a".repeat(1500), 3))).toEqual([
      "Mastodon 1500/500",
    ]);
    // Once for the text: 4500 characters and two empty lines, which are
    // two characters each.
    const whole = wholeMetersOf(gauges, thread);
    expect(read(whole)).toEqual(["LinkedIn 4504/3000"]);
    expect(whole[0]).toMatchObject({
      tone: "over",
      description: "LinkedIn: 4504 of 3000 characters, all parts as one post",
    });
  });

  it("is over the limit where the publish panel says that the account refuses the parts together, and not before", () => {
    const gauges = gaugesOf([linkedin]);
    const refused = (parts: { text: string }[]) =>
      composeParts(parts, [linkedin], new Set([linkedin.id])).blocked;
    // 1499 + 2 + 1499 is the limit to the character.
    const fits = [{ text: "a".repeat(1499) }, { text: "b".repeat(1499) }];
    expect(wholeMetersOf(gauges, fits)).toMatchObject([
      { count: 3000, tone: "near" },
    ]);
    expect(refused(fits)).toBeNull();
    const over = [{ text: "a".repeat(1499) }, { text: "b".repeat(1500) }];
    expect(wholeMetersOf(gauges, over)).toMatchObject([
      { count: 3001, tone: "over" },
    ]);
    expect(refused(over)).toBe("refused");
  });

  it("counts a text of one part under its part, which is the post", () => {
    const gauges = gaugesOf([linkedin]);
    expect(read(partMetersOf(gauges, "Hello", 1))).toEqual(["LinkedIn 5/3000"]);
    expect(wholeMetersOf(gauges, [{ text: "Hello" }])).toEqual([]);
  });

  it("counts the text that is written for the account, and not the post's", () => {
    const { choices } = composeParts(
      [{ text: "Short" }],
      [mastodon, linkedin],
      new Set([mastodon.id, linkedin.id]),
      new Map([[linkedin.id, thread]]),
    );
    // The post's text goes to Mastodon alone: nothing joins it.
    const post = gaugesOf(readersOf(choices, null));
    expect(wholeMetersOf(post, [{ text: "Short" }, { text: "Too" }])).toEqual(
      [],
    );
    const own = gaugesOf(readersOf(choices, linkedin.id));
    expect(read(partMetersOf(own, "a".repeat(1500), 3))).toEqual([]);
    expect(read(wholeMetersOf(own, thread))).toEqual(["LinkedIn 4504/3000"]);
  });

  it("joins for the counters the networks that the editor says get one post", () => {
    // Two places know which network joins a thread: the table of the
    // networks, for the note, and the counters, by the function that
    // joins. They have to agree.
    const [chosen] = composeParts(
      thread,
      [linkedin],
      new Set([linkedin.id]),
    ).choices;
    expect(chosen?.joined).toBe(true);
    expect(
      gaugesOf([mastodon, bluesky, linkedin]).map(({ joins }) => joins),
    ).toEqual([false, false, true]);
  });
});

describe("the counters of a Threads account", () => {
  const threads = channel({
    network: "threads",
    handle: "@grace.sandbox",
    limits: { network: "threads", maxCharacters: 500 },
  });
  const read = (meters: { label: string; count: number; max: number }[]) =>
    meters.map(({ label, count, max }) => `${label} ${count}/${max}`);

  it("counts an emoji as its bytes, as Threads does, against the limit of Threads", () => {
    const [gauge] = gaugesOf([threads]);
    if (!gauge) throw new Error("Threads has limits");
    // Five letters, a space, and a hand that takes four bytes.
    expect(meterOf(gauge, "Hello 👋")).toMatchObject({
      label: "Threads",
      count: 10,
      max: 500,
      tone: "ok",
    });
    // 125 hands are 125 characters to Mastodon and 500 to Threads, and
    // one more is over.
    expect(meterOf(gauge, "👋".repeat(125))).toMatchObject({
      count: 500,
      tone: "near",
    });
    expect(meterOf(gauge, "👋".repeat(126))).toMatchObject({
      count: 504,
      tone: "over",
    });
  });

  it("does not publish what Threads would refuse, which another network takes", () => {
    const chosen = new Set([mastodon.id, threads.id]);
    const text = "👋".repeat(126);
    const composer = compose(text, [mastodon, threads], chosen);
    expect(composer.blocked).toBe("refused");
    expect(composer.choices.map(({ refuses }) => refuses)).toEqual([
      [],
      ["The post is 504 characters long. The limit is 500."],
    ]);
    expect(
      compose("👋".repeat(125), [mastodon, threads], chosen).blocked,
    ).toBeNull();
  });

  it("counts each part of a thread by itself: Threads makes a chain of replies of it", () => {
    const gauges = gaugesOf([threads]);
    // Two parts that would be over the limit as one post.
    const parts = [{ text: "a".repeat(300) }, { text: "b".repeat(300) }];
    expect(read(partMetersOf(gauges, "a".repeat(300), 2))).toEqual([
      "Threads 300/500",
    ]);
    expect(wholeMetersOf(gauges, parts)).toEqual([]);
    const composer = composeParts(parts, [threads], new Set([threads.id]));
    expect(composer.blocked).toBeNull();
    expect(composer.choices[0]?.joined).toBe(false);
  });
});

describe("selectOwnTexts", () => {
  it("has the text of each account of a draft that has one, in reading order, and nothing of a post that went out", () => {
    const draft = post();
    const sent = post({ status: "sent" });
    const toMastodon = target(draft.id, mastodon.id);
    const toBluesky = target(draft.id, bluesky.id);
    const went = target(sent.id, mastodon.id, { status: "sent" });
    const second = part(draft.id, {
      targetId: toBluesky.id,
      position: 1,
      text: "Two",
    });
    const first = part(draft.id, {
      targetId: toBluesky.id,
      position: 0,
      text: "One",
    });
    const texts = selectOwnTexts(
      tablesOf({
        post: [draft, sent],
        channel: [mastodon, bluesky],
        post_target: [toMastodon, toBluesky, went],
        post_part: [
          part(draft.id),
          second,
          first,
          part(sent.id),
          part(sent.id, { targetId: went.id }),
        ],
      }),
    );
    expect([...ownTextsOf(texts, draft.id)]).toEqual([
      [bluesky.id, [first, second]],
    ]);
    expect(texts.has(sent.id)).toBe(false);
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
