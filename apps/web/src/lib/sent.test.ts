import { describe, expect, it } from "vitest";
import {
  channel,
  metric,
  part,
  post,
  result,
  tablesOf,
  target,
} from "@/lib/rows.test-support";
import {
  canDelete,
  compactCount,
  ownTextHeading,
  postStatusWords,
  postTimeWord,
  publishedPosts,
  selectSent,
  statsOf,
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

  it("shows for an account with a text of its own what went there, and its results in the order of that text", () => {
    const published = post({ status: "sent" });
    const own = part(published.id, { text: "The post" });
    const customized = target(published.id, ada.id, {
      status: "sent",
      queuedAt: 1,
    });
    const other = channel({ handle: "@grace@mastodon.example" });
    const follows = target(published.id, other.id, {
      status: "sent",
      queuedAt: 1,
    });
    // A thread of its own for one account, of another length than the
    // post.
    const first = part(published.id, {
      targetId: customized.id,
      position: 0,
      text: "For Ada, one",
    });
    const second = part(published.id, {
      targetId: customized.id,
      position: 1,
      text: "For Ada, two",
    });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [second, own, first],
        channel: [ada, other],
        post_target: [customized, follows],
        target_part_result: [
          result(customized.id, second.id, { remoteId: "2" }),
          result(customized.id, first.id, { remoteId: "1" }),
          result(follows.id, own.id, { remoteId: "3" }),
        ],
      }),
    );
    // The text of the post is its own, without what was written for Ada.
    expect(item?.parts.map(({ text }) => text)).toEqual(["The post"]);
    const [toAda, toGrace] = item?.targets ?? [];
    expect(toAda?.ownText?.map(({ text }) => text)).toEqual([
      "For Ada, one",
      "For Ada, two",
    ]);
    expect(toAda?.published.map(({ remoteId }) => remoteId)).toEqual([
      "1",
      "2",
    ]);
    expect(toGrace?.ownText).toBeNull();
    expect(toGrace?.published.map(({ remoteId }) => remoteId)).toEqual(["3"]);
    // It is called by its own text, which somebody got.
    expect(item?.title).toBe("The post");
  });

  it("calls a post whose own text is empty by the text that an account got", () => {
    const ada = channel();
    const published = post({ status: "sent" });
    const customized = target(published.id, ada.id, { status: "sent" });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        channel: [ada],
        post_target: [customized],
        post_part: [
          // Every account had a text of its own, so the post's own could
          // stay empty: it went nowhere.
          part(published.id, { text: "" }),
          part(published.id, { targetId: customized.id, text: " " }),
          part(published.id, {
            targetId: customized.id,
            position: 1,
            text: "For Ada",
          }),
        ],
      }),
    );
    expect(item?.title).toBe("For Ada");
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

  it("does not say that a post has failed whose only trouble is a delivery that nobody knows the end of", () => {
    expect(postStatusWords(of("error", ["uncertain"]))).toEqual({
      label: "Unknown",
      tone: "unsure",
    });
    // The other delivery arrived, and nothing is known to have failed.
    expect(postStatusWords(of("error", ["sent", "uncertain"])).label).toBe(
      "Unknown",
    );
  });

  it("says that a post was published only when something of it is known to be", () => {
    expect(postTimeWord(of("sent", ["sent"]))).toBe("Published");
    expect(postTimeWord(of("error", ["sent", "error"]))).toBe("Published");
    // Nothing of these is anywhere, as far as anybody knows.
    expect(postTimeWord(of("error", ["uncertain"]))).toBe("Tried");
    expect(postTimeWord(of("error", ["error"]))).toBe("Tried");
    expect(postTimeWord(of("sending", ["sending"]))).toBe("Started");
  });

  it("offers to delete a post once it has ended, and not while it is sent", () => {
    expect(canDelete(of("sending", ["sending"]))).toBe(false);
    expect(canDelete(of("error", ["error"]))).toBe(true);
    expect(canDelete(of("sent", ["sent"]))).toBe(true);
  });
});

