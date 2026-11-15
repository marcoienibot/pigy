import {
  checkAccess,
  memoryStorage,
  memoryTabs,
  type Row,
  SyncConnection,
  SyncStore,
  type TableName,
} from "@pigy/core";
import { expect, onTestFinished, vi } from "vitest";
import { clock } from "./clock.ts";
import type { Browser } from "./helpers.ts";

/**
 * The sync client of the app, as the browser runs it, against the Worker
 * of the test. Everything that decides what the client does is the code of
 * `@pigy/core` that the web app uses. What a browser adds around it is
 * stood in for here: memory in place of IndexedDB, the WebSocket of the
 * Workers runtime, and timers that only the test moves.
 */

/** The network between a tab and the server, for the test to cut. */
export type Link = {
  /** How many sockets the tab has opened. */
  opened: number;
  /** Set to make the tab deaf: what the server sends is thrown away. */
  deaf: boolean;
  /**
   * Loses the socket, as a network does: without a word from the server.
   * Resolves when the tab has noticed and is waiting to try again.
   */
  lose(): Promise<void>;
  /**
   * Moves the clock of the test, which is also the server's, and runs what
   * the tab has scheduled for the time that has passed: the next attempt
   * to connect, for example. Nothing is awaited in between, so a test
   * passes just the time that the one thing it waits for takes.
   */
  pass(milliseconds: number): void;
};

/**
 * A device with the app on it: one stored copy of `workspaceId`, signed in
 * as `browser` is.
 */
export function device(browser: Browser, workspaceId: string) {
  const storage = memoryStorage();
  const tabs = memoryTabs();
  const errors: unknown[] = [];

  return {
    /** What the stores and connections of the device reported. */
    errors,

    /** Opens the app in a tab, which does not hold the socket yet. */
    async tab() {
      const store = new SyncStore({
        storage,
        channel: tabs.join(),
        now: () => clock.time,
        onError: (error) => errors.push(error),
      });
      await store.open();

      const timers: { at: number; callback: () => void }[] = [];
      let lose = () => {};
      const link: Link = {
        opened: 0,
        deaf: false,
        async lose() {
          lose();
          await vi.waitFor(() =>
            expect(store.getState().connection).toBe("offline"),
          );
        },
        pass(milliseconds) {
          const until = clock.time.getTime() + milliseconds;
          for (;;) {
            const due = timers
              .filter((timer) => timer.at <= until)
              .sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            timers.splice(timers.indexOf(due), 1);
            clock.time = new Date(due.at);
            due.callback();
          }
          clock.time = new Date(until);
        },
      };
      const connection = new SyncConnection({
        store,
        open: (events) => {
          link.opened += 1;
          let socket: WebSocket | undefined;
          let over = false;
          const end = (code: number) => {
            if (over) return;
            over = true;
            events.close(code);
          };
          lose = () => {
            socket?.close(1000, "Lost");
            // 1006 is what a browser reports for a socket that went away.
            end(1006);
          };
          void browser.webSocket(`/sync/${workspaceId}`).then((response) => {
            const accepted = response.webSocket;
            if (!accepted) {
              end(1006);
              return;
            }
            accepted.accept();
            if (over) {
              accepted.close(1000, "Given up");
              return;
            }
            socket = accepted;
            accepted.addEventListener("message", (event) => {
              if (!over && !link.deaf) events.message(event.data);
            });
            accepted.addEventListener("close", (event) => end(event.code));
            events.open();
          });
          return {
            send: (text) => socket?.send(text),
            close: () => {
              over = true;
              socket?.close(1000, "Bye");
            },
          };
        },
        checkAccess: () =>
          checkAccess((input) => browser.fetch(String(input)), workspaceId),
        schedule: (callback, delayMs) => {
          const timer = { at: clock.time.getTime() + delayMs, callback };
          timers.push(timer);
          return () => {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
          };
        },
        onError: (error) => errors.push(error),
      });
      // A tab that outlived its test would connect again when the next
      // test closes the sockets of this one.
      onTestFinished(() => {
        connection.stop();
        store.close();
      });
      return { store, connection, link };
    },

    /** Opens the app in a tab that holds the socket, and waits for sync. */
    async online() {
      const tab = await this.tab();
      const running = tab.connection.run();
      await synced(tab.store);
      return { ...tab, running };
    },
  };
}

/** Waits until `store` follows the server and has nothing left to send. */
export async function synced(store: SyncStore): Promise<void> {
  await vi.waitFor(() =>
    expect(store.getState()).toMatchObject({
      connection: "online",
      pending: 0,
    }),
  );
}

/** What `store` shows, in the form of `SyncClient.copy`, to compare them. */
export function shown(store: SyncStore) {
  const table = <Table extends TableName>(name: Table): Row<Table>[] =>
    [...store.getView()[name].values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { post: table("post"), post_part: table("post_part") };
}
