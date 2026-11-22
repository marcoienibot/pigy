import {
  type MeResponse,
  meResponseSchema,
  type Workspace,
  workspaceListResponseSchema,
} from "@pigy/core";
import {
  ApiError,
  answeredInTime,
  fetchMe,
  fetchWorkspaces,
  signOut,
  unanswered,
} from "@/lib/api";
import { forgetTabChoice, forgetWorkspaceChoice } from "@/lib/workspace";
import { countUnsynced, deleteCopies } from "@/sync/indexed-db";
import {
  closeWorkspaceSync,
  holdUnsaved,
  stopWorkspaceConnections,
  unsavedInOtherWindow,
  unsavedInWindowsOf,
  whenSaved,
} from "@/sync/workspace-sync";

/**
 * Who is signed in on this device and which workspaces they have, as the
 * server last said. It is kept in `localStorage`, next to the local copies
 * of the workspaces, because the app has to know whose copy to show before
 * the server has answered, and when it does not answer at all.
 *
 * What is kept is not what lets anybody in: that is the session cookie,
 * which the server checks. It decides which local copy is shown, and the
 * server is asked in the background whether it is still right. If it is
 * not, the copies go, as PLAN.md section 16 asks. The one exception is a
 * copy with changes that were never synced: see `endSession`.
 */
export type Session = { me: MeResponse; workspaces: Workspace[] };

const storageKey = "pigy-session";

/**
 * `ended`: the server has said that the session is over. The copies are
 * still there: `endSession` deletes them, and this with them, once they
 * hold nothing that was not synced and no window needs them.
 *
 * `key` tells the sessions of one person on this device apart: it is made
 * when a session is taken on, see `adopt`, and what a tab has found out
 * about one session is not acted on when the device holds another by then.
 * A session that a version of the app before this one stored has none.
 */
type Stored = Session & { ended: boolean; key: string | undefined };

function read(): Stored | null {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const me = meResponseSchema.safeParse(stored?.me);
    const list = workspaceListResponseSchema.safeParse({
      workspaces: stored?.workspaces,
    });
    if (!me.success || !list.success) return null;
    return {
      me: me.data,
      workspaces: list.data.workspaces,
      ended: stored.ended === true,
      key: typeof stored.key === "string" ? stored.key : undefined,
    };
  } catch {
    return null;
  }
}

function write(
  { me, workspaces }: Session,
  { ended, key }: Pick<Stored, "ended" | "key">,
): void {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ me, workspaces, ended, key }),
  );
}

/**
 * A name for the session that this device holds, for what the device
 * remembers of that session and of no other, such as that notifications
 * were turned on in it. Null if it holds none, or one that is over.
 */
export function sessionOnDevice(): string | null {
  const stored = read();
  return stored && !stored.ended && stored.key !== undefined
    ? `${stored.me.user.id}/${stored.key}`
    : null;
}

/**
 * What this device holds now, if that is still the session `of`: the same
 * person and the same key. Null if it holds another one, or none.
 */
function still(of: Stored): Stored | null {
  const now = read();
  return now && now.me.user.id === of.me.user.id && now.key === of.key
    ? now
    : null;
}

/**
 * Asks the server. Null if nobody is signed in, and an error if it is
 * silent or says that something went wrong. It is silent too when it has
 * not answered both questions in the time that `answeredInTime` gives.
 */