describe("targetExplanation", () => {
  /** What the screen says under an unknown delivery to `to`. */
  const unknownTo = (
    to: ReturnType<typeof channel>,
    error: string | null = null,
  ) => {
    const published = post({ status: "error" });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [to],
        post_target: [
          target(published.id, to.id, {
            status: "uncertain",
            error,
            queuedAt: 1,
          }),
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

  it("does not say again what the reason of an unknown delivery says already", () => {
    const linkedin = channel({
      network: "linkedin",
      handle: "Ada Lovelace",
      limits: { network: "linkedin", maxCharacters: 3000 },
    });
    // What the adapter for LinkedIn says when no answer came. It says
    // that pigy cannot tell, that LinkedIn gives it no way to look, and
    // to look at the account first.
    const reason =
      "LinkedIn did not answer, so pigy cannot tell whether the post is on LinkedIn, and LinkedIn gives it no way to look. Look at the account before you try again.";
    // Under it, only what it leaves out.
    expect(unknownTo(linkedin, reason)).toBe(
      "If the post is there, do not try again, or it may be posted twice.",
    );
    expect(unknownTo(channel(), "pigy lost track.")).toBe(
      "If the post is there, do not try again, or it is posted twice.",
    );
  });
});

describe("a text of its own on a network that makes one post of a thread", () => {
  const linkedin = channel({
    network: "linkedin",
    handle: "Grace Hopper",
    limits: { network: "linkedin", maxCharacters: 3000 },
  });

  it("is one post with one link, under the text that the account got", () => {
    const published = post({ status: "sent" });
    const own = part(published.id, { text: "The post" });
    const customized = target(published.id, linkedin.id, {
      status: "sent",
      queuedAt: 1,
    });
    const first = part(published.id, {
      targetId: customized.id,
      position: 0,
      text: "For Grace, one",
    });
    const second = part(published.id, {
      targetId: customized.id,
      position: 1,
      text: "For Grace, two",
    });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [own, second, first],
        channel: [linkedin],
        post_target: [customized],
        // LinkedIn has one post, which the result of every part names.
        target_part_result: [
          result(customized.id, second.id, { remoteId: "urn:li:share:1" }),
          result(customized.id, first.id, { remoteId: "urn:li:share:1" }),
        ],
      }),
    );
    const [toGrace] = item?.targets ?? [];
    expect(toGrace?.ownText?.map(({ text }) => text)).toEqual([
      "For Grace, one",
      "For Grace, two",
    ]);
    expect(publishedPosts(toGrace?.published ?? [])).toMatchObject([
      { remoteId: "urn:li:share:1", first: 1, last: 2 },
    ]);
    // Not "a thread": LinkedIn has none.
    expect(toGrace && ownTextHeading(toGrace)).toBe(
      "Got a text of its own, 2 parts as one post:",
    );
  });

  it("is called a thread where the network has threads, and neither for one part or before it is sent", () => {
    const two = [
      { id: "a", text: "One" },
      { id: "b", text: "Two" },
    ];
    expect(
      ownTextHeading({ status: "sent", ownText: two, channel: channel() }),
    ).toBe("Got a text of its own, a thread of 2 parts:");
    expect(
      ownTextHeading({ status: "error", ownText: two, channel: linkedin }),
    ).toBe("Gets a text of its own, 2 parts as one post:");
    expect(
      ownTextHeading({
        status: "sent",
        ownText: two.slice(0, 1),
        channel: linkedin,
      }),
    ).toBe("Got a text of its own:");
  });
});

describe("publishedPosts", () => {
  const part = (partId: string, remoteId: string) => ({
    partId,
    remoteId,
    url: `https://network.example/${remoteId}`,
  });

  it("is one post for the parts of a thread that a network has joined into one, as LinkedIn does", () => {
    expect(
      publishedPosts([part("a", "1"), part("b", "1"), part("c", "1")]),
    ).toEqual([
      { remoteId: "1", url: "https://network.example/1", first: 1, last: 3 },
    ]);
  });

  it("is a post for each part where every part is a post of its own", () => {
    expect(
      publishedPosts([part("a", "1"), part("b", "2")]).map(
        ({ remoteId, first, last }) => [remoteId, first, last],
      ),
    ).toEqual([
      ["1", 1, 1],
      ["2", 2, 2],
    ]);
  });
});

