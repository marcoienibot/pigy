import type { ContentImage, Fetch, PostContent } from "@pigy/core";
import { pngFile } from "@pigy/core/test-images";
import {
  createLinkedInSimulator,
  slowProcessingMs,
} from "@pigy/simulators/linkedin";
import {
  answerConsent,
  createWorld,
  entitiesOf,
  feed,
} from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import { cardOf } from "../card.ts";
import { ProviderError } from "../errors.ts";
import type { MediaSource, PublishProgress } from "../provider.ts";
import {
  createLinkedInProvider,
  type LinkedInCredentials,
  linkedInApiVersion,
} from "./index.ts";

/**
 * What is the LinkedIn adapter's own. What every provider does is in
 * test/conformance.
 */

const redirectUri = "https://pigy.example/connect/linkedin/callback";

type Intercept = (
  request: Request,
) => Promise<Response | undefined> | Response | undefined;

/**
 * The adapter against the simulated LinkedIn. Every request is noted, and
 * `intercept` may answer one in the simulator's place, with what the
 * simulated LinkedIn does not send.
 */
function setup() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createLinkedInSimulator(world);
  const client = simulator.addClient({
    name: "pigy",
    redirectUris: [redirectUri],
  });
  const ada = simulator.addMember("Ada Lovelace");
  const requests: Request[] = [];
  const hooks: { intercept?: Intercept } = {};
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return (await hooks.intercept?.(request)) ?? simulator.fetch(request);
  };
  const provider = createLinkedInProvider({
    fetch,
    now: world.now,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  return { world, simulator, client, ada, requests, hooks, provider };
}

type Setup = ReturnType<typeof setup>;

async function consented({ provider, simulator, ada }: Setup) {
  const start = await provider.beginConnect({ redirectUri });
  const callback = await answerConsent(simulator.fetch, start.url, {
    account: ada.id,
  });
  return { pending: start.pending, params: callback.searchParams };
}

async function connect(test: Setup) {
  const connection = await test.provider.completeConnect(await consented(test));
  return {
    ...connection,
    credentials: connection.access.credentials as LinkedInCredentials,
  };
}

async function failure(action: () => Promise<unknown>) {
  const error = await action().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error instanceof ProviderError) return error;
  throw new Error(`Expected a ProviderError, got ${String(error)}`);
}

/** Whether `request` asks LinkedIn to publish a post. */
const posts = (request: Request) =>
  request.method === "POST" && request.url.endsWith("/rest/posts");

const step = (
  { provider }: Setup,
  credentials: LinkedInCredentials,
  ...texts: string[]
) =>
  provider.publishStep({
    credentials,
    content: { parts: texts.map((text) => ({ text })) },
    key: "target-1",
    progress: null,
  });

/** A step of an attempt that comes after one that may have sent. */
const laterStep = (
  { provider }: Setup,
  credentials: LinkedInCredentials,
  text: string,
) =>
  provider.publishStep({
    credentials,
    content: { parts: [{ text }] },
    key: "target-1",
    progress: null,
    mayHaveSentBefore: true,
  });

const published = ({ world }: Setup) =>
  feed(world, ["linkedin"]).map(({ post }) => post.text);

