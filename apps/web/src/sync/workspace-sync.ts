import {
  checkAccess,
  type OpenSocket,
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
    onError: report,
  });
  await store.open();

  const connection = new SyncConnection({
    store,
    open: webSocketTo(`/sync/${workspaceId}`),
    checkAccess: () =>
      checkAccess((input, init) => fetch(input, init), workspaceId),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    onError: report,
  });

  // The tab that has the lock holds the socket, for as long as its
  // connection runs. The others wait in line: when the tab is closed, or
  // its connection gives up, the next one gets the lock and connects. A
  // tab that is too old for the copy does not line up: it could not use
  // the socket.
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
  // and timers do not run in a tab that sleeps.
  const wake = () => {
    if (document.visibilityState === "visible") connection.wake();
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);

  return {
    store,
    close() {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
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
