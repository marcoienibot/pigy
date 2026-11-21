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
  unsavedInSomeWindow,
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
 * `ended`: the server has said that the session is over, and the copies
 * were kept because they hold changes that were not synced.
 */
type Stored = Session & { ended: boolean };

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
    };
  } catch {
    return null;
  }
}

function write({ me, workspaces }: Session, ended = false): void {
  localStorage.setItem(storageKey, JSON.stringify({ me, workspaces, ended }));
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
  let fresh: Session | null;
  try {
    fresh = await fetchSession(signal);
  } catch (error) {
    // The session that this device knows of is over, and whether there is
    // a new one cannot be found out: the sign-in page says what is left.
    if (stored) return null;
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
 * Makes `session` the one that this device knows of. Whoever signs in gets
 * a device without anybody else's data. If a session of their own ended
 * here with changes that were not synced, the changes are theirs again,
 * and are sent now.
 */
async function adopt(session: Session): Promise<void> {
  await deleteCopies(session.me.user.id);
  write(session);
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
 * Nothing is sent for the session that is over meanwhile: the server
 * refuses the socket of the tab, and a store sends only what is stored.
 */
function savedOrDiscarded(): Promise<void> {
  saving ??= new Promise<void>((resolve) => {
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
 */
export function discardUnsaved(): void {
  discard?.();
}

async function check(): Promise<void> {
  const stored = read();
  if (!stored || stored.ended || signingOut) return;
  let fresh: Session | null;
  try {
    fresh = await fetchSession();
  } catch {
    return;
  }
  if (signingOut) return;
  if (!fresh) {
    // What this tab has not stored is stored first, and then kept with
    // the copy: `endSession` closes the stores, and the page goes.
    await savedOrDiscarded();
    if (signingOut) return;
    await endSession();
    // A full page load, so that nothing of the session stays in memory.
    const here = location.pathname + location.search + location.hash;
    location.assign(
      here === "/"
        ? "/sign-in"
        : `/sign-in?${new URLSearchParams({ returnTo: here })}`,
    );
    return;
  }
  if (fresh.me.user.id !== stored.me.user.id) {
    // Somebody else has signed in without passing the sign-in page, which
    // would have dealt with the session before: only the address that
    // starts a sign-in does that. This tab shows the data of the person
    // before, so it starts again as the new one, at once: what it could
    // not store is not waited for, because what a device holds of one
    // person goes when another signs in, stored or not.
    closeWorkspaceSync();
    await adopt(fresh);
    location.reload();
    return;
  }
  write(fresh);
  if (JSON.stringify(fresh.me) !== JSON.stringify(stored.me)) {
    for (const listener of listeners) listener();
  }
}

/**
 * For when the server has said that the session this device knows of is
 * over: deletes the local copies of its user and forgets the user.
 *
 * Unless the copies hold changes that were never synced. A session ends
 * without the person's doing, after 30 days or when an invitation is
 * withdrawn, and deleting then would lose work that nobody chose to lose.
 * The copies stay, and are not shown to anybody: the sign-in page says
 * that they are there. They are synced when the same person signs in
 * again, and deleted when somebody else does or when the person says so.
 *
 * They also stay while a window holds changes that it could not store:
 * that window is about to hear that the session is over, and waits until
 * it has stored them, which takes the copy. See the `storage` listener
 * below. The tab that calls this has waited for its own, if it had any.
 */
export async function endSession(): Promise<void> {
  const stored = read();
  if (stored?.ended) return;
  // Asked before this tab closes its stores: it does not matter that the
  // tab is counted itself where it goes without its changes. A copy that
  // is kept for nothing says nothing on the sign-in page, and goes with
  // the next sign-in of somebody else.
  const waited = await unsavedInSomeWindow();
  closeWorkspaceSync();
  if (stored && (waited || (await countUnsynced(stored.me.user.id)) > 0)) {
    write(stored, true);
  } else {
    // Also when this device knows of nobody: a copy can be left behind by
    // a deletion that failed.
    await deleteCopies();
    localStorage.removeItem(storageKey);
    forgetWorkspaceChoice();
  }
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
 * whose they are. Null if there are none.
 */
export async function keptChanges(): Promise<{
  count: number;
  email: string;
} | null> {
  const stored = read();
  if (!stored?.ended) return null;
  const { id, email } = stored.me.user;
  const count = await countUnsynced(id);
  return count > 0 ? { count, email } : null;
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
    // The same person is signed in again while this tab waits for what it
    // could not store after their session had ended. It goes on waiting:
    // starting again now would lose those changes for nothing.
    if (same && saving) return;
    // The session of the person has ended by itself, and the copies were
    // kept. What this tab has not stored is stored before it starts
    // again, as in the tab that found out: see `savedOrDiscarded`.
    // Anything else is no reason to wait, also for a tab that waits
    // already: the person has signed out or has had the changes that were
    // kept deleted, which they were asked about, or somebody else has
    // signed in, and nothing of the person before is shown to them.
    const leave = () => {
      closeWorkspaceSync();
      location.reload();
    };
    if (same && after[1] === true) void savedOrDiscarded().then(leave);
    else leave();
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
 */
export async function forgetSession(): Promise<void> {
  closeWorkspaceSync();
  // Tabs that have a copy open let go of it when it is deleted.
  await deleteCopies();
  localStorage.removeItem(storageKey);
  forgetWorkspaceChoice();
}