describe("connecting", () => {
  it("sends the person to LinkedIn's one place to sign in, whatever they typed", async () => {
    const { provider, client } = setup();
    const { url, state } = await provider.beginConnect({
      redirectUri,
      identifier: "evil.example",
    });
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      scope: "openid profile w_member_social",
    });
  });

  it("names the account by the member's name, which is all that LinkedIn gives to address it by", async () => {
    const test = setup();
    const { account, access } = await connect(test);
    expect(account).toEqual({
      id: test.ada.id,
      handle: "Ada Lovelace",
      name: "Ada Lovelace",
      avatarUrl: null,
      profileUrl: null,
    });
    // 60 days from now, as LinkedIn said, and nothing to renew it with.
    expect(access.expiresAt).toEqual(new Date("2027-01-14T10:00:00Z"));
    expect(access.refreshAt).toBeNull();
    expect(test.provider.refresh).toBeUndefined();
  });

  it("takes a picture only from an HTTPS address, and makes a name of its parts where LinkedIn sends no whole one", async () => {
    const test = setup();
    test.hooks.intercept = (request) =>
      request.url.endsWith("/v2/userinfo")
        ? Response.json({
            sub: test.ada.id,
            given_name: "Ada",
            family_name: "Lovelace",
            picture: "http://media.example/ada.jpg",
          })
        : undefined;
    const { account } = await connect(test);
    expect(account).toMatchObject({ name: "Ada Lovelace", avatarUrl: null });
  });

  it.each(["user_cancelled_login", "user_cancelled_authorize"])(
    "takes %s for a person who said no",
    async (error) => {
      const test = setup();
      const { pending } = await test.provider.beginConnect({ redirectUri });
      const { state } = pending as { state: string };
      const failed = await failure(() =>
        test.provider.completeConnect({
          pending,
          params: new URLSearchParams({ error, state }),
        }),
      );
      expect(failed).toMatchObject({ kind: "fail", declined: true });
    },
  );

  it("quotes what a callback says went wrong, without what the connection is made with", async () => {
    const test = setup();
    const { pending } = await test.provider.beginConnect({ redirectUri });
    const { state } = pending as { state: string };
    const failed = await failure(() =>
      test.provider.completeConnect({
        pending,
        params: new URLSearchParams({
          error: "unauthorized_scope_error",
          // Anybody can send a browser to the callback address.
          error_description: `Scope not authorized, state ${state}, secret ${test.client.clientSecret}`,
          state,
        }),
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", declined: false });
    expect(failed.message).toContain("Scope not authorized");
    expect(failed.message).not.toContain(state);
    expect(failed.message).not.toContain(test.client.clientSecret);
  });

  it.each([
    ["with commas between them", "openid,profile,w_member_social", true],
    ["with spaces between them", "w_member_social profile openid", true],
    ["without the one to post with", "openid,profile", false],
  ])("reads the scopes of a token %s", async (_name, scope, enough) => {
    const test = setup();
    test.hooks.intercept = async (request) => {
      if (!request.url.endsWith("/oauth/v2/accessToken")) return undefined;
      const answer = await test.simulator.fetch(request);
      return Response.json({ ...(await answer.json()), scope });
    };
    const connecting = connect(test);
    if (enough) {
      expect((await connecting).account.id).toBe(test.ada.id);
    } else {
      expect((await failure(() => connecting)).kind).toBe("fail");
    }
  });

  it("does not put the secret of the application into a message when LinkedIn repeats it", async () => {
    const test = setup();
    const callback = await consented(test);
    test.hooks.intercept = (request) =>
      request.url.endsWith("/oauth/v2/accessToken")
        ? Response.json(
            {
              error: "invalid_request",
              error_description: `Bad secret ${test.client.clientSecret} for code ${callback.params.get("code")}`,
            },
            { status: 400 },
          )
        : undefined;
    const failed = await failure(() => test.provider.completeConnect(callback));
    expect(failed.kind).toBe("fail");
    expect(failed.message).toContain("Bad secret");
    expect(failed.message).not.toContain(test.client.clientSecret);
    expect(failed.message).not.toContain(callback.params.get("code"));
  });
});

describe("limits", () => {
  it("are LinkedIn's 3000 characters, without asking LinkedIn", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const before = test.requests.length;
    expect(await test.provider.limits(credentials)).toEqual({
      network: "linkedin",
      maxCharacters: 3000,
    });
    expect(test.requests).toHaveLength(before);
  });
});

