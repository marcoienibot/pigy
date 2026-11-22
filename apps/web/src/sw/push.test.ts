import { type PushMessage, pushMessageSchema } from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  type AppWindow,
  answerWithinMs,
  push,
  shownFor as shownAt,
} from "./push.ts";
import { workerPaths } from "./worker-paths.ts";

const now = Date.UTC(2026, 10, 14, 10);
const day = 24 * 60 * 60 * 1000;

/** What is shown for a message that arrives now. */
const shownFor = (text: string | undefined) => shownAt(text, now);

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
    ["channel_expiring", "pigy's access to your LinkedIn account ends soon"],
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
    ).toBe("pigy's access to an account ends soon");
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

  it.each([
    // A reminder that is on time, a little less than seven days before.
    [7 * day - 60_000, "ends in a week", "keep"],
    // The first alarm after a deploy found an access that ends tomorrow.
    [day - 60_000, "ends within a day", "keep"],
    [3 * day - 1, "ends in 3 days", "keep"],
    // The message waited at the push service past the end.
    [-60_000, "has ended", "go on"],
  ])(
    "says when an access ends by the time that the message names: in %i ms it %s",
    (left, ends, verb) => {
      const shown = shownFor(
        sent({
          kind: "channel_expiring",
          environment: "live",
          channelId,
          network: "threads",
          expiresAt: now + left,
        }),
      );

      expect(shown.title).toBe(`pigy's access to your Threads account ${ends}`);
      expect(shown.body).toBe(`Connect it again to ${verb} posting.`);
    },
  );

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

/**
 * A window as a test makes one up. `hears` says whether it answers when
 * it is told where to go, as a window of the app does.
 */
type Made = Partial<AppWindow> & { hears?: boolean };

/** What the browser of a test is, besides its windows. */
type Browser = {
  /** How long the browser takes to list its windows, in milliseconds. */
  listingTakes?: number;
  /** Whether the browser refuses to open a window, as after its time. */
  refusesToOpen?: boolean;
};

/** A browser with these windows at the address of the app open. */
function browser(...open: Made[]) {
  return browserThat({}, ...open);
}