describe("the stats of a delivery", () => {
  it("are what the server last read, with each delivery, and nothing before the first read", () => {
    const published = post({ status: "sent" });
    const counted = target(published.id, ada.id, {
      status: "sent",
      queuedAt: 1,
      sentAt: 2,
    });
    const fresh = target(published.id, grace.id, {
      status: "sent",
      queuedAt: 1,
      sentAt: 2,
    });
    const [item] = selectSent(
      tablesOf({
        post: [published],
        post_part: [part(published.id)],
        channel: [ada, grace],
        post_target: [counted, fresh],
        metric: [metric(counted.id, { likes: 3, countedAt: 50 })],
      }),
      "en",
    );
    expect(item?.targets.map(({ stats }) => stats)).toEqual([
      {
        status: "counted",
        counts: [
          { name: "likes", count: 3, label: "3 likes" },
          // Mastodon calls a repost a boost.
          { name: "reposts", count: 0, label: "0 boosts" },
          { name: "replies", count: 0, label: "0 replies" },
          { name: "quotes", count: 0, label: "0 quotes" },
        ],
        countedAt: 50,
        note: null,
      },
      // Sent a moment ago: the server has not read them yet.
      null,
    ]);
  });

  it("leave out what the network does not count, and say one of a kind as one", () => {
    expect(
      statsOf(
        metric("t", {
          likes: 1,
          reposts: 2,
          replies: 1,
          quotes: null,
          views: 1,
        }),
        "threads",
        "en",
      ).counts.map(({ label }) => label),
    ).toEqual(["1 like", "2 reposts", "1 reply", "1 view"]);
  });

  it("say why there are none, or why they no longer change, and keep what was counted before", () => {
    const linkedin = statsOf(
      metric("t", {
        status: "unavailable",
        likes: null,
        reposts: null,
        replies: null,
        quotes: null,
        countedAt: null,
        reason: "LinkedIn does not give pigy the stats of its posts.",
      }),
      "linkedin",
    );
    expect(linkedin).toEqual({
      status: "unavailable",
      counts: [],
      countedAt: null,
      note: "LinkedIn does not give pigy the stats of its posts.",
    });

    const gone = statsOf(
      metric("t", { status: "gone", likes: 4, countedAt: 50 }),
      "bluesky",
    );
    expect(gone.counts.find(({ name }) => name === "likes")?.count).toBe(4);
    expect(gone.note).toBe(
      "The post was deleted on Bluesky: these are the last stats that pigy read.",
    );
    // Of an account that was disconnected since, which names no network.
    expect(
      statsOf(
        metric("t", {
          status: "gone",
          likes: null,
          reposts: null,
          replies: null,
          quotes: null,
          countedAt: null,
        }),
        null,
      ).note,
    ).toBe("The post was deleted on the network.");
  });

  it("are written short where they are large", () => {
    expect(
      [950, 1234, 15_000, 2_500_000].map((count) => compactCount(count, "en")),
    ).toEqual(["950", "1.2K", "15K", "2.5M"]);
  });

  it("are written in the language of the browser, as the dates are", () => {
    // Italian writes a decimal comma.
    expect(compactCount(1234, "it")).toBe("1,2K");
    // The words of a count say it in full, grouped as the language
    // groups the digits.
    expect(
      statsOf(metric("t", { views: 12_345 }), "threads", "de").counts.find(
        ({ name }) => name === "views",
      )?.label,
    ).toBe("12.345 views");
    expect(
      statsOf(metric("t", { views: 12_345 }), "threads", "en").counts.find(
        ({ name }) => name === "views",
      )?.label,
    ).toBe("12,345 views");
  });
});