describe("publishing", () => {
  it("says which version of the API it speaks, and posts as the member", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await step(test, credentials, "Hello");
    const request = test.requests.find(posts);
    expect(request?.headers.get("LinkedIn-Version")).toBe(linkedInApiVersion);
    expect(request?.headers.get("X-Restli-Protocol-Version")).toBe("2.0.0");
    expect(await request?.json()).toMatchObject({
      author: `urn:li:person:${test.ada.id}`,
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
  });

  it("escapes what LinkedIn reserves, so that the post reads as it was written", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const text =
      "A (new) post_with #tags, @mentions, a \\ and [brackets] {x|y} <z> *b* ~s~";
    await step(test, credentials, text);
    expect(published(test)).toEqual([text]);
  });

  it("marks the hashtags of a post, and leaves its mentions as text", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const text =
      "Thanks @ada for #big_news, see https://example.test/ (#2 is none)";
    await step(test, credentials, text);
    const kept = feed(test.world, ["linkedin"])[0]?.post;
    // The post reads as it was written.
    expect(kept?.text).toBe(text);
    expect(kept && entitiesOf(kept)).toEqual([
      ["hashtag", "#big_news", "big_news"],
      // LinkedIn finds the link itself.
      ["link", "https://example.test/", "https://example.test/"],
    ]);
    // No card came with the post, so it has no preview.
    expect(kept?.card).toBeNull();
  });

  it("previews the first link of a post as an article, with what the card of its part says", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await test.provider.publishStep({
      credentials,
      content: {
        parts: [
          { text: "No link in the first part" },
          {
            text: "See https://example.test/",
            card: {
              url: "https://example.test/",
              title: "The example page",
              description: "A page.",
            },
          },
        ],
      },
      key: "target-1",
      progress: null,
    });
    expect(feed(test.world, ["linkedin"])[0]?.post.card).toEqual({
      url: "https://example.test/",
      title: "The example page",
      description: "A page.",
    });
  });

  it("previews a page that names no title under its host, as its card is headed", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // What `cardOf` makes of a page with a description and no title.
    const card = cardOf(
      "https://example.test/",
      '<meta name="description" content="Only this">',
    );
    expect(card?.title).toBe("example.test");
    await test.provider.publishStep({
      credentials,
      content: {
        parts: [{ text: "See https://example.test/", ...(card && { card }) }],
      },
      key: "target-1",
      progress: null,
    });
    expect(feed(test.world, ["linkedin"])[0]?.post.card).toEqual(card);
  });

  it("posts without a preview where a card has a blank title, which no page read by pigy has and LinkedIn refuses", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await test.provider.publishStep({
      credentials,
      content: {
        parts: [
          {
            text: "See https://example.test/",
            card: {
              url: "https://example.test/",
              title: " ",
              description: "D",
            },
          },
        ],
      },
      key: "target-1",
      progress: null,
    });
    // The simulated LinkedIn refuses an article without a title, and the
    // post with it: the post is there because none was sent.
    expect(progress.done).toBe(true);
    expect(feed(test.world, ["linkedin"])[0]?.post.card).toBeNull();
  });

  it("joins the parts of a thread with an empty line, and gives every part the one post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await step(test, credentials, "One", "Two", "Three");
    expect(published(test)).toEqual(["One\n\nTwo\n\nThree"]);
    const [first] = progress.parts;
    expect(progress).toEqual({
      parts: [first, first, first],
      done: true,
      waitSeconds: 0,
      state: null,
    });
    expect(first).toEqual({
      id: expect.stringMatching(/^urn:li:share:\d+$/),
      url: `https://www.linkedin.com/feed/update/${first?.id}/`,
    });
  });

  it("sends nothing for a post that an attempt before it has published", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const progress = await step(test, credentials, "Once");
    const before = test.requests.length;
    const again = await test.provider.publishStep({
      credentials,
      content: { parts: [{ text: "Once" }] },
      key: "target-1",
      progress,
    });
    expect(again).toEqual(progress);
    expect(test.requests).toHaveLength(before);
  });

  it("takes the post that LinkedIn names when it refuses the text as a repetition, in an attempt after one that may have sent", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The answer to the first request is lost: the post is there, and
    // nobody knows.
    test.simulator.arm({ kind: "lost-response", operation: "publish" });
    expect((await failure(() => step(test, credentials, "Hello"))).kind).toBe(
      "uncertain",
    );
    // A person looks, finds nothing or does not look, and tries again
    // within the minutes in which LinkedIn tells a repetition.
    test.world.advance(5 * 60 * 1000);
    const progress = await laterStep(test, credentials, "Hello");
    expect(progress.done).toBe(true);
    const [post] = feed(test.world, ["linkedin"]);
    expect(progress.parts).toEqual([
      { id: post?.post.id, url: post?.post.url },
    ]);
    expect(published(test)).toEqual(["Hello"]);
  });

  it("does not take a post for its own that LinkedIn names in a first attempt, which has sent nothing before: it fails and says where the post is", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    // The member has posted the text themselves, by hand or from
    // elsewhere: here with a provider of their own, which pigy's delivery
    // knows nothing of.
    const byHand = await step(test, credentials, "Hello");
    const before = published(test);

    const failed = await failure(() => step(test, credentials, "Hello"));

    expect(failed).toMatchObject({ kind: "fail", status: 422 });
    expect(failed.message).toBe(
      `LinkedIn already has a post with this text, and did not publish it a second time: ${byHand.parts[0]?.url}`,
    );
    expect(published(test)).toEqual(before);
  });

  it.each([
    ["without naming the post", "Content is a duplicate"],
    // Only the whole message is LinkedIn's way of saying it. A message
    // that has the words somewhere, as one that quotes the text of the
    // post would, names no post of the delivery's.
    [
      "in the middle of another message",
      'Invalid commentary "Content is a duplicate of urn:li:share:1" at position 3',
    ],
  ])(
    "fails, and says why, when LinkedIn refuses a repetition %s",
    async (_name, message) => {
      const test = setup();
      const { credentials } = await connect(test);
      test.hooks.intercept = (request) =>
        posts(request)
          ? Response.json({ message, status: 422 }, { status: 422 })
          : undefined;
      const failed = await failure(() => laterStep(test, credentials, "Hello"));
      expect(failed.kind).toBe("fail");
      expect(failed.message).toContain("Content is a duplicate");
      expect(failed.message).toContain("LinkedIn refused the request");
    },
  );

  it.each([
    // LinkedIn has taken the post, and says so at a length that pigy
    // does not read to its end.
    ["taken the post", 201],
    ["failed", 500],
  ])(
    "cannot tell what became of the post when LinkedIn has %s and answers with more than pigy reads",
    async (_name, status) => {
      const test = setup();
      const { credentials } = await connect(test);
      test.hooks.intercept = (request) =>
        posts(request)
          ? new Response("x".repeat(300 * 1024), {
              status,
              headers: { "x-restli-id": "urn:li:share:1" },
            })
          : undefined;
      const failed = await failure(() => step(test, credentials, "Hello"));
      expect(failed.kind).toBe("uncertain");
      expect(failed.message).toContain("cannot tell whether the post is on");
    },
  );

  it.each([
    [400, "fail", "LinkedIn refused the request (HTTP 400)."],
    [429, "retry", "LinkedIn is limiting how often pigy may ask today."],
  ] as const)(
    "takes a refusal for one when LinkedIn answers with a %i and more than pigy reads: nothing was posted",
    async (status, kind, message) => {
      const test = setup();
      const { credentials } = await connect(test);
      // A refusal at a length that pigy does not read to its end, as a
      // proxy in front of LinkedIn answers with a page.
      test.hooks.intercept = (request) =>
        posts(request)
          ? new Response("x".repeat(300 * 1024), { status })
          : undefined;
      const failed = await failure(() => step(test, credentials, "Hello"));
      // The status says that LinkedIn did not take the post, whatever the
      // body would have said: nobody has to look at the account.
      expect(failed).toMatchObject({ kind, status, message });
      // Too often is too often for the day, as in an answer that pigy
      // reads: the delivery is tried again and not given up.
      expect(failed.retryAt).toEqual(
        status === 429 ? new Date("2026-11-16T00:00:00Z") : undefined,
      );
    },
  );

  it("cannot tell what became of the post either when LinkedIn sends the request on to another address", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.hooks.intercept = (request) =>
      posts(request)
        ? new Response(null, {
            status: 307,
            headers: { Location: "https://api.linkedin.com/elsewhere" },
          })
        : undefined;
    expect((await failure(() => step(test, credentials, "Hello"))).kind).toBe(
      "uncertain",
    );
  });

  it.each([
    ["no ID", {}],
    ["an ID that is no post", { "x-restli-id": "urn:li:person:abc" }],
  ])(
    "cannot tell which post it made when LinkedIn takes one and answers with %s",
    async (_name, headers) => {
      const test = setup();
      const { credentials } = await connect(test);
      test.hooks.intercept = (request) =>
        posts(request)
          ? new Response(null, { status: 201, headers })
          : undefined;
      expect((await failure(() => step(test, credentials, "Hello"))).kind).toBe(
        "uncertain",
      );
    },
  );

  it("asks to try again at midnight UTC when LinkedIn has been asked too often for the day", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    test.simulator.arm({ kind: "rate-limit", operation: "publish" });
    const failed = await failure(() => step(test, credentials, "Hello"));
    // A refusal says that nothing was posted, so this is no `uncertain`.
    expect(failed.kind).toBe("retry");
    expect(failed.retryAt).toEqual(new Date("2026-11-16T00:00:00Z"));
    expect(published(test)).toEqual([]);
  });

  it("says that pigy has to be updated when LinkedIn has retired its version of the API", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const old = createLinkedInProvider({
      fetch: test.simulator.fetch,
      now: test.world.now,
      clientId: test.client.clientId,
      clientSecret: test.client.clientSecret,
      apiVersion: "202301",
    });
    const failed = await failure(() =>
      old.publishStep({
        credentials,
        content: { parts: [{ text: "Hello" }] },
        key: "target-1",
        progress: null,
      }),
    );
    expect(failed).toMatchObject({ kind: "fail", status: 426 });
    expect(failed.message).toContain("update");
  });

  it("fails for a refusal that says what is wrong with the post, and quotes it", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const failed = await failure(() =>
      step(test, credentials, "a".repeat(3001)),
    );
    expect(failed).toMatchObject({ kind: "fail", status: 422 });
    expect(failed.message).toContain("3001 characters");
    expect(failed.message).not.toContain(credentials.accessToken);
  });
});

