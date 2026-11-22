import { navigateMessage, subscriptionChangedMessage } from "./messages.ts";

/**
 * What the service worker does about push messages: it shows a
 * notification for each, and takes the person to where the thing is dealt
 * with when they press it. sw.ts listens to the browser and calls this,
 * which takes what it needs of the browser as parameters, so that its
 * tests need none.
 *
 * A message is JSON of the form that `pushMessageSchema` of @pigy/core
 * describes, encrypted by the Worker for this browser. It says what
 * happened and where, in IDs, and the words are made here: a message
 * waits at a push service and shows on a lock screen, so it carries no
 * text of a post and no name of an account, and neither does what is
 * shown.
 *
 * The service worker of a device can be older than the Worker that sends.
 * A message that it does not understand is shown all the same, in general
 * words: a browser counts a push that shows nothing against the site, and
 * takes the subscription away after a few.
 */

/** A window at the address of the app, as `clients.matchAll` has it. */
export type AppWindow = {
  url: string;
  focused: boolean;
  visibilityState: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown, transfer: unknown[]): void;
};

/**
 * A way for a window to answer a message: `port` goes with the message,
 * and `answered` says whether the window has sent anything back on it in
 * the time that it was given.
 */
export type Reply = { port: unknown; answered: Promise<boolean> };

/**
 * How long a window has to say that it has heard where to go, in
 * milliseconds. A window of the app answers as soon as it is told, so
 * this is how long the person waits for a new window where the one that
 * was asked cannot answer.
 */
export const answerWithinMs = 1000;

/** What this takes from the browser. */
export type PushPlatform = {
  showNotification(
    title: string,
    options: {
      body: string;
      tag: string;
      icon: string;
      badge: string;
      data: { url: string };
    },
  ): Promise<void>;
  /**
   * The windows at the address of the app that are open, in any state.
   * Not all of them are the app: see `isWorkerPath`.
   */
  windows(): Promise<AppWindow[]>;
  openWindow(url: string): Promise<unknown>;
  /**
   * Whether a path is one of the Worker's and not of the app: worker-paths.ts.
   * A window there shows a page of the Worker, such as the consent page of
   * a simulated network, and has nothing that listens to this worker.
   */
  isWorkerPath(pathname: string): boolean;
  /** A way for a window to answer within `milliseconds`. */
  reply(milliseconds: number): Reply;
  /** The time, in milliseconds since the epoch. */
  now(): number;
};

/** What a notification says, and where pressing it leads. */
export type Shown = {
  title: string;
  body: string;
  /** A later notification with the same tag takes the place of this one. */
  tag: string;
  /** A path of the app, with what the screen there is to show. */
  url: string;
};

/** What the networks are called. Not every worker knows every network. */
const networkLabels: Record<string, string> = {
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
  threads: "Threads",
};

/** An ID of a row: a UUID in lowercase. It goes into an address. */
const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

/** The address of the screen at `path`, in the workspace of a message. */
function inWorkspace(
  path: string,
  search: Record<string, string>,
  workspaceId: unknown,
): string {
  const parameters = new URLSearchParams(search);
  // The address names the workspace, so that a tab which shows the other
  // one changes to it: a notification about the sandbox must not open the
  // live workspace, where the post or the account is not. The ID of a
  // workspace is random text of the server's.
  if (typeof workspaceId === "string" && /^[\w-]{1,100}$/.test(workspaceId)) {
    parameters.set("inWorkspace", workspaceId);
  }
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

/** What is shown for a message that this worker cannot read. */
const unread: Shown = {
  title: "pigy",
  body: "Something in pigy needs your attention.",
  tag: "pigy",
  url: "/inbox",
};

const day = 24 * 60 * 60 * 1000;

/**
 * When an access ends that a message tells the end of, in words: by the
 * time that the message names, as far as that is from `now`. A reminder
 * is sent a week before the end, or later, where the server got to it
 * later, and is shown whenever the device gets it. A message without a
 * time, as an older Worker sends it, says no more than that it is soon.
 */
function ends(expiresAt: unknown, now: number): string {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return "ends soon";
  }
  const days = Math.ceil((expiresAt - now) / day);
  if (days <= 0) return "has ended";
  if (days === 1) return "ends within a day";
  // A reminder that is on time: a few minutes short of seven days.
  return days === 7 ? "ends in a week" : `ends in ${days} days`;
}

/**
 * What to show for the push message `text`, which is what arrived,
 * decrypted by the browser, at the time `now`. It never throws: whatever
 * arrived, something is shown.
 */
