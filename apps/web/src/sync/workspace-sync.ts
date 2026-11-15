import {
  checkAccess,
  type OpenSocket,
  type Schedule,
  SyncConnection,
  SyncStore,
  type TabChannel,
} from "@pigy/core";
import { copyName, indexedDbStorage } from "./indexed-db.ts";

/**
 * The sync of one workspace in this tab: what `@pigy/core` needs from a
 * browser. The copy is in IndexedDB and shared by all tabs. A
 * `BroadcastChannel` tells them of each other's writes, and a Web Lock
 * decides which one of them holds the socket.
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

async function open(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceSync> {
  const name = copyName(userId, workspaceId);
  const storage = indexedDbStorage(name);
  const broadcast = new BroadcastChannel(name);
  const channel: TabChannel = {
    post: (message) => broadcast.postMessage(message),
    listen: (listener) => {
      const receive = (event: MessageEvent) => listener(event.data);
      broadcast.addEventListener("message", receive);
      return () => broadcast.removeEventListener("message", receive);
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
      broadcast.close();
      storage.close();
    },
  };
}

let current: { name: string; sync: Promise<WorkspaceSync> } | undefined;

/**
 * The sync of a workspace, which is started the first time it is asked
 * for. A tab syncs one workspace at a time: asking for another one stops
 * the one before.
 */
export function workspaceSync(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceSync> {
  const name = copyName(userId, workspaceId);
  if (current?.name !== name) {
    closeWorkspaceSync();
    const sync = open(userId, workspaceId);
    current = { name, sync };
    // A copy that could not be opened is tried again the next time.
    sync.catch(() => {
      if (current?.sync === sync) current = undefined;
    });
  }
  return current.sync;
}

/** Stops the sync of this tab, if there is one. */
export function closeWorkspaceSync(): void {
  void current?.sync.then((sync) => sync.close()).catch(() => {});
  current = undefined;
}
