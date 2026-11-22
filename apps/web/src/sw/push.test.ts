import { type PushMessage, pushMessageSchema } from "@pigy/core";
import { describe, expect, it } from "vitest";
import { type AppWindow, push, shownFor } from "./push.ts";

const workspaceId = "0d8c2f7e-5a1b-4c3d-9e8f-7a6b5c4d3e2f";
const postId = "01932c07-0000-7000-8000-000000000001";
const channelId = "01932c07-0000-7000-8000-000000000002";

/**
 * A message as the Worker sends it: checked against the schema that the
 * Worker makes its messages by, so that these tests are about messages
 * that exist.
 */
const sent = (message: Omit<PushMessage, "v" | "workspaceId">) =>
  JSON.stringify(pushMessageSchema.parse({ v: 1, workspaceId, ...message }));

describe("what a push message is shown as", () => {
  it("says that a post was not sent, and leads to the post in its workspace", () => {
    expect(
      shownFor(sent({ kind: "post_failed", environment: "live", postId })),
    ).toEqual({
      title: "A post was not sent",
      body: "Open pigy to see what went wrong and to try again.",
      tag: `post:${postId}`,
      url: `/sent?post=${postId}&inWorkspace=${workspaceId}`,
    });
  });

  it("says that nobody knows where a post ended, where that is so", () => {
    expect(
      shownFor(sent({ kind: "post_uncertain", environment: "live", postId })),
    ).toMatchObject({
      title: "pigy cannot tell whether a post arrived",
      body: "Look at the account before you try again.",
      // The same tag as for a failure: what is said of a post later takes
      // the place of what was said before.
      tag: `post:${postId}`,
    });
  });

  it("names the sandbox, where nothing happened for real", () => {
    expect(
      shownFor(sent({ kind: "post_failed", environment: "sandbox", postId }))
        .title,
    ).toBe("Sandbox: A post was not sent");
  });

  it.each([
    [
      "channel_needs_reconnect",
      "pigy can no longer post to your LinkedIn account",
    ],
    [
      "channel_expiring",
      "pigy's access to your LinkedIn account ends in a week",
    ],
  ] as const)(
    "says of %s which network, and leads to connecting the account again",
    (kind, title) => {
      expect(
        shownFor(
          sent({ kind, environment: "live", channelId, network: "linkedin" }),
        ),
      ).toMatchObject({
        title,
        tag: `channel:${channelId}`,
        url: `/channels?reconnect=${channelId}&inWorkspace=${workspaceId}`,
      });
    },
  );

  it("does without the name of a network that it does not know", () => {
    const message = JSON.parse(
      sent({ kind: "channel_expiring", environment: "live", channelId }),
    );

    // A network that came after this worker was built.
    expect(
      shownFor(JSON.stringify({ ...message, network: "nextwork" })).title,
    ).toBe("pigy's access to an account ends in a week");
  });

  it.each([
    ["nothing", undefined],
    ["what is no JSON", "hello"],
    ["JSON that is no message", "[1]"],
    [
      "a message of another version",
      JSON.stringify({ v: 2, kind: "post_failed", postId }),
    ],
  ])("shows %s in general words, and leads to the inbox", (_what, text) => {
    expect(shownFor(text)).toEqual({
      title: "pigy",
      body: "Something in pigy needs your attention.",
      tag: "pigy",
      url: "/inbox",
    });
  });

  it("shows a kind that it does not know in general words, in the workspace that it is about", () => {
    const text = JSON.stringify({ v: 1, kind: "queue_empty", workspaceId });

    expect(shownFor(text)).toMatchObject({
      title: "pigy",
      url: `/inbox?inWorkspace=${workspaceId}`,
    });
  });

  it.each([
    ["a post", { kind: "post_failed", postId: "../../api/auth/sign-out" }],
    ["a channel", { kind: "channel_expiring", channelId: "x&add=true" }],
  ])(
    "puts nothing into an address that is not the ID of %s",
    (_what, fields) => {
      const shown = shownFor(JSON.stringify({ v: 1, workspaceId, ...fields }));

      expect(shown.url).toBe(`/inbox?inWorkspace=${workspaceId}`);
    },
  );

  it("leaves out a workspace that is no ID of one", () => {
    const text = JSON.stringify({
      v: 1,
      kind: "post_failed",
      postId,
      workspaceId: "a&post=other",
    });

    expect(shownFor(text).url).toBe(`/sent?post=${postId}`);
  });
});

