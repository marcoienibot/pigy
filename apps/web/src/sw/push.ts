import { navigateMessage } from "./messages.ts";

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

/** A window of the app, as `clients.matchAll` has it. */
export type AppWindow = {
  url: string;
  focused: boolean;
  visibilityState: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
};

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
  /** The windows of the app that are open, in any state. */
  windows(): Promise<AppWindow[]>;
  openWindow(url: string): Promise<unknown>;
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

/**
 * What to show for the push message `text`, which is what arrived,
 * decrypted by the browser. It never throws: whatever arrived, something
 * is shown.
 */
export function shownFor(text: string | undefined): Shown {
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
          : `pigy's access to ${account} ends in a week`,
      ),
      body:
        kind === "channel_needs_reconnect"
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

export function push({ showNotification, windows, openWindow }: PushPlatform) {
  return {
    /** A push message has arrived: shows what it tells of. */
    received(text: string | undefined): Promise<void> {
      const { title, body, tag, url } = shownFor(text);
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
     * one that the person sees is taken, or else any.
     */
    async clicked(data: unknown): Promise<void> {
      const url = pathOf(data);
      const open = await windows();
      const window =
        open.find(({ focused }) => focused) ??
        open.find(({ visibilityState }) => visibilityState === "visible") ??
        open[0];
      if (!window) {
        await openWindow(url);
        return;
      }
      window.postMessage({ ...navigateMessage, url });
      // A browser may refuse to bring a window to the front. The window
      // has gone where it was told all the same.
      await window.focus().catch(() => undefined);
    },
  };
}