describe("images", () => {
  /** An image of `width` by `height` as a content names it, with its bytes. */
  async function imageOf(id: string, alt: string, width = 300, height = 200) {
    const bytes = await pngFile(width, height);
    const image: ContentImage = {
      id,
      type: "image/png",
      size: bytes.length,
      width,
      height,
      alt,
    };
    return { image, bytes };
  }

  /** Where the steps read the bytes of `images` from. */
  const sourceOf = (
    images: { image: ContentImage; bytes: Uint8Array }[],
  ): MediaSource => ({
    read: async (id) => {
      const found = images.find(({ image }) => image.id === id);
      if (!found) throw new Error(`No image ${id}`);
      return found.bytes;
    },
    link: async () => {
      throw new Error("LinkedIn fetches nothing");
    },
  });

  /**
   * Runs the steps of a post until it is done, moving the clock of the
   * world as far as a step asks to wait, and returns the progress after
   * each step.
   */
  async function stepsOf(
    test: Setup,
    credentials: LinkedInCredentials,
    content: PostContent,
    media: MediaSource,
    from: PublishProgress | null = null,
  ) {
    const steps: PublishProgress[] = [];
    let progress = from;
    while (!progress?.done) {
      expect(steps.length).toBeLessThan(30);
      progress = await test.provider.publishStep({
        credentials,
        content,
        key: "target-1",
        progress,
        media,
      });
      steps.push(JSON.parse(JSON.stringify(progress)) as PublishProgress);
      test.world.advance(progress.waitSeconds * 1000);
    }
    return steps;
  }

  /** Whether `request` asks LinkedIn for a new image. */
  const initializes = (request: Request) =>
    request.method === "POST" && request.url.includes("/rest/images");

  it("uploads each image in a step of its own that can be run again, and posts them in one that cannot", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [
      await imageOf("one", "A harbour"),
      await imageOf("two", "", 200, 300),
    ];
    const content: PostContent = {
      parts: [
        { text: "First", media: [images[0]?.image as ContentImage] },
        { text: "Second", media: [images[1]?.image as ContentImage] },
      ],
    };
    const steps = await stepsOf(test, credentials, content, sourceOf(images));

    // Two uploads and the post: the uploads publish nothing.
    expect(steps.map(({ parts }) => parts.length)).toEqual([0, 0, 2]);
    expect(
      [null, ...steps.slice(0, -1)].map((progress) =>
        test.provider.stepRepeatsSafely?.({ content, progress }),
      ),
    ).toEqual([true, true, false]);
    // A post without images is one step, which posts.
    expect(
      test.provider.stepRepeatsSafely?.({
        content: { parts: [{ text: "Text" }] },
        progress: null,
      }),
    ).toBe(false);
    // The URN of each image is noted before the post that names it, and
    // nothing of where its bytes went: that address takes bytes.
    const uploadAddresses = test.requests
      .filter(({ method }) => method === "PUT")
      .map(({ url }) => url);
    expect(uploadAddresses).toHaveLength(2);
    expect(steps[1]?.state).toEqual({
      images: [expect.stringMatching(/^urn:li:image:/), expect.any(String)],
      waits: 0,
    });
    for (const address of uploadAddresses) {
      expect(JSON.stringify(steps)).not.toContain(new URL(address).search);
    }
    // One post, with the images of both parts, in their order.
    expect(
      feed(test.world, ["linkedin"]).map(({ post }) => [
        post.text,
        post.images?.map(({ alt, width }) => [alt, width]),
      ]),
    ).toEqual([
      [
        "First\n\nSecond",
        [
          ["A harbour", 300],
          ["", 200],
        ],
      ],
    ]);
  });

  it("uploads an image again whose answer was lost, and posts it once: a lost upload ends nothing", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Lost once")];
    const content: PostContent = {
      parts: [
        { text: "With an image", media: [images[0]?.image as ContentImage] },
      ],
    };
    test.simulator.arm({ kind: "lost-response", operation: "upload" });
    const lost = await failure(() =>
      test.provider.publishStep({
        credentials,
        content,
        key: "target-1",
        progress: null,
        media: sourceOf(images),
      }),
    );
    // To try again, which the caller does: the step posted nothing.
    expect(lost.kind).toBe("retry");
    expect(test.provider.stepRepeatsSafely?.({ content, progress: null })).toBe(
      true,
    );
    await stepsOf(test, credentials, content, sourceOf(images));
    expect(test.requests.filter(initializes)).toHaveLength(2);
    expect(published(test)).toEqual(["With an image"]);
    expect(feed(test.world)[0]?.post.images).toHaveLength(1);
  });

  it("waits for an image that LinkedIn is still working on, and posts it when it is done", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Slow")];
    const content: PostContent = {
      parts: [{ text: "Slow", media: [images[0]?.image as ContentImage] }],
    };
    test.simulator.arm({ kind: "slow-processing", operation: "upload" });
    const steps = await stepsOf(test, credentials, content, sourceOf(images));
    const waits = steps.filter(({ waitSeconds }) => waitSeconds > 0);
    // Half a minute, in waits of five seconds, and then the post.
    expect(waits).toHaveLength(slowProcessingMs / 5000);
    expect(test.requests.filter(posts)).toHaveLength(1);
    expect(published(test)).toEqual(["Slow"]);
  });

  it("asks to be tried again when LinkedIn works on an image for longer than a minute", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Very slow")];
    const content: PostContent = {
      parts: [{ text: "Very slow", media: [images[0]?.image as ContentImage] }],
    };
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("/rest/images/")
        ? Response.json({ status: "PROCESSING" })
        : undefined;
    const error = await failure(() =>
      stepsOf(test, credentials, content, sourceOf(images)),
    );
    expect(error.kind).toBe("retry");
    expect(test.requests.filter(posts)).toHaveLength(0);
  });

  it("uploads the images again that LinkedIn no longer has, and posts nothing with them", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Dropped")];
    const content: PostContent = {
      parts: [{ text: "Dropped", media: [images[0]?.image as ContentImage] }],
    };
    const [uploaded] = await (async () => {
      const progress = await test.provider.publishStep({
        credentials,
        content,
        key: "target-1",
        progress: null,
        media: sourceOf(images),
      });
      return [progress];
    })();
    // LinkedIn has dropped the image since, as it may one that is in no
    // post for long.
    let dropped = true;
    test.hooks.intercept = (request) => {
      if (dropped && request.method === "GET") {
        dropped = false;
        return Response.json(
          { message: "Not found", status: 404 },
          { status: 404 },
        );
      }
      return undefined;
    };
    const anew = await test.provider.publishStep({
      credentials,
      content,
      key: "target-1",
      progress: uploaded ?? null,
      media: sourceOf(images),
    });
    expect(anew).toMatchObject({ parts: [], state: { images: [] } });
    expect(test.requests.filter(posts)).toHaveLength(0);
    await stepsOf(test, credentials, content, sourceOf(images), anew);
    expect(test.requests.filter(initializes)).toHaveLength(2);
    expect(published(test)).toEqual(["Dropped"]);
  });

  it("fails a post whose image LinkedIn could not take", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Unreadable")];
    const content: PostContent = {
      parts: [
        { text: "Unreadable", media: [images[0]?.image as ContentImage] },
      ],
    };
    test.hooks.intercept = (request) =>
      request.method === "GET" && request.url.includes("/rest/images/")
        ? Response.json({ status: "PROCESSING_FAILED" })
        : undefined;
    const error = await failure(() =>
      stepsOf(test, credentials, content, sourceOf(images)),
    );
    expect(error).toMatchObject({
      kind: "fail",
      message: "LinkedIn could not take the image of the post.",
    });
    expect(test.requests.filter(posts)).toHaveLength(0);
  });

  it("sends the bytes and the token to no host but LinkedIn's", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "Elsewhere")];
    const content: PostContent = {
      parts: [{ text: "Elsewhere", media: [images[0]?.image as ContentImage] }],
    };
    test.hooks.intercept = async (request) => {
      if (!initializes(request)) return undefined;
      const answer = await test.simulator.fetch(request);
      const { value } = (await answer.json()) as {
        value: { uploadUrl: string; image: string };
      };
      return Response.json({
        value: { ...value, uploadUrl: "https://uploads.example/image" },
      });
    };
    const error = await failure(() =>
      stepsOf(test, credentials, content, sourceOf(images)),
    );
    expect(error.kind).toBe("fail");
    expect(test.requests.map(({ url }) => new URL(url).host)).not.toContain(
      "uploads.example",
    );
  });

  it("posts the images of a part with a link, and no preview of the link", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const images = [await imageOf("one", "In place of the card")];
    const content: PostContent = {
      parts: [
        {
          text: "Read https://example.test/",
          card: {
            url: "https://example.test/",
            title: "The page",
            description: "",
          },
          media: [images[0]?.image as ContentImage],
        },
      ],
    };
    await stepsOf(test, credentials, content, sourceOf(images));
    const [{ post } = { post: undefined }] = feed(test.world, ["linkedin"]);
    expect(post?.card ?? null).toBeNull();
    expect(post?.images).toHaveLength(1);
  });
});