/** A browser with these windows of the app open. */
function browser(...open: Partial<AppWindow>[]) {
  const shown: { title: string; options: unknown }[] = [];
  const opened: string[] = [];
  const windows = open.map((window, index) => ({
    url: `https://pigy.example/window-${index}`,
    focused: false,
    visibilityState: "hidden",
    told: [] as unknown[],
    brought: 0,
    async focus() {
      this.brought += 1;
    },
    postMessage(message: unknown) {
      this.told.push(message);
    },
    ...window,
  }));
  const worker = push({
    showNotification: async (title, options) => {
      shown.push({ title, options });
    },
    windows: async () => windows,
    openWindow: async (url) => {
      opened.push(url);
    },
  });
  return { worker, shown, opened, windows };
}

describe("a push message that arrives", () => {
  it("is shown as a notification that holds where it leads", async () => {
    const { worker, shown } = browser();

    await worker.received(
      sent({ kind: "post_failed", environment: "live", postId }),
    );

    expect(shown).toEqual([
      {
        title: "A post was not sent",
        options: {
          body: "Open pigy to see what went wrong and to try again.",
          tag: `post:${postId}`,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          data: { url: `/sent?post=${postId}&inWorkspace=${workspaceId}` },
        },
      },
    ]);
  });

  it("is shown also when nothing can be read of it", async () => {
    const { worker, shown } = browser();

    // A browser takes a subscription away from a site whose messages
    // show nothing.
    await worker.received(undefined);

    expect(shown).toHaveLength(1);
  });
});

describe("a notification that is pressed", () => {
  const data = { url: `/sent?post=${postId}&inWorkspace=${workspaceId}` };

  it("opens a window at the screen when none is open", async () => {
    const { worker, opened } = browser();

    await worker.clicked(data);

    expect(opened).toEqual([data.url]);
  });

  it("tells a window that is open where to go, and brings it to the front", async () => {
    const { worker, opened, windows } = browser({});

    await worker.clicked(data);

    // The window goes there itself: it is not loaded again, and no second
    // one is opened.
    expect(windows[0]?.told).toEqual([{ type: "navigate", url: data.url }]);
    expect(windows[0]?.brought).toBe(1);
    expect(opened).toEqual([]);
  });

  it("takes the window that the person sees", async () => {
    const { worker, windows } = browser(
      {},
      { visibilityState: "visible" },
      { visibilityState: "visible", focused: true },
    );

    await worker.clicked(data);

    expect(windows.map(({ told }) => told.length)).toEqual([0, 0, 1]);
  });

  it("takes a window that is visible when none has the focus", async () => {
    const { worker, windows } = browser({}, { visibilityState: "visible" });

    await worker.clicked(data);

    expect(windows.map(({ told }) => told.length)).toEqual([0, 1]);
  });

  it("goes on when the browser does not bring the window to the front", async () => {
    const { worker, windows } = browser({
      focus: async () => {
        throw new Error("Not allowed to focus");
      },
    });

    await worker.clicked(data);

    expect(windows[0]?.told).toHaveLength(1);
  });

  it.each([
    ["no data", undefined],
    ["an address at another site", { url: "https://elsewhere.example/" }],
    ["an address that leaves the site", { url: "//elsewhere.example/" }],
    ["what is no address", { url: 7 }],
  ])("leads to the inbox for a notification with %s", async (_what, held) => {
    const { worker, opened } = browser();

    await worker.clicked(held);

    expect(opened).toEqual(["/inbox"]);
  });
});