function fetchSession(signal?: AbortSignal): Promise<Session | null> {
  return answeredInTime(async (signal) => {
    const me = await fetchMe(signal);
    if (!me) return null;
    try {
      return { me, workspaces: await fetchWorkspaces(signal) };
    } catch (error) {
      // Signed out between the two requests.
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }, signal);
}

/**
 * Why `loadSession` has no answer: this device does not know who is
 * signed in, and no answer came from the server. That is the start without
 * a connection of somebody who has signed out, or who has never signed in
 * on this device. It is not a server that answers with an error: nothing
 * that the device can wait for cures that.
 */
export class SessionUnknown extends Error {
  constructor(cause: unknown) {
    super("The server cannot be reached", { cause });
  }
}

const listeners = new Set<() => void>();

/**
 * Calls `listener` when the server has said something else about who is
 * signed in than what the screens were given: another name or role.
 */
export function onSessionChange(listener: () => void): void {
  listeners.add(listener);
}

/**
 * Who is signed in, for a screen that needs a session. Null if nobody is.
 *
 * If this device knows, it answers at once, so the app starts without
 * waiting for the network, and without a network at all. With `check`, the
 * server is asked in the background whether the device is still right: see
 * `checkSessionSoon`. If this device does not know, the server is asked
 * whatever `check` says, and nothing is shown before it has answered. If
 * it does not answer, this throws `SessionUnknown`, and if it answers that
 * something went wrong, the error that says so.
 */
export async function loadSession(
  signal: AbortSignal,
  { check }: { check: boolean },
): Promise<Session | null> {
  const stored = read();
  if (stored && !stored.ended) {
    if (check) checkSessionSoon();
    return stored;
  }
  // This tab has learned that the session is over and stays for what it
  // has not stored: see `sessionOver`. A navigation in it meanwhile, in
  // the moment before the tab says that it waits, stays in the app. Sent
  // to the sign-in page, the tab would end the session there and close
  // its stores under the changes that it waits for. It leaves by itself.
  if (stored && over) return stored;
  let fresh: Session | null;
  try {
    fresh = await fetchSession(signal);
  } catch (error) {
    // The session that this device knows of is over, and whether there is
    // a new one cannot be found out: the sign-in page says what is left.
    // It does not ask the server a second time when this question got no
    // answer, which would be the same wait once more.
    if (stored) {
      if (!signal.aborted && unanswered(error)) {
        unansweredAt = performance.now();
      }
      return null;
    }
    // The router has given this navigation up, and wants no answer.
    if (signal.aborted) throw error;
    // Only a request that got no answer says that the server cannot be
    // reached. An answer that is an error is shown as what it is.
    throw unanswered(error) ? new SessionUnknown(error) : error;
  }
  if (!fresh) return null;
  await adopt(fresh);
  return fresh;
}

/**
 * When a question of `loadSession` about a session that is over got no
 * answer, on the clock of `performance.now()`: see `serverJustSilent`.
 */
let unansweredAt = Number.NEGATIVE_INFINITY;

/**
 * Whether the server has just left `loadSession` without an answer, on the
 * way to the sign-in page: that page then says so without asking again.
 * True once per such question, and only right after it: whoever tries
 * again asks the server.
 */
export function serverJustSilent(): boolean {
  const just = performance.now() - unansweredAt < 1_000;
  unansweredAt = Number.NEGATIVE_INFINITY;
  return just;
}

/**
 * The Web Lock under which a window takes a session on, and under which it
 * deletes what the device holds of one: see `alone`. Deleting is several
 * steps, which wait for the browser, and a session that is taken on in
 * their middle would have its copies deleted with the changes that it has
 * stored in them by then.
 *
 * The name is a contract between the versions of the app, and must not
 * change: the window that signs somebody in and the window that cleans up
 * can run different versions, and under two names they would not wait for
 * each other. A window of a version before this one takes no lock at all.
 */
const sessionLock = "pigy/session";

/**
 * Runs `work` while no other window of this browser takes a session on or
 * deletes what is left of one: one after the other, under `sessionLock`.
 * Whoever deletes looks at what the device holds once it has the lock, and
 * not before. Where there are no Web Locks, nothing keeps the windows
 * apart, and that look is all there is.
 */
function alone<T>(work: () => Promise<T>): Promise<T> {
  if (!("locks" in navigator)) return work();
  return navigator.locks.request(sessionLock, work);
}

/**
 * Makes `session` the one that this device knows of. Whoever signs in gets
 * a device without anybody else's data. If a session of their own ended
 * here with changes that were not synced, the changes are theirs again,
 * and are sent now.
 *
 * Not while another window deletes what a session has left, see `alone`:
 * the copies that it deletes would be those of this session a moment
 * later.
 */
async function adopt(session: Session): Promise<void> {
  await alone(async () => {
    await deleteCopies(session.me.user.id);
    write(session, { ended: false, key: crypto.randomUUID() });
  });
}

let checking: Promise<void> | undefined;

/**
 * The least time between two questions to the server that are asked
 * because the person moved about in the app, in milliseconds.
 */
const checkEveryMs = 2_000;

/** When the server was last asked, on the clock of `performance.now()`. */
let checkedAt = Number.NEGATIVE_INFINITY;
let checkTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Asks the server whether the session that this device knows of is still
 * the one it has, and acts on the answer. No answer changes nothing: the
 * device is offline.
 *
 * This asks now. It is for when there is a reason to doubt the session,
 * such as a sync socket that the server has refused.
 */
export function checkSession(): Promise<void> {
  checkedAt = performance.now();
  clearTimeout(checkTimer);
  checkTimer = undefined;
  checking ??= check().finally(() => {
    checking = undefined;
  });
  return checking;
}

/**
 * Asks the server as `checkSession` does, for a navigation: at once if it
 * was last asked longer than `checkEveryMs` ago, and otherwise when that
 * time is over. Every navigation in the app comes through here, and
 * moving through a list of drafts with the keyboard is many of them in a
 * second: they are answered with one question. Somebody whose session has
 * ended is still sent to the sign-in page by the next link they follow, a
 * moment later at most.
 */
function checkSessionSoon(): void {
  if (checkTimer !== undefined) return;
  const wait = checkedAt + checkEveryMs - performance.now();
  if (wait <= 0) void checkSession();
  else checkTimer = setTimeout(() => void checkSession(), wait);
}

/**
 * How long a tab whose session has ended waits for the changes that it has
 * not stored before it says that it is waiting, in milliseconds: see
 * `savedOrDiscarded`. A write that is under way is over well within this.
 */
export const saveWaitMs = 2_000;

/** The wait of `savedOrDiscarded`, while this tab is in it. */
let saving: Promise<void> | undefined;
/** Ends that wait: the person has chosen to go without the changes. */
let discard: (() => void) | undefined;
/** Whether the wait has taken longer than `saveWaitMs`. */
let held = false;
const heldListeners = new Set<() => void>();

/**
 * For a tab whose session has ended by itself, before it leaves: resolves
 * when the tab holds no change that is not stored, in either workspace.
 * Such a change is in the memory of the tab and nowhere else, and the page
 * load that follows would lose it. Once it is stored, it is in the copy,
 * which `endSession` keeps for the person to sign in again.
 *
 * That is at once unless a change is being written or could not be
 * written. The first is over in a moment. The second can last, on a device
 * that has no room left, and the store tries again every few seconds: when
 * the wait has taken `saveWaitMs`, the tab says over the app that the
 * session has ended and what it waits for, see `SessionEnded`, and the
 * person can choose to go without the changes. Nobody else chooses that
 * for them.
 *
 * For the whole wait the tab holds the Web Lock that says so to the other
 * windows, see `holdUnsaved`: a sign-in page that is opened meanwhile
 * keeps the copies, also for a write that is under way and has not failed.
 *
 * Nothing is sent for the session that is over meanwhile. The server
 * would take it: it serves a socket that was open when a session ended
 * for up to five minutes more, SYNC.md section 2. So whoever starts this
 * wait has taken the tab off the network first, with
 * `stopWorkspaceConnections`: see `sessionOver`.
 */
function savedOrDiscarded(): Promise<void> {
  saving ??= new Promise<void>((resolve) => {
    holdUnsaved();
    const timer = setTimeout(() => {
      held = true;
      for (const listener of heldListeners) listener();
    }, saveWaitMs);
    discard = () => {
      clearTimeout(timer);
      resolve();
    };
    void whenSaved().then(discard);
  });
  return saving;
}

/**
 * Whether this tab stays open after its session has ended because it holds
 * changes that it has not stored, and has done so for longer than a write
 * takes: what `SessionEnded` shows. With how to hear of it.
 */
export function sessionEndHeld(): boolean {
  return held;
}

export function onSessionEndHeld(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
}

/**
 * Lets the tab that `sessionEndHeld` is true of leave, without the
 * changes that it could not store: the person has said so.
 *
 * The stores of the tab are shut here and now, whatever another tab has
 * done to the session meanwhile: that is what lets the changes go, and
 * with them the question that the browser asks before a page leaves with
 * such changes, which the person has just answered. If the page is still
 * there when this is called again, the leave did not happen, and the tab
 * leaves for the sign-in page now, which looks after what is left.
 */
export function discardUnsaved(): void {
  closeWorkspaceSync();
  if (discarded) {
    left = false;
    go(toSignIn);
    return;
  }
  discarded = true;
  discard?.();
}

/** Whether the person has let the changes of this tab go. */
let discarded = false;

/** Whether this tab has begun to leave the page. It does so once. */
let left = false;

/** Leaves the page, with `leave`, unless the tab is leaving already. */
function go(leave: () => void): void {
  if (left) return;
  left = true;
  leave();
}

/** To the sign-in page, and from there back to where the tab is. */
function toSignIn(): void {
  // A full page load, so that nothing of the session stays in memory.
  const here = location.pathname + location.search + location.hash;
  location.assign(
    here === "/"
      ? "/sign-in"
      : `/sign-in?${new URLSearchParams({ returnTo: here })}`,
  );
}

/** Starts the tab again, as whoever this device now says is signed in. */
function startAgain(): void {
  closeWorkspaceSync();
  location.reload();
}

/** The end of a session as this tab sees it through, once: `sessionOver`. */
let over: Promise<void> | undefined;

/**
 * For a tab that has learned that the session `of`, which this device
 * holds, is over without the person's doing: from the server, with
 * `found`, or from another tab. In this order:
 *
 * 1. The device records that the session is over, at once. A tab that is
 *    opened from now on does not show the copies as if the session were
 *    good, and the other tabs hear of the end now and not when this one
 *    has stored its changes.
 * 2. The tab goes off the network, and stays for what it has not stored:
 *    `savedOrDiscarded`.
 * 3. It looks again at what the device holds, because the wait can have
 *    lasted, and what was true before it may not be: the same person can
 *    have signed in again, in another tab. Only if the device still holds
 *    this session, ended, does the tab go on as it began: the one that
 *    found out decides what becomes of the copies, with `endSession`, and
 *    goes to the sign-in page, and one that heard of it starts again, which
 *    takes it there. Otherwise it ends nothing: it starts again, as
 *    whoever is signed in now.
 *
 * A tab that leaves for another reason meanwhile, because somebody else
 * has signed in or the person has signed out, has left: nothing here acts
 * after that, and no tab leaves twice.
 */
function sessionOver(of: Stored, { found }: { found: boolean }): void {
  over ??= (async () => {
    if (!of.ended) write(of, { ended: true, key: of.key });
    stopWorkspaceConnections();
    await savedOrDiscarded();
    // Signing out leaves by itself, and has dealt with the session.
    if (left || signingOut) return;
    if (!found || !still(of)?.ended) {
      go(startAgain);
      return;
    }
    // If this fails, as IndexedDB can on a device that is in trouble, the
    // sign-in page finds what is left and deals with it.
    await endSession().catch((error: unknown) => console.error(error));
    go(toSignIn);
  })();
}

async function check(): Promise<void> {
  const stored = read();
  if (!stored || stored.ended || signingOut || left) return;
  let fresh: Session | null;
  try {
    fresh = await fetchSession();
  } catch {
    return;
  }
  if (signingOut || left) return;
  // The answer is about the session that the device held when the server
  // was asked. If it holds another one by now, or none, the answer says
  // nothing about that one, and the `storage` listener below has seen to
  // this tab.
  const now = still(stored);
  if (!now) return;
  if (!fresh) {
    sessionOver(now, { found: true });
    return;
  }
  if (fresh.me.user.id !== stored.me.user.id) {
    // Somebody else has signed in without passing the sign-in page, which
    // would have dealt with the session before: only the address that
    // starts a sign-in does that. This tab shows the data of the person
    // before, so it starts again as the new one, at once: what it could
    // not store is not waited for, because what a device holds of one
    // person goes when another signs in, stored or not.
    left = true;
    closeWorkspaceSync();
    await adopt(fresh);
    location.reload();
    return;
  }
  // Another tab has heard that the session is over, and this answer was
  // on its way before that. The tabs are leaving for the sign-in page,
  // which asks the server again.
  if (now.ended) return;
  write(fresh, now);
  if (JSON.stringify(fresh.me) !== JSON.stringify(stored.me)) {
    for (const listener of listeners) listener();
  }
}

/**
 * For when the server has said that the session this device knows of is
 * over. It records that at once, if nothing has yet, so that no tab shows
 * the copies as if the session were good. Then it deletes the local copies
 * of its user and forgets the user.
 *
 * Unless the copies hold changes that were never synced. A session ends
 * without the person's doing, after 30 days or when an invitation is
 * withdrawn, and deleting then would lose work that nobody chose to lose.
 * The copies stay, and are not shown to anybody: the sign-in page says
 * that they are there. They are synced when the same person signs in
 * again, and deleted when somebody else does or when the person says so.
 *
 * They also stay while another window holds changes that it has not
 * stored: that window has heard that the session is over, or is about to,
 * and waits until it has stored them, which takes the copy. See
 * `sessionOver`. The tab that calls this has waited for its own, if it had
 * any, and its sync is closed here.
 *
 * The sign-in page calls this every time it is loaded, so copies that were
 * kept for a window, or for changes that have been synced or deleted
 * since, go the next time somebody is there and nothing needs them.
 *
 * What it reads at its start can be untrue a moment later: the same
 * person signs in again in another tab. So it deletes under the lock that
 * a session is taken on under, see `alone`, and looks again once it has
 * the lock: it leaves a session alone that is not the one it found over,
 * and no session begins while it deletes.
 */
export async function endSession(): Promise<void> {
  const stored = read();
  if (stored && !stored.ended) write(stored, { ended: true, key: stored.key });
  closeWorkspaceSync();
  // Whether the device still holds what this was called about: the same
  // session, ended, or nobody.
  const unchanged = () =>
    stored ? still(stored)?.ended === true : read() === null;
  if (stored) {
    if (await unsavedInOtherWindow()) return;
    if ((await countUnsynced(stored.me.user.id)) > 0) return;
  }
  await alone(async () => {
    if (!unchanged()) return;
    // Also when this device knows of nobody: a copy can be left behind by
    // a deletion that failed.
    await deleteCopies();
    // Once more, for a browser without Web Locks, where a session can
    // have begun meanwhile: its record at least is left alone.
    if (!unchanged()) return;
    localStorage.removeItem(storageKey);
    forgetWorkspaceChoice();
  });
}

/**
 * Whether this device holds a session that it takes to be good: the server
 * has not said that it is over. The app shows the copies of such a session
 * before the server has been asked, and deletes them when somebody else
 * turns out to be signed in: see `check`.
 */
export function holdsSession(): boolean {
  const stored = read();
  return stored !== null && !stored.ended;
}

/**
 * The changes on this device that were kept when a session ended, and
 * whose they are. Null if there are none. `count` is what the copies hold.
 * `unstored` is what other windows say that they could not store: they are
 * in no copy, and those windows stay open for them, see `sessionOver`.
 * `unknown` says that a window holds changes that it has not stored and
 * has not said how many, see `unsavedInWindowsOf`: there is something to
 * lose then, also if nothing was counted. Whatever discards the first
 * discards the others, so whoever asks about that says all three.
 */
export async function keptChanges(): Promise<{
  count: number;
  unstored: number;
  unknown: boolean;
  email: string;
} | null> {
  const stored = read();
  if (!stored?.ended) return null;
  const { id, email } = stored.me.user;
  // In this order, as the sign-out counts: a change that a window stores
  // in between is counted twice and not left out.
  const { count: unstored, unknown } = await unsavedInWindowsOf(id);
  const count = await countUnsynced(id);
  return count + unstored > 0 || unknown
    ? { count, unstored, unknown, email }
    : null;
}

// The other tabs of this browser follow what this module stores: when
// the person signs out in one of them, or somebody else signs in, they
// start again, and find out who is signed in the way a new tab does.
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || event.oldValue === event.newValue) return;
  const whose = (value: string | null): [unknown, unknown] | null => {
    try {
      const stored = JSON.parse(value ?? "null");
      return stored ? [stored.me?.user?.id, stored.ended] : null;
    } catch {
      return null;
    }
  };
  const before = whose(event.oldValue);
  const after = whose(event.newValue);
  // Not for a name or a role that changed: `checkSession` handles those
  // in every tab.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    // The choice between live and sandbox that this tab keeps was that of
    // whoever was signed in. They are gone, or somebody else is here: the
    // tab that saw to that has forgotten its own choice and the device's,
    // and cannot reach this one. Whoever signs in here next then starts
    // where somebody new does, also if it is the same person. Not when
    // the session of the same person has only ended by itself, or begun
    // again: they come back to what they left.
    if (before?.[0] !== after?.[0]) forgetTabChoice();
    const same = after !== null && after[0] === before?.[0];
    const stored = read();
    // The session of the person has ended by itself, and another tab has
    // found out. What this tab has not stored is stored before it starts
    // again, as in the tab that found out: see `sessionOver`. That reads
    // what the device holds now, which can be later news than this event.
    if (same && after[1] === true) {
      if (stored?.ended && stored.me.user.id === after[0]) {
        sessionOver(stored, { found: false });
      }
      return;
    }
    // The same person is signed in again while this tab waits for what it
    // has not stored after their session had ended. It goes on waiting:
    // starting again now would lose those changes for nothing. When the
    // wait is over, the tab starts again as whoever is signed in then.
    if (same && over) return;
    // The same person is signed in again, and this tab does not wait:
    // their session had ended, and the tab either has no session to show,
    // as the sign-in page, or has not acted on the end, because it slept
    // through it and now hears of the end and of the new session at once.
    // It starts again, which takes the first into the app and brings the
    // second to what a new tab would be. Nothing presses: the person and
    // the copies are the same. So it stores first what it has not stored,
    // which the page load would lose, and the browser's question would
    // not be asked: `startAgain` shuts the stores. That is at once for a
    // tab that holds nothing. If the session has ended again by then,
    // `sessionOver` has the tab, and for anything else it has left.
    if (same) {
      void whenSaved().then(() => {
        if (!over) go(startAgain);
      });
      return;
    }
    // Anything else is no reason to wait, also for a tab that waits
    // already: the person has signed out or has had the changes that were
    // kept deleted, which they were asked about, or somebody else has
    // signed in, and nothing of the person before is shown to them.
    go(startAgain);
  }
});