describe("deleting", () => {
  it("writes the ID of the post into the address with its colons encoded", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    const { parts } = await step(test, credentials, "To delete");
    const id = parts[0]?.id ?? "";
    await test.provider.deletePost(credentials, id);
    expect(test.requests.at(-1)?.url).toBe(
      `https://api.linkedin.com/rest/posts/${id.replaceAll(":", "%3A")}`,
    );
    expect(published(test)).toEqual([]);
  });

  it("is fine with a post that LinkedIn does not have, and asks nothing for what is no post", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await test.provider.deletePost(credentials, "urn:li:share:1");
    const before = test.requests.length;
    // An ID goes into an address: only what is one gets there.
    const failed = await failure(() =>
      test.provider.deletePost(credentials, "../../v2/userinfo"),
    );
    expect(failed.kind).toBe("fail");
    expect(test.requests).toHaveLength(before);
  });
});

describe("disconnecting", () => {
  it("gives the token back, as the application that it was issued to", async () => {
    const test = setup();
    const { credentials } = await connect(test);
    await test.provider.disconnect(credentials);
    const request = test.requests.at(-1);
    expect(request?.url).toBe("https://www.linkedin.com/oauth/v2/revoke");
    expect((await failure(() => step(test, credentials, "Gone"))).kind).toBe(
      "reconnect",
    );
  });
});
