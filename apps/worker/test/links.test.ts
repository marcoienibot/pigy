import {
  detectEntities,
  type Fetch,
  linkCardResponseSchema,
  mentionsResponseSchema,
  type Network,
  previewsPerMinute,
  type SandboxFeed,
  sandboxBlueskyHandles,
  sandboxFeedSchema,
  sandboxLink,
} from "@pigy/core";
import { entitiesOf, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { cardsAtOnce } from "../src/publish/workflow.ts";
import {
  connectBlueskyInSandbox,
  connectBlueskyLive,
  connectInSandbox,
  connectLinkedInInSandbox,
  connectLinkedInLive,
  connectLive,
  connectThreadsInSandbox,
  connectThreadsLive,
} from "./channels.ts";
import {
  type Browser,
  expectErrors,
  invite,
  realBlueskyHandle,
  signedIn,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import {
  ended,
  publishTo,
  retry,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient, workspaceIds } from "./sync-client.ts";

/**
 * What a post has besides its words, from the editor's question to what a
 * network keeps: links, mentions and hashtags, and the card of a link.
 * PLAN.md section 6, "Links, mentions and hashtags".
 */

type Where = "sandbox" | "live";

/**
 * Each network: how an account of it is connected in a sandbox and for
 * real, and a mention of an account that the network has there, as a
 * person writes one. LinkedIn has none that pigy could write: the "@" is
 * text there.
 */
const networks: Record<
  Network,
  {
    connect: Record<
      Where,
      (
        test: TestSetup,
        browser: Browser,
        workspaceId: string,
      ) => Promise<{ connect: string; channel?: string | undefined }>
    >;
    mention: Record<Where, string>;
  }
> = {
  mastodon: {
    connect: {
      sandbox: (_test, browser, id) => connectInSandbox(browser, id),
      live: connectLive,
    },
    mention: { sandbox: "@grace", live: "@rosalind" },
  },
  bluesky: {
    connect: {
      sandbox: (_test, browser, id) => connectBlueskyInSandbox(browser, id),
      live: connectBlueskyLive,
    },
    mention: {
      sandbox: `@${sandboxBlueskyHandles[1]}`,
      live: `@${realBlueskyHandle}`,
    },
  },
  linkedin: {
    connect: {
      sandbox: (_test, browser, id) => connectLinkedInInSandbox(browser, id),
      live: connectLinkedInLive,
    },
    mention: { sandbox: "@grace", live: "@rosalind" },
  },
  threads: {
    connect: {
      sandbox: (_test, browser, id) => connectThreadsInSandbox(browser, id),
      live: connectThreadsLive,
    },
    mention: { sandbox: "@grace.sandbox", live: "@rosalind" },
  },
};

/** A signed-in admin with an account of `network` connected, `where`. */
async function withChannel(
  network: Network,
  where: Where,
  options: Parameters<typeof started>[0] = {},
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces[where];
  const outcome = await networks[network].connect[where](
    test,
    browser,
    workspace,
  );
  expect(outcome.connect).toBe("connected");
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return { ...context, workspace, channel: outcome.channel ?? "", client };
}

/** The feed of the sandbox of whoever `browser` is signed in as. */
async function feedOf(browser: Browser): Promise<SandboxFeed> {
  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  expect(response.status).toBe(200);
  return sandboxFeedSchema.parse(await response.json());
}

/** What a network shows of a post: its marks, and the title of its card. */
type Kept = {
  text: string;
  entities: [kind: string, written: string][];
  card: string | null;
};

/** The posts of `network`, as its world has them `where`. */
async function keptOn(
  network: Network,
  where: Where,
  { test, browser }: { test: TestSetup; browser: Browser },
): Promise<Kept[]> {
  if (where === "live") {
    return feed(test.network.world, [network]).map(({ post }) => ({
      text: post.text,
      entities: entitiesOf(post).map(([kind, written]) => [kind, written]),
      card: post.card?.title ?? null,
    }));
  }
  // As a person sees it: what the feed of the sandbox answers with.
  const { accounts } = await feedOf(browser);
  return accounts
    .filter((account) => account.network === network)
    .flatMap(({ posts }) => posts)
    .map(({ text, entities, card }) => ({
      text,
      entities: entities.map(({ kind, start, end }) => [
        kind,
        text.slice(start, end),
      ]),
      card: card?.title ?? null,
    }));
}

const cases = (Object.keys(networks) as Network[]).flatMap((network) =>
  (["sandbox", "live"] as const).map((where) => [network, where] as const),
);

describe("a post with a link, a mention and a hashtag", () => {
  it.each(cases)(
    "goes to %s, %s, with each of them as that network has it, and with the card of the link",
    async (network, where) => {
      const context = await withChannel(network, where);
      const { test, workspace, channel, client } = context;
      const text = `Thanks ${networks[network].mention[where]}: ${sandboxLink} #pigyLinks`;
      const draft = await writeDraft(client, workspace, text);
      await publishTo(client, draft.postId, channel);
      expect(await ended(client, draft.postId)).toMatchObject({
        status: "sent",
      });

      const [kept] = await keptOn(network, where, context);
      // The post reads as it was written: no markup of pigy's is in it.
      expect(kept?.text).toBe(text);
      // What the network shows as more than text is what pigy takes for a
      // link, a mention and a tag there. The account that is mentioned is
      // one that the network has, so every network that has mentions
      // shows it.
      const expected = detectEntities(network, text).map(
        ({ kind, start, end }) => [kind, text.slice(start, end)],
      );
      expect(kept?.entities).toEqual(expected);
      expect(expected.map(([kind]) => kind)).toEqual(
        network === "linkedin"
          ? ["link", "hashtag"]
          : ["mention", "link", "hashtag"],
      );
      // The card says what the page says of itself, whoever read the page:
      // pigy, for Bluesky and LinkedIn, or the network.
      expect(kept?.card).toBe("The example page");

      const pageRequests = test.network.requests.filter((request) =>
        request.startsWith(`GET ${sandboxLink}`),
      );
      if (where === "sandbox") {
        // Nothing of a sandbox leaves the Worker, the reading of a page
        // included: it is a page of the simulated web of its world.
        expect(test.network.requests).toEqual([]);
      } else {
        // pigy reads the page where it makes the card, once, and leaves it
        // to the network elsewhere.
        expect(pageRequests).toHaveLength(
          network === "bluesky" || network === "linkedin" ? 1 : 0,
        );
      }
    },
  );

  it("gives each part of a thread the card of its own first link", async () => {
    const context = await withChannel("bluesky", "sandbox");
    const { workspace, channel, client } = context;
    const draft = await writeDraft(
      client,
      workspace,
      `First ${sandboxLink}`,
      "Second, without a link",
      "Third https://news.example.test/story and https://blog.example.test/first-post",
    );
    await publishTo(client, draft.postId, channel);
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    const [first] = await keptOn("bluesky", "sandbox", context);
    // The feed lists a thread as a chain of replies.
    const { accounts } = await feedOf(context.browser);
    const [thread] = accounts.flatMap(({ posts }) => posts);
    const [second] = thread?.replies ?? [];
    const [third] = second?.replies ?? [];
    expect(first?.card).toBe("The example page");
    expect(second?.card).toBeNull();
    expect(third?.card?.title).toBe("A story from the simulated news");
  });
});

/** Answers in place of the web at `host`, and passes everything else on. */
const pageAt =
  (host: string, answer: (url: string) => Response | Promise<Response>) =>
  (network: Fetch): Fetch =>
  async (input, init) => {
    const url = urlOf(input);
    return new URL(url).host === host ? answer(url) : network(input, init);
  };

describe("a page that cannot be read for its card", () => {
  it.each([
    [
      "sends pigy on to a private address",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://127.0.0.1/admin" },
        }),
    ],
    [
      "does not answer",
      () => {
        throw new TypeError("No answer");
      },
    ],
    [
      "is no page",
      () =>
        new Response('{"title":"JSON"}', {
          headers: { "Content-Type": "application/json" },
        }),
    ],
    ["fails", () => new Response("Broken", { status: 500 })],
  ])("does not keep the post back when it %s", async (_name, answer) => {
    const context = await withChannel("bluesky", "live", {
      interceptNetwork: pageAt("example.test", answer),
    });
    const { test, workspace, channel, client } = context;
    const text = `Read ${sandboxLink}`;
    const draft = await writeDraft(client, workspace, text);
    await publishTo(client, draft.postId, channel);
    // The delivery is sent, and the post is there with its link marked,
    // and without a card.
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    expect(await keptOn("bluesky", "live", context)).toEqual([
      { text, entities: [["link", sandboxLink]], card: null },
    ]);
    // Where a page sent pigy on, pigy did not go.
    expect(
      test.network.requests.filter((request) => request.includes("127.0.0.1")),
    ).toEqual([]);
  });

  it("goes on without the card when what reads the page fails in a way that is pigy's own", async () => {
    // Not what a network fails with: a bug behind `fetch`. It is logged,
    // and the post goes out all the same.
    const errors = expectErrors();
    const context = await withChannel("bluesky", "live", {
      interceptNetwork: pageAt("example.test", () => {
        throw new Error("A bug behind fetch");
      }),
    });
    const { workspace, channel, client } = context;
    const draft = await writeDraft(client, workspace, `Read ${sandboxLink}`);
    await publishTo(client, draft.postId, channel);
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    expect((await keptOn("bluesky", "live", context))[0]?.card).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "The card of a link was not read",
      expect.anything(),
    );
  });
});

