import {
  checkAccess,
  type OpenSocket,
  type Schedule,
  SyncConnection,
  SyncStore,
  type TabChannel,
  type TabMessage,
  type Workspace,
} from "@pigy/core";
import {
  copyName,
  indexedDbStorage,
  unsyncedWorkspaces,
} from "./indexed-db.ts";

/**
 * The sync of one workspace in this tab: what `@pigy/core` needs from a
 * browser. The copy is in IndexedDB and shared by all tabs. A
 * `BroadcastChannel` tells the tabs that have it open of each other's
 * writes, and a Web Lock decides which one of them holds the socket.
 *
 * A person has two workspaces, live and sandbox, and a tab shows one of
 * them. It syncs the one it shows, and goes on syncing one that it has
 * shown before: see `workspaceSync`. A second Web Lock is the tab's and
 * not a workspace's: it says that the tab holds changes which it could not
 * store, in either workspace. See `unsavedLock`.
 */
export type WorkspaceSync = {
  /** What the screens read and write. */
  store: SyncStore;
  /** Stops syncing in this tab. The copy stays on the device. */
  close(): void;
};

function report(error: unknown): void {
  console.error("Sync", error);
}

const schedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function webSocketTo(path: string): OpenSocket {
  return (events) => {
    const socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}${path}`,
    );
    socket.onopen = () => events.open();
    socket.onmessage = (event) => events.message(event.data);
    socket.onclose = (event) => events.close(event.code);
    return {
      send: (text) => socket.send(text),
      close: () => socket.close(),
    };
  };
}

/**
 * Whether a message is for every tab of the person, whichever workspace it
 * has open, and not only for the tabs that share the copy: what a tab says
 * of the mutations that it could not store, and the question for it. They
 * are in the memory of that tab and nowhere else, and signing out in any
 * tab makes all of them start again. So whoever counts what signing out
 * would lose has to hear of them from the tabs that show the other
 * workspace too, and from the other workspace that this tab has open.
 */
function forEveryTab(message: TabMessage): boolean {
  return message.type === "unsaved" || message.type === "unsaved?";
}

/** The stores that this tab has open, by the name of their copy. */
const stores = new Map<string, SyncStore>();
const watchers = new Set<() => void>();

/**
 * How many changes this tab holds that it could not store, in every
 * workspace that it syncs. They are in its memory and nowhere else, so they
 * are gone when the page is: closed, loaded again or left for another one.
 */
export function unsavedInTab(): number {
  let count = 0;
  for (const store of stores.values()) count += store.getState().unsaved;
  return count;
}

/** Has the browser ask the person whether the page may go. */
function ask(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // What browsers went by before they went by the line above.
  event.returnValue = true;
}

/**
 * The Web Lock that a window holds, in shared mode, for as long as it
 * holds changes which it could not store, in whichever workspace. A window
 * that starts looks for it before it lets a new version of the app take
 * over, see src/lib/service-worker.ts: loading the window with those
 * changes again would lose them, and left as it is under the new version
 * it would run a build whose files are gone.
 *
 * The name is a contract between the versions of the app, and must not
 * change: the window that holds the lock and the window that looks for it
 * run different versions whenever a new one waits, and a window that
 * looked under another name would find nothing and go ahead.
 */
const unsavedLock = "pigy/unsaved";

/** Gives `unsavedLock` back, while this tab holds it or has asked for it. */
let releaseUnsavedLock: (() => void) | undefined;

/**
 * Holds `unsavedLock` while `unsaved`, and gives it back when not. The tab
 * asks for it once, whichever of its stores holds the changes, and gives
 * it back when none of them does.
 */
function sayUnsaved(unsaved: boolean): void {
  if (unsaved && !releaseUnsavedLock) {
    const stored = new Promise<void>((resolve) => {
      releaseUnsavedLock = resolve;
    });
    // Shared, so that every window with such changes gets it at once.
    navigator.locks
      .request(unsavedLock, { mode: "shared" }, () => stored)
      .catch(report);
  } else if (!unsaved && releaseUnsavedLock) {
    releaseUnsavedLock();
    releaseUnsavedLock = undefined;
  }
}

/**
 * Whether a window of the app in this browser holds changes that it could
 * not store. False where that cannot be found out, as in a browser
 * without Web Locks.
 */
export async function unsavedInSomeWindow(): Promise<boolean> {
  if (!("locks" in navigator)) return false;
  try {
    const { held = [], pending = [] } = await navigator.locks.query();
    return [...held, ...pending].some(({ name }) => name === unsavedLock);
  } catch (error) {
    report(error);
    return false;
  }
}

/** A store of this tab has changed, or the tab has another set of them. */
function changed(): void {
  const unsaved = unsavedInTab() > 0;
  // The browser asks before the page goes for as long as the tab holds
  // what that would lose, whichever workspace is on screen. The listener
  // is there only for that long: a browser may not put a page aside to
  // come back to while it listens for this.
  if (unsaved) window.addEventListener("beforeunload", ask);
  else window.removeEventListener("beforeunload", ask);
  // The windows that start are told as well, or they would let a new
  // version of the app take over, under which this one could not stay.
  sayUnsaved(unsaved);
  for (const watcher of [...watchers]) watcher();
}

/**
 * The store of a workspace, if this tab syncs it and has opened its copy.
 * For what looks at a workspace that is not on screen: asking does not
 * start a sync.
 */
export function openStore(
  userId: string,
  workspaceId: string,
): SyncStore | undefined {
  return stores.get(copyName(userId, workspaceId));
}

/**
 * Calls `listener` when a store of this tab has changed, and when the tab
 * has opened or closed one. Returns how to stop.
 */
export function onSyncChange(listener: () => void): () => void {
  watchers.add(listener);
  return () => watchers.delete(listener);
}

async function open(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceSync> {
  const name = copyName(userId, workspaceId);
  const storage = indexedDbStorage(name);
  // Two channels: one for the tabs that share this copy, and one for all
  // the tabs of the person. A channel does not hear itself, and it does
  // hear another one of the same name in the same tab: the two workspaces
  // that a tab has open hear each other on the second.
  const sharers = new BroadcastChannel(name);
  const everyTab = new BroadcastChannel(`pigy/${userId}`);
  const channel: TabChannel = {
    post: (message) =>
      (forEveryTab(message) ? everyTab : sharers).postMessage(message),
    listen: (listener) => {
      const receive = (event: MessageEvent) => listener(event.data);
      sharers.addEventListener("message", receive);
      everyTab.addEventListener("message", receive);
      return () => {
        sharers.removeEventListener("message", receive);
        everyTab.removeEventListener("message", receive);
      };
    },
  };
  const store = new SyncStore({
    storage,
    channel,
    now: () => new Date(),
    schedule,
    onError: report,
  });
  await store.open();

  const connection = new SyncConnection({
    store,
    open: webSocketTo(`/sync/${workspaceId}`),
    checkAccess: (signal) =>
      checkAccess((input, init) => fetch(input, init), workspaceId, signal),
    schedule,
    onError: report,
  });

  // The tab that has the lock holds the socket, for as long as its
  // connection runs. The others wait in line: when the tab is closed, or
  // its connection gives up, the next one gets the lock and connects. A
  // tab that is too old for the copy does not line up: it could not use
  // the socket. One that finds out later that it is too old gives the
  // lock back, or lets it pass when its turn comes.
  const waiting = new AbortController();
  if (!store.getState().outdated) {
    navigator.locks
      .request(`${name}/socket`, { signal: waiting.signal }, () =>
        connection.run(),
      )
      .catch((error: unknown) => {
        // Thrown when `close()` ends the wait for the lock.
        if (!waiting.signal.aborted) report(error);
      });
  }

  // The browser knows before a socket does that the network has changed,
  // and it says so in every tab, also in one in the background, which is
  // where the socket may be. The timers of such a tab hardly run: left to
  // them, it would connect again a minute later.
  const online = () => connection.wake();
  // A tab that comes to the front has slept, and the tab with the socket
  // may be asleep still: whichever one that is, it is asked to look.
  const visible = () => {
    if (document.visibilityState === "visible") store.wakeHolder();
  };
  // A tab that is closed, or leaves the app, takes with it what it could
  // not store. It says so, or the other tabs would go on counting it. Not
  // when the page is only put aside to come back: it holds it all then.
  const leaving = (event: PageTransitionEvent) => {
    if (!event.persisted) store.leaving();
  };
  window.addEventListener("online", online);
  window.addEventListener("pagehide", leaving);
  document.addEventListener("visibilitychange", visible);
  stores.set(name, store);
  store.subscribe(changed);
  changed();

  return {
    store,
    close() {
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", visible);
      waiting.abort();
      connection.stop();
      // Which also ends what the store tells `changed`.
      store.close();
      if (stores.get(name) === store) stores.delete(name);
      changed();
      sharers.close();
      everyTab.close();
      storage.close();
    },
  };
}

/** The syncs that this tab has started, by the name of their copy. */
const syncs = new Map<string, Promise<WorkspaceSync>>();

/**
 * The sync of a workspace, which is started the first time it is asked
 * for, and then runs for as long as the tab is open: also when the tab
 * goes on to show the other workspace. Stopping it there would lose what
 * it could not store, which is in its memory alone, and would leave what
 * it has stored and not sent on the device until the person came back to
 * that workspace. It also makes coming back instant.
 */
export function workspaceSync(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceSync> {
  const name = copyName(userId, workspaceId);
  let sync = syncs.get(name);
  if (!sync) {
    const started = open(userId, workspaceId);
    sync = started;
    syncs.set(name, started);
    // A copy that could not be opened is tried again the next time.
    started.catch(() => {
      if (syncs.get(name) === started) syncs.delete(name);
    });
  }
  return sync;
}

let lookedForUnsent = false;

/**
 * Starts the sync of every workspace of `workspaces` whose copy on this
 * device holds changes that the server has not confirmed, once per load of
 * the app. The workspace that the tab shows is synced anyway. This is for
 * the other one: what was written there and not sent, before the person
 * changed workspaces and the app was closed, or before a session ended,
 * is sent now and not only when they next look at that workspace.
 */
export function syncUnsent(userId: string, workspaces: Workspace[]): void {
  if (lookedForUnsent) return;
  lookedForUnsent = true;
  unsyncedWorkspaces(userId)
    .then((unsent) =>
      Promise.all(
        workspaces
          .filter(({ id }) => unsent.includes(id))
          .map(({ id }) => workspaceSync(userId, id)),
      ),
    )
    .catch(report);
}

/**
 * Resolves when this tab holds no change that is not stored, in any
 * workspace that it syncs: at once, unless a change is waiting to be
 * written, is being written, or could not be written, which the store
 * tries again. For whoever is about to load the page again, which would
 * lose such a change: it is in the memory of this tab and nowhere else.
 *
 * It resolves in a moment in which no store holds such a change. One store
 * can take a change while another one is waited for, so all of them are
 * asked again after every wait.
 */
export async function whenSaved(): Promise<void> {
  for (;;) {
    const waiting = [...stores.values()].filter((store) =>
      store.holdsUnstored(),
    );
    if (waiting.length === 0) return;
    await Promise.all(waiting.map((store) => store.whenStored()));
  }
}

/**
 * Stops every sync of this tab. For when the tab is done with what it
 * holds: the person has signed out, here or in another tab, or the session
 * has ended. Whoever calls this goes on to load the page again, and the
 * browser does not ask about that: the stores no longer count, from this
 * moment and not from the later one at which each of them has closed.
 */
export function closeWorkspaceSync(): void {
  for (const sync of syncs.values()) {
    void sync.then(({ close }) => close()).catch(() => {});
  }
  syncs.clear();
  stores.clear();
  changed();
  lookedForUnsent = false;
}