function browserThat(
  { listingTakes = 0, refusesToOpen = false }: Browser,
  ...open: Made[]
) {
  const shown: { title: string; options: unknown }[] = [];
  const opened: string[] = [];
  const waits: number[] = [];
  /** What the worker did about a press, in its order. */
  const did: string[] = [];
  // The clock of the test, which only the test moves.
  let time = now;
  const windows = open.map(({ hears = true, ...window }, index) => ({
    url: `https://pigy.example/window-${index}`,
    focused: false,
    visibilityState: "hidden",
    told: [] as unknown[],
    brought: 0,
    async focus() {
      did.push("focus");
      this.brought += 1;
    },
    postMessage(message: unknown, transfer: unknown[]) {
      did.push("message");
      this.told.push(message);
      // The port that came with the message is how a window answers.
      const [port] = transfer as { answer(): void }[];
      if (hears) port?.answer();
    },
    ...window,
  }));
  const worker = push({
    showNotification: async (title, options) => {
      shown.push({ title, options });
    },
    windows: async () => {
      time += listingTakes;
      return windows;
    },
    openWindow: async (url) => {
      did.push("open");
      if (refusesToOpen) {
        // What a browser fails with once the press no longer counts.
        throw new DOMException(
          "Not allowed to open a window",
          "InvalidAccessError",
        );
      }
      opened.push(url);
    },
    // The paths of the Worker, as wrangler.jsonc has them.
    isWorkerPath: workerPaths(["/api/*", "/connect/*", "/sim/*", "/sync/*"]),
    // A window that has not answered by the time it was told has not
    // answered in time, and the time that it was given has passed then.
    reply: (milliseconds) => {
      waits.push(milliseconds);
      let heard = false;
      return {
        port: {
          answer() {
            heard = true;
          },
        },
        answered: Promise.resolve().then(() => {
          if (!heard) time += milliseconds;
          return heard;
        }),
      };
    },
    now: () => time,
  });
  return {
    worker,
    shown,
    opened,
    windows,
    waits,
    did,
    passed: () => time - now,
  };
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

describe("a subscription that the browser has changed", () => {
  it("is told to the windows of the app, which have the session to hand the server the new one with", async () => {
    const { worker, windows, opened } = browser(
      {},
      // Not a page of the app: nothing there listens.
      { url: "https://pigy.example/sim/network/mastodon/x" },
      {},
    );

    await worker.changed();

    expect(windows.map(({ told }) => told)).toEqual([
      [{ type: "subscription-changed" }],
      [],
      [{ type: "subscription-changed" }],
    ]);
    // With no window open, the app sees to it when it next starts.
    expect(opened).toEqual([]);
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

  it("opens a window when the one that is open does not say that it has heard", async () => {
    // A page of the app that is still starting, and does not listen yet.
    const { worker, opened, windows } = browser({ hears: false });

    await worker.clicked(data);

    expect(windows[0]?.told).toHaveLength(1);
    // Pressing the notification leads somewhere all the same.
    expect(opened).toEqual([data.url]);
  });

  // Firefox lets a worker bring a window to the front, and open one, for
  // about a second after the press, and what comes later is refused. So
  // the whole of it is counted from the press.

  it("opens that window within the time that it has from the press, whatever the browser took to list its windows", async () => {
    const { worker, opened, waits, passed } = browserThat(
      { listingTakes: 150 },
      { hears: false },
    );

    await worker.clicked(data);

    // The window is given what is left of the time, not all of it anew.
    expect(waits).toEqual([answerWithinMs - 150]);
    expect(opened).toEqual([data.url]);
    expect(passed()).toBe(answerWithinMs);
    // Well within the second that a browser gives: an answer that is
    // waited for longer leaves no time to open a window in.
    expect(answerWithinMs).toBeLessThanOrEqual(500);
  });

  it("waits for no answer when the browser has used the time up by itself", async () => {
    const { worker, opened, waits } = browserThat(
      { listingTakes: answerWithinMs + 200 },
      { hears: false },
    );

    await worker.clicked(data);

    expect(waits).toEqual([0]);
    expect(opened).toEqual([data.url]);
  });

  it("brings a window that is hidden to the front before it tells it anything", async () => {
    // A window that the browser has put aside, as the app of a phone that
    // is not on screen: it hears nothing before it is brought forward,
    // so waiting for its answer first would leave it where it is and
    // open a second one.
    const { worker, did, opened } = browser({ visibilityState: "hidden" });

    await worker.clicked(data);

    expect(did).toEqual(["focus", "message"]);
    expect(opened).toEqual([]);
  });

  it("brings a hidden window to the front, tells it, and only then opens one when it does not answer", async () => {
    const { worker, did } = browser({
      visibilityState: "hidden",
      hears: false,
    });

    await worker.clicked(data);

    expect(did).toEqual(["focus", "message", "open"]);
  });

  it("asks a window that the person sees before it brings it to the front", async () => {
    // It can answer where it is, and a browser may count bringing it to
    // the front as what the press was for, and open nothing after that.
    const { worker, did } = browser({ visibilityState: "visible" });

    await worker.clicked(data);

    expect(did).toEqual(["message", "focus"]);
  });

  it("opens a window in place of a visible one that does not answer, and brings nothing to the front", async () => {
    const { worker, did } = browser({
      visibilityState: "visible",
      focused: true,
      hears: false,
    });

    await worker.clicked(data);

    expect(did).toEqual(["message", "open"]);
  });

  it("leaves it at the window that it brought to the front when the browser opens none", async () => {
    const { worker, windows, did } = browserThat(
      { refusesToOpen: true },
      { visibilityState: "hidden", hears: false },
    );

    // The press is done with: an error here would be one of the worker's
    // that nobody can do anything about.
    await expect(worker.clicked(data)).resolves.toBeUndefined();

    expect(did).toEqual(["focus", "message", "open"]);
    expect(windows[0]?.brought).toBe(1);
  });

  it("fails nothing when the browser opens no window and none is open", async () => {
    const { worker } = browserThat({ refusesToOpen: true });

    await expect(worker.clicked(data)).resolves.toBeUndefined();
  });

  it.each([
    ["the consent page of a simulated network", "/sim/network/mastodon/x"],
    ["a page of a connection", "/connect/threads/callback?code=1"],
    ["an answer of the API", "/api/health"],
  ])(
    "does not take a window that shows %s for the app",
    async (_what, path) => {
      // It has the address of the app and the focus, and nothing in it
      // listens to the service worker.
      const { worker, opened, windows } = browser(
        { url: `https://pigy.example${path}`, focused: true, hears: false },
        { url: "https://pigy.example/sent" },
      );

      await worker.clicked(data);

      expect(windows.map(({ told }) => told.length)).toEqual([0, 1]);
      expect(windows[1]?.brought).toBe(1);
      expect(opened).toEqual([]);
    },
  );

  it("opens a window when the only one that is open shows a page of the Worker", async () => {
    const { worker, opened, windows } = browser({
      url: "https://pigy.example/sim/network/mastodon/x",
      focused: true,
      hears: false,
    });

    await worker.clicked(data);

    expect(windows[0]?.told).toEqual([]);
    expect(opened).toEqual([data.url]);
  });

  it.each([
    ["no data", undefined],
    ["an address at another site", { url: "https://elsewhere.example/" }],
    ["an address that leaves the site", { url: "//elsewhere.example/" }],
    // A browser reads a backslash as a slash, and drops a tab: it would
    // open both at another site.
    ["the same with a backslash", { url: "/\\elsewhere.example/" }],
    ["the same with a tab in it", { url: "/\t/elsewhere.example/" }],
    ["what is no address", { url: 7 }],
  ])("leads to the inbox for a notification with %s", async (_what, held) => {
    const { worker, opened } = browser();

    await worker.clicked(held);

    expect(opened).toEqual(["/inbox"]);
  });
});