/**
 * Whether the person is signing out. From then on the server says that the
 * session is over, and that is no news: acted on, it would send the page,
 * which is about to leave, to the sign-in page with a way back, and keep
 * the copies that the person has just agreed to delete. So until the page
 * has left, nothing is asked and no answer is acted on.
 */
let signingOut = false;

/**
 * Signs the person out because they say so, and deletes what this device
 * holds of them: see `forgetSession`. Throws if the server has not
 * confirmed that the session is over. Nothing is deleted then.
 */
export async function signOutAndForget(): Promise<void> {
  signingOut = true;
  try {
    await signOut();
  } catch (error) {
    signingOut = false;
    throw error;
  }
  // Signing out leaves nothing of the person on the device. If deleting
  // fails, the sign-in page finds what is left and deals with it.
  await forgetSession().catch((error: unknown) => console.error(error));
}

/**
 * Deletes everything that this device holds of the person who was signed
 * in: the local copies of both their workspaces, with the changes in them
 * that were not synced, who it was, and which workspace they chose to see.
 * For after the server has ended the session, or to discard what was kept
 * of a session that ended by itself.
 *
 * That is the session that the device holds when this is called. Like
 * `endSession`, it deletes under the lock that a session is taken on
 * under, and deletes nothing if the device holds another session by the
 * time it has the lock: somebody has signed in meanwhile, in another tab.
 */
export async function forgetSession(): Promise<void> {
  const stored = read();
  closeWorkspaceSync();
  await alone(async () => {
    if (read() !== null && !(stored && still(stored))) return;
    // Tabs that have a copy open let go of it when it is deleted.
    await deleteCopies();
    localStorage.removeItem(storageKey);
    forgetWorkspaceChoice();
  });
}
