import type { Head, Write } from "./copy.ts";
import type { ClientStorage, StoredRow } from "./storage.ts";
import type { TabChannel, TabMessage } from "./store.ts";

/**
 * A storage that keeps the copy in memory. The tests use it, and it is the
 * shortest statement of what a storage does. Like IndexedDB it takes one
 * operation at a time and hands out copies of what it holds, never the
 * objects themselves.
 */
export function memoryStorage(): ClientStorage {
  let head: Head | undefined;
  const rows = new Map<string, StoredRow>();
  let last: Promise<unknown> = Promise.resolve();

  const run = <Result>(operation: () => Result): Promise<Result> => {
    const result = last.then(operation);
    last = result.catch(() => {});
    return result;
  };

  const store = (write: Write) => {
    const outbox = new Map(
      (write.outbox?.clear ? [] : (head?.outbox ?? [])).map((mutation) => [
        mutation.id,
        mutation,
      ]),
    );
    for (const id of write.outbox?.delete ?? []) outbox.delete(id);
    for (const mutation of write.outbox?.put ?? []) {
      outbox.set(mutation.id, mutation);
    }
    const rejections = new Map(
      (head?.rejections ?? []).map((rejection) => [rejection.key, rejection]),
    );
    for (const key of write.rejections?.delete ?? []) rejections.delete(key);
    for (const rejection of write.rejections?.put ?? []) {
      rejections.set(rejection.key, rejection);
    }
    head = {
      meta: write.meta,
      outbox: [...outbox.values()].sort((a, b) => a.id - b.id),
      rejections: [...rejections.values()],
    };
    if (write.rows?.clear) rows.clear();
    for (const change of write.rows?.changes ?? []) {
      if (change.op === "put") {
        rows.set(`${change.table} ${change.row.id}`, change);
      } else {
        rows.delete(`${change.table} ${change.id}`);
      }
    }
  };

  return {
    read: () =>
      run(() => head && structuredClone({ head, rows: [...rows.values()] })),
    update: (step) =>
      run(() => {
        const outcome = structuredClone(step(structuredClone(head)));
        if (outcome.write) store(outcome.write);
        return structuredClone(outcome);
      }),
  };
}

/**
 * The tabs of one browser, for the tests: what one of them posts reaches
 * all the others, later and in the order it was posted, as with a
 * `BroadcastChannel`.
 */
export function memoryTabs() {
  const listeners = new Set<(message: TabMessage) => void>();
  return {
    /** The channel of one more tab. */
    join(): TabChannel {
      let own: ((message: TabMessage) => void) | undefined;
      return {
        post(message) {
          const copy = structuredClone(message);
          for (const listener of listeners) {
            if (listener !== own) queueMicrotask(() => listener(copy));
          }
        },
        listen(listener) {
          own = listener;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}