describe("the pages of a thread", () => {
  /** The requests for a page of the simulated web, of those that left. */
  const pagesAsked = (test: TestSetup) =>
    test.network.requests.filter((request) =>
      /^GET https:\/\/([a-z]+\.)?example\.test\//.test(request),
    );

  it("are read several at once, and no more than so many", async () => {
    let open = 0;
    let most = 0;
    const context = await withChannel("bluesky", "live", {
      interceptNetwork: (network) => async (input, init) => {
        if (new URL(urlOf(input)).host !== "example.test") {
          return network(input, init);
        }
        // A page that takes a moment, in which the others are asked for
        // if they are not read one after the other.
        open++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 100));
        open--;
        return network(input, init);
      },
    });
    const { test, workspace, channel, client } = context;
    const texts = Array.from(
      { length: cardsAtOnce + 2 },
      (_, index) => `Part ${index + 1} ${sandboxLink}?page=${index + 1}`,
    );
    const [first = "", ...rest] = texts;
    const draft = await writeDraft(client, workspace, first, ...rest);
    await publishTo(client, draft.postId, channel);
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    // Every part has its card, in its place.
    expect(pagesAsked(test)).toHaveLength(texts.length);
    expect(
      (await keptOn("bluesky", "live", context)).map(({ card }) => card),
    ).toEqual(texts.map(() => "The example page"));
    expect(most).toBe(cardsAtOnce);
  });

  it("are not read again for the parts that an attempt before has published", async () => {
    // The network refuses the second part of the thread once, for good.
    let refuse = true;
    const context = await withChannel("bluesky", "live", {
      interceptNetwork: (network) => async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (
          refuse &&
          urlOf(input).endsWith("com.atproto.repo.createRecord") &&
          body.includes("Second")
        ) {
          refuse = false;
          return Response.json(
            { error: "InvalidRequest", message: "Not this one" },
            { status: 400 },
          );
        }
        return network(input, init);
      },
    });
    const { test, workspace, channel, client } = context;
    const draft = await writeDraft(
      client,
      workspace,
      `First ${sandboxLink}`,
      "Second https://news.example.test/story",
    );
    const [targetId = ""] = await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);
    expect(targetOf(client, targetId)).toMatchObject({ status: "error" });
    // The first attempt read both pages.
    expect(pagesAsked(test)).toEqual([
      `GET ${sandboxLink}`,
      "GET https://news.example.test/story",
    ]);

    await retry(client, targetId);
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    // The second read the page of the part that was left, and not the
    // page of the part that is published.
    expect(pagesAsked(test)).toEqual([
      `GET ${sandboxLink}`,
      "GET https://news.example.test/story",
      "GET https://news.example.test/story",
    ]);
    expect(
      (await keptOn("bluesky", "live", context)).map(({ card }) => card),
    ).toEqual(["The example page", "A story from the simulated news"]);
  });

  it("does not keep the post back when the platform gives up on the step that reads them", async () => {
    const errors = expectErrors();
    const context = await withChannel("bluesky", "live");
    const { test, workflows, workspace, channel, client } = context;
    // The step is cut off, every time that the platform runs it: what a
    // step looks like to the run whose time was up, or whose Worker went
    // away under it.
    await workflows.modifyAll(async (modifier) => {
      await modifier.mockStepError({ name: "cards" }, new Error("Cut off"));
      await modifier.disableRetryDelays();
    });
    const text = `Read ${sandboxLink}`;
    const draft = await writeDraft(client, workspace, text);
    await publishTo(client, draft.postId, channel);
    // The delivery goes on to the network, and the post is there with
    // its link and without a card.
    expect(await ended(client, draft.postId)).toMatchObject({
      status: "sent",
    });
    expect(await keptOn("bluesky", "live", context)).toEqual([
      { text, entities: [["link", sandboxLink]], card: null },
    ]);
    expect(pagesAsked(test)).toEqual([]);
    expect(errors).toHaveBeenCalledWith(
      "The cards of a post were not read",
      expect.anything(),
    );
  });
});

