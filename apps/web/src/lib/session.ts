import {
  type MeResponse,
  meResponseSchema,
  type Workspace,
  workspaceListResponseSchema,
} from "@pigy/core";
import { ApiError, fetchMe, fetchWorkspaces } from "@/lib/api";
import { countUnsynced, deleteCopies } from "@/sync/indexed-db";
import { closeWorkspaceSync } from "@/sync/workspace-sync";

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

/** Asks the server. Null if nobody is signed in, an error if it is silent. */
async function fetchSession(signal?: AbortSignal): Promise<Session | null> {
  const me = await fetchMe(signal);
  if (!me) return null;
  try {
    return { me, workspaces: await fetchWorkspaces(signal) };
  } catch (error) {
    // Signed out between the two requests.
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
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
 * If this device knows, it answers at once and asks the server in the
 * background: see `checkSession`. So the app starts without waiting for
 * the network, and without a network at all.
 */
export async function loadSession(
  signal: AbortSignal,
): Promise<Session | null> {
  const stored = read();
  if (stored && !stored.ended) {
    void checkSession();
    return stored;
  }
  let fresh: Session | null;
  try {
    fresh = await fetchSession(signal);
  } catch (error) {
    // The session that this device knows of is over, and whether there is
    // a new one cannot be found out: the sign-in page says what is left.
    if (stored) return null;
    throw error;
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
 * Asks the server whether the session that this device knows of is still
 * the one it has, and acts on the answer. No answer changes nothing: the
 * device is offline.
 */
export function checkSession(): Promise<void> {
  checking ??= check().finally(() => {
    checking = undefined;
  });
  return checking;
}

async function check(): Promise<void> {
  const stored = read();
  if (!stored || stored.ended) return;
  let fresh: Session | null;
  try {
    fresh = await fetchSession();
  } catch {
    return;
  }
  if (!fresh) {
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
    // before, so it starts again as the new one.
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
 */
export async function endSession(): Promise<void> {
  const stored = read();
  if (stored?.ended) return;
  closeWorkspaceSync();
  if (stored && (await countUnsynced(stored.me.user.id)) > 0) {
    write(stored, true);
  } else {
    // Also when this device knows of nobody: a copy can be left behind by
    // a deletion that failed.
    await deleteCopies();
    localStorage.removeItem(storageKey);
  }
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
  const whose = (value: string | null): unknown => {
    try {
      const stored = JSON.parse(value ?? "null");
      return stored && [stored.me?.user?.id, stored.ended];
    } catch {
      return null;
    }
  };
  // Not for a name or a role that changed: `checkSession` handles those
  // in every tab.
  if (
    JSON.stringify(whose(event.oldValue)) !==
    JSON.stringify(whose(event.newValue))
  ) {
    closeWorkspaceSync();
    location.reload();
  }
});

/**
 * Deletes everything that this device holds of the person who was signed
 * in: the local copies, with the changes in them that were not synced, and
 * who it was. For after the server has ended the session, or to discard
 * what was kept of a session that ended by itself.
 */
export async function forgetSession(): Promise<void> {
  closeWorkspaceSync();
  // Tabs that have a copy open let go of it when it is deleted.
  await deleteCopies();
  localStorage.removeItem(storageKey);
}
