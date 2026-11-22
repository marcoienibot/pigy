// Not from "@pigy/core": the service worker is one file, and that entry
// point would put all of the package into it.
import { appPath } from "@pigy/core/return-to";
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
 * How long the service worker waits, from the press of a notification,
 * for a window to say that it has heard where to go, in milliseconds,
 * the time that the browser takes to list its windows included.
 *
 * A browser lets a worker bring a window to the front and open one only
 * for a while after the press: Firefox for about a second, and what comes
 * later is refused. So this is well under a second, and a window that
 * answers later has gone where it was told all the same.
 */
export const answerWithinMs = 400;

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
  if (kind === "post_held" && isId(postId)) {
    return {
      title: title("A scheduled post was not sent"),
      body: "pigy got to it more than an hour after its time. Open pigy to send it now or to give it another time.",
      // One tag for a post, whatever is said of it: a post that is sent
      // after it was held and fails has what is said later in this place.
      tag: `post:${postId}`,
      // The Queue screen, which has the post with what can be done.
      url: inWorkspace("/queue", {}, workspaceId),
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
 * `url` of what a notification holds if it is a path of the app, as a
 * notification of this worker carries one, and the inbox otherwise. What
 * a notification holds is read back from the browser, and nothing but a
 * path of the app is opened: by the rule that the window has for where
 * it lets itself be led, `appPath`, which also refuses what a browser
 * reads as another site, such as "/\host".
 */
function pathOf(data: unknown): string {
  const url =
    typeof data === "object" && data !== null && "url" in data
      ? data.url
      : undefined;
  return appPath(url) ?? unread.url;
}

const noop = () => undefined;

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
     * dealt with, or opens one there. It never fails: what the browser
     * refuses is left undone.
     *
     * A window that is open is told where to go and goes there itself,
     * without being loaded again: it may hold what it has not stored. The
     * one that the person sees is taken, or else any. Only a window that
     * shows the app: one at a path of the Worker, such as the consent
     * page of a simulated network, has the address of the app and
     * nothing that listens.
     *
     * The window says that it has heard. One that does not, in what is
     * left of `answerWithinMs` since the press, is a page that is still
     * starting and does not listen yet, a window of another version of
     * the app, or one that is stuck: a window is opened then, so that
     * pressing a notification leads somewhere.
     *
     * A browser gives a worker little for a press: about a second in
     * Firefox, and Chrome, as far as is known, one thing of the two,
     * bringing a window to the front or opening one (PLAN.md section 19).
     * So the order goes by what the window can do:
     *
     * - One that is hidden may have been put aside by the browser, as the
     *   app of a phone that is not on screen, and hears nothing before it
     *   is brought forward. It is brought to the front first, and then
     *   told. If the browser opens no window after that, the person is
     *   in the app at least, and the window goes where it was told when
     *   it hears.
     * - One that the person sees can answer where it is. It is told
     *   first, and brought to the front when it has answered, so that a
     *   window can still be opened when it has not.
     */
    async clicked(data: unknown): Promise<void> {
      const pressedAt = now();
      const url = pathOf(data);
      // Refused when the press no longer counts for the browser. Nothing
      // is left to do about it then.
      const openOne = () => openWindow(url).then(noop, noop);
      const open = (await windows()).filter(isApp);
      const window =
        open.find(({ focused }) => focused) ??
        open.find(({ visibilityState }) => visibilityState === "visible") ??
        open[0];
      if (!window) return openOne();
      // A browser may refuse to bring a window to the front. The window
      // goes where it is told all the same.
      const bring = () => window.focus().then(noop, noop);
      const hidden = window.visibilityState !== "visible";
      // Not waited for before the window is told: the time runs from the
      // press, and a window that the browser takes long to bring forward
      // has its message waiting for it.
      const brought = hidden ? bring() : undefined;
      const { port, answered } = reply(
        Math.max(0, answerWithinMs - (now() - pressedAt)),
      );
      window.postMessage({ ...navigateMessage, url }, [port]);
      if (!(await answered)) return openOne();
      await (brought ?? bring());
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