describe("pigy's own host", () => {
  it("is not asked for the card of a link", async () => {
    const { test, browser, workspaces } = await started();
    // The address that the app of the test is reached at, which is a
    // public one by its name.
    const response = await askCard(
      browser,
      workspaces.live,
      "https://pigy.test/",
    );
    expect(await cardOf(response)).toBeNull();
    expect(test.network.requests).toEqual([]);
  });
});

/** Asks for the card of `url` as the editor does. */
const askCard = (browser: Browser, workspaceId: string, url: unknown) =>
  browser.fetch(`/api/workspaces/${workspaceId}/link-card`, {
    method: "POST",
    json: { url },
  });

const cardOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return linkCardResponseSchema.parse(await response.json()).card;
};

describe("the card of a link, for the editor", () => {
  it("is read from the simulated web in a sandbox, and nothing leaves the Worker", async () => {
    const { test, browser, workspaces } = await started();
    expect(
      await cardOf(await askCard(browser, workspaces.sandbox, sandboxLink)),
    ).toEqual({
      url: sandboxLink,
      title: "The example page",
      description:
        "A page of the simulated web of a sandbox, for the links of a post to lead to.",
    });
    // A page of the internet is none of a sandbox, whatever it is.
    expect(
      await cardOf(
        await askCard(browser, workspaces.sandbox, "https://example.com/"),
      ),
    ).toBeNull();
    expect(test.network.requests).toEqual([]);
  });

  it("is read through the fetch of the app for a live workspace", async () => {
    const { test, browser, workspaces } = await started();
    const card = await cardOf(
      await askCard(browser, workspaces.live, "https://example.test/moved"),
    );
    expect(card?.title).toBe("The first post");
    // The page had moved, and pigy went after it.
    expect(test.network.requests).toEqual([
      "GET https://example.test/moved",
      "GET https://blog.example.test/first-post",
    ]);
  });

  it("hands out what a page writes as markup as the text that it is", async () => {
    const { browser, workspaces } = await started();
    const card = await cardOf(
      await askCard(browser, workspaces.sandbox, "https://example.test/markup"),
    );
    // A string of JSON, which the app shows as text.
    expect(card?.title).toBe(
      '<b>Bold</b> claims & <script>alert("card")</script>',
    );
  });

  it.each([
    "http://example.test/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://intranet.internal/",
    "https://example.test:8443/",
    "file:///etc/passwd",
  ])("asks nobody for %s, and says that it has no card", async (url) => {
    const { test, browser, workspaces } = await started();
    expect(
      await cardOf(await askCard(browser, workspaces.live, url)),
    ).toBeNull();
    expect(test.network.requests).toEqual([]);
  });

  it("does not follow a page that sends it on to a private address", async () => {
    const { test, browser, workspaces } = await started({
      interceptNetwork: pageAt(
        "example.test",
        () =>
          new Response(null, {
            status: 301,
            headers: { Location: "https://10.0.0.1/" },
          }),
      ),
    });
    expect(
      await cardOf(await askCard(browser, workspaces.live, sandboxLink)),
    ).toBeNull();
    expect(test.network.requests).toEqual([`GET ${sandboxLink}`]);
  });

  it("carries nothing of the person to the page", async () => {
    const seen: Headers[] = [];
    const { browser, workspaces } = await started({
      interceptNetwork: (network) => async (input, init) => {
        seen.push(new Request(input, init).headers);
        return network(input, init);
      },
    });
    await cardOf(await askCard(browser, workspaces.live, sandboxLink));
    expect(seen).toHaveLength(1);
    // The request of the browser came with the cookie of its session.
    expect(seen[0]?.get("Cookie")).toBeNull();
    expect(seen[0]?.get("Authorization")).toBeNull();
  });

  it("is for whoever is signed in, about a workspace of their own, from pigy's own pages", async () => {
    const { test, browser, workspaces } = await started();
    expect(
      (await askCard(test.browser(), workspaces.live, sandboxLink)).status,
    ).toBe(401);
    // Somebody else, who is invited, asks about the workspace of the
    // admin.
    await invite(test, "other@example.com");
    const other = await signedIn(test, { email: "other@example.com" });
    expect((await askCard(other, workspaces.live, sandboxLink)).status).toBe(
      404,
    );
    expect((await askCard(other, workspaces.sandbox, sandboxLink)).status).toBe(
      404,
    );
    // A page of another site can make the browser of somebody who is
    // signed in send this, to have pigy ask a host of its choosing.
    const forged = await browser.fetch(
      `/api/workspaces/${workspaces.live}/link-card`,
      {
        method: "POST",
        json: { url: sandboxLink },
        headers: { Origin: "https://elsewhere.example" },
      },
    );
    expect(forged.status).toBe(403);
    expect(test.network.requests).toEqual([]);
  });

  it("refuses a request that names no address", async () => {
    const { browser, workspaces } = await started();
    expect((await askCard(browser, workspaces.live, "")).status).toBe(400);
    expect((await askCard(browser, workspaces.live, 5)).status).toBe(400);
  });

  it("makes so many previews for a person in a minute and no more, and counts each person alone", async () => {
    const { test, browser, workspaces } = await started();
    await invite(test, "other@example.com");
    const other = await signedIn(test, { email: "other@example.com" });
    const { sandbox } = await workspaceIds(other);
    for (let asked = 0; asked < previewsPerMinute; asked++) {
      // In either workspace: the count is the person's.
      const workspace = asked % 2 ? workspaces.sandbox : workspaces.live;
      expect((await askCard(browser, workspace, sandboxLink)).status).toBe(200);
    }
    const refused = await askCard(browser, workspaces.sandbox, sandboxLink);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "LimitReachedError" });
    // Nothing was asked of a page for the request that was refused.
    expect(
      test.network.requests.filter((request) => request.includes("example")),
    ).toHaveLength(previewsPerMinute / 2);
    // Somebody else is not held back by it.
    expect((await askCard(other, sandbox, sandboxLink)).status).toBe(200);
    // And a minute later the count begins anew.
    test.advance(60_000);
    expect(
      (await askCard(browser, workspaces.sandbox, sandboxLink)).status,
    ).toBe(200);
  });
});