export function shownFor(text: string | undefined, now: number): Shown {
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    if (typeof parsed !== "object" || parsed === null) return unread;
    message = parsed as Record<string, unknown>;
  } catch {
    return unread;
  }
  if (message.v !== 1) return unread;
  const { kind, workspaceId, postId, channelId } = message;
  // The sandbox says so: nothing that it tells of happened for real.
  const title = (words: string) =>
    message.environment === "sandbox" ? `Sandbox: ${words}` : words;
  const network =
    typeof message.network === "string"
      ? networkLabels[message.network]
      : undefined;
  const account = network ? `your ${network} account` : "an account";

  if ((kind === "post_failed" || kind === "post_uncertain") && isId(postId)) {
    return {
      title: title(
        kind === "post_failed"
          ? "A post was not sent"
          : "pigy cannot tell whether a post arrived",
      ),
      body:
        kind === "post_failed"
          ? "Open pigy to see what went wrong and to try again."
          : "Look at the account before you try again.",
      tag: `post:${postId}`,
      url: inWorkspace("/sent", { post: postId }, workspaceId),
    };
  }
  if (
    (kind === "channel_needs_reconnect" || kind === "channel_expiring") &&
    isId(channelId)
  ) {
    return {
      title: title(
        kind === "channel_needs_reconnect"
          ? `pigy can no longer post to ${account}`
          : `pigy's access to ${account} ${ends(message.expiresAt, now)}`,
      ),
      body:
        kind === "channel_needs_reconnect" ||
        ends(message.expiresAt, now) === "has ended"
          ? "Connect it again to go on posting."
          : "Connect it again to keep posting.",
      tag: `channel:${channelId}`,
      url: inWorkspace("/channels", { reconnect: channelId }, workspaceId),
    };
  }
  // A kind that came after this worker was built.
  return { ...unread, url: inWorkspace("/inbox", {}, workspaceId) };
}

/**
 * `url` if it is a path of the app, as a notification of this worker
 * carries one, and the inbox otherwise. What a notification holds is read
 * back from the browser, and nothing but a path of the app is opened.
 */
function pathOf(data: unknown): string {
  const url =
    typeof data === "object" && data !== null && "url" in data
      ? data.url
      : undefined;
  return typeof url === "string" && /^\/(?!\/)/.test(url) ? url : unread.url;
}

export function push({
  showNotification,
  windows,
  openWindow,
  isWorkerPath,
  reply,
  now,
}: PushPlatform) {
  /** Whether the page in `window` is the app, by its address. */
  const isApp = ({ url }: AppWindow) => {
    try {
      return !isWorkerPath(new URL(url).pathname);
    } catch {
      return false;
    }
  };

  return {
    /** A push message has arrived: shows what it tells of. */
    received(text: string | undefined): Promise<void> {
      const { title, body, tag, url } = shownFor(text, now());
      return showNotification(title, {
        body,
        tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url },
      });
    },

    /**
     * The person has pressed a notification that holds `data`: brings a
     * window of the app to the front and has it go to where the thing is
     * dealt with, or opens one there.
     *
     * A window that is open is told where to go and goes there itself,
     * without being loaded again: it may hold what it has not stored. The
     * one that the person sees is taken, or else any. Only a window that
     * shows the app: one at a path of the Worker, such as the consent
     * page of a simulated network, has the address of the app and
     * nothing that listens.
     *
     * The window says that it has heard. One that does not, in the time
     * that it has, is a page that is still starting and does not listen
     * yet, or one that is stuck: a window is opened then, so that
     * pressing a notification always leads somewhere.
     */
    async clicked(data: unknown): Promise<void> {
      const url = pathOf(data);
      const open = (await windows()).filter(isApp);
      const window =
        open.find(({ focused }) => focused) ??
        open.find(({ visibilityState }) => visibilityState === "visible") ??
        open[0];
      if (!window) {
        await openWindow(url);
        return;
      }
      const { port, answered } = reply(answerWithinMs);
      window.postMessage({ ...navigateMessage, url }, [port]);
      if (!(await answered)) {
        await openWindow(url);
        return;
      }
      // A browser may refuse to bring a window to the front. The window
      // has gone where it was told all the same.
      await window.focus().catch(() => undefined);
    },

    /**
     * The browser has replaced the push subscription of this device, or
     * taken it away. The server sends to the old one, and only a window
     * of the app can hand it another: it knows who is signed in and
     * whether they turned notifications on. So the windows that are open
     * are told, and when none is, the app sees to it when it next starts.
     */
    async changed(): Promise<void> {
      for (const window of (await windows()).filter(isApp)) {
        window.postMessage(subscriptionChangedMessage, []);
      }
    },
  };
}
