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
 * shown before: see `workspaceSync`.
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

  return {
    store,
    close() {
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", visible);
      waiting.abort();
      connection.stop();
      store.close();
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

/** Stops every sync of this tab. */
export function closeWorkspaceSync(): void {
  for (const sync of syncs.values()) {
    void sync.then(({ close }) => close()).catch(() => {});
  }
  syncs.clear();
  lookedForUnsent = false;
}