/** Asks which of `names` are accounts of `network`, as the editor does. */
const askMentions = (
  browser: Browser,
  workspaceId: string,
  network: Network,
  names: string[],
) =>
  browser.fetch(`/api/workspaces/${workspaceId}/mentions`, {
    method: "POST",
    json: { network, names },
  });

const knownOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return mentionsResponseSchema.parse(await response.json()).known;
};

describe("the accounts that a text mentions, for the editor", () => {
  it("says which handles are accounts of Bluesky, in the world of a sandbox and for real", async () => {
    const { test, browser, workspaces } = await started();
    const names = [
      sandboxBlueskyHandles[1],
      realBlueskyHandle,
      "nobody.bsky.test",
    ];
    // Each workspace has the accounts of its own networks.
    expect(
      await knownOf(
        await askMentions(browser, workspaces.sandbox, "bluesky", names),
      ),
    ).toEqual([sandboxBlueskyHandles[1]]);
    expect(test.network.requests).toEqual([]);
    expect(
      await knownOf(
        await askMentions(browser, workspaces.live, "bluesky", names),
      ),
    ).toEqual([realBlueskyHandle]);
  });

  it.each(["mastodon", "linkedin", "threads"] as const)(
    "looks nobody up on %s, which finds its accounts itself or has no mentions of pigy's",
    async (network) => {
      const { test, browser, workspaces } = await started();
      expect(
        await knownOf(
          await askMentions(browser, workspaces.live, network, ["rosalind"]),
        ),
      ).toBeNull();
      expect(test.network.requests).toEqual([]);
    },
  );

  it("is for whoever is signed in, about a workspace of their own, and is counted with the cards", async () => {
    const { test, browser, workspaces } = await started();
    const names = [realBlueskyHandle];
    expect(
      (await askMentions(test.browser(), workspaces.live, "bluesky", names))
        .status,
    ).toBe(401);
    await invite(test, "other@example.com");
    const other = await signedIn(test, { email: "other@example.com" });
    expect(
      (await askMentions(other, workspaces.live, "bluesky", names)).status,
    ).toBe(404);
    for (let asked = 0; asked < previewsPerMinute; asked++) {
      await askCard(browser, workspaces.sandbox, sandboxLink);
    }
    expect(
      (await askMentions(browser, workspaces.live, "bluesky", names)).status,
    ).toBe(429);
  });

  it("takes ten names at most", async () => {
    const { browser, workspaces } = await started();
    const names = Array.from({ length: 11 }, (_, n) => `user${n}.bsky.test`);
    expect(
      (await askMentions(browser, workspaces.live, "bluesky", names)).status,
    ).toBe(400);
  });
});
