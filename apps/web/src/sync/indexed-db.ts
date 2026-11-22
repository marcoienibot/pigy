import type {
  ClientStorage,
  Head,
  Meta,
  PendingMutation,
  Step,
  StoredRejection,
  StoredRow,
  Write,
} from "@pigy/core";
import { isFilesName } from "@/lib/upload-files";

/**
 * The local copies in IndexedDB: one database per user and workspace, so
 * that the copy of one person is never read as another's, and so that
 * signing out can delete all of somebody's copies without opening them.
 */

/** Every database of pigy has a name that begins with this. */
const prefix = "pigy/";

/** The name of the database with the copy of a workspace. */
export function copyName(userId: string, workspaceId: string): string {
  return `${prefix}${userId}/${workspaceId}`;
}

/**
 * The stores. `rows` holds the rows of all synced tables, keyed by table
 * and ID, so a new synced table needs no change here.
 */
const stores = ["meta", "rows", "outbox", "rejections"] as const;

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      // One entry, under the key "meta".
      db.createObjectStore("meta");
      // A row is stored as the `put` that brought it.
      db.createObjectStore("rows", { keyPath: ["table", "row.id"] });
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("rejections", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Somebody wants to delete the database: the person has signed out
      // in another tab. Without this the deletion would wait for this tab.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function store(transaction: IDBTransaction, write: Write): void {
  transaction.objectStore("meta").put(write.meta, "meta");
  if (write.rows) {
    const rows = transaction.objectStore("rows");
    if (write.rows.clear) rows.clear();
    for (const change of write.rows.changes) {
      if (change.op === "put") rows.put(change satisfies StoredRow);
      else rows.delete([change.table, change.id]);
    }
  }
  if (write.outbox) {
    const outbox = transaction.objectStore("outbox");
    if (write.outbox.clear) outbox.clear();
    for (const id of write.outbox.delete) outbox.delete(id);
    for (const mutation of write.outbox.put) outbox.put(mutation);
  }
  if (write.rejections) {
    const rejections = transaction.objectStore("rejections");
    for (const key of write.rejections.delete) rejections.delete(key);
    for (const rejection of write.rejections.put) rejections.put(rejection);
  }
}

/**
 * The copy in the database `name`. What comes out of the database is
 * trusted to be what this code put in: nothing else writes to it, and the
 * version of the database changes with the shape of what is stored.
 */
export function indexedDbStorage(name: string): ClientStorage & {
  /** Lets go of the database. */
  close(): void;
} {
  let database: Promise<IDBDatabase> | undefined;
  const opened = () => {
    database ??= open(name);
    return database;
  };

  return {
    async read() {
      const transaction = (await opened()).transaction(stores, "readonly");
      const meta = transaction.objectStore("meta").get("meta");
      const rows = transaction.objectStore("rows").getAll();
      const outbox = transaction.objectStore("outbox").getAll();
      const rejections = transaction.objectStore("rejections").getAll();
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      if (!meta.result) return undefined;
      return {
        head: {
          meta: meta.result as Meta,
          // In the order of their keys, which are the IDs.
          outbox: outbox.result as PendingMutation[],
          rejections: rejections.result as StoredRejection[],
        },
        rows: rows.result as StoredRow[],
      };
    },

    async update<Result>(
      step: (head: Head | undefined) => Step<Result>,
      options: { durable?: boolean } = {},
    ) {
      const transaction = (await opened()).transaction(
        stores,
        "readwrite",
        // Browsers leave it to the system when a write reaches the disk,
        // unless they are asked.
        options.durable ? { durability: "strict" } : {},
      );
      return new Promise<Step<Result>>((resolve, reject) => {
        let outcome: Step<Result> | undefined;
        let thrown: unknown;
        transaction.oncomplete = () => {
          if (outcome) resolve(outcome);
        };
        transaction.onabort = () => reject(thrown ?? transaction.error);

        const meta = transaction.objectStore("meta").get("meta");
        const outbox = transaction.objectStore("outbox").getAll();
        const rejections = transaction.objectStore("rejections").getAll();
        // The requests of a transaction are answered in order, so the
        // other two have their results when the last one has.
        rejections.onsuccess = () => {
          try {
            outcome = step(
              meta.result
                ? {
                    meta: meta.result as Meta,
                    outbox: outbox.result as PendingMutation[],
                    rejections: rejections.result as StoredRejection[],
                  }
                : undefined,
            );
            if (outcome.write) store(transaction, outcome.write);
          } catch (error) {
            thrown = error;
            transaction.abort();
          }
        };
      });
    },

    close() {
      void database?.then((db) => db.close()).catch(() => {});
    },
  };
}

/** The names of the databases with copies on this device. */
async function copyNames(): Promise<string[]> {
  const databases = await indexedDB.databases();
  return databases.flatMap(({ name }) =>
    name?.startsWith(prefix) ? [name] : [],
  );
}

/**
 * How many mutations the server has not confirmed in each copy of `userId`
 * on this device, by the ID of its workspace.
 */
async function unsynced(userId: string): Promise<Map<string, number>> {
  const ofUser = `${prefix}${userId}/`;
  const counts = new Map<string, number>();
  for (const name of await copyNames()) {
    // The files that wait to be uploaded are next to the copies, and
    // are no copy: lib/upload-files.ts.
    if (!name.startsWith(ofUser) || isFilesName(name)) continue;
    const db = await open(name);
    try {
      const outbox = db.transaction("outbox").objectStore("outbox").count();
      counts.set(
        name.slice(ofUser.length),
        await new Promise<number>((resolve, reject) => {
          outbox.onsuccess = () => resolve(outbox.result);
          outbox.onerror = () => reject(outbox.error);
        }),
      );
    } finally {
      db.close();
    }
  }
  return counts;
}

/**
 * How many mutations of `userId` on this device the server has not
 * confirmed, in all their copies: those of the workspace on screen and of
 * the other one.
 */
export async function countUnsynced(userId: string): Promise<number> {
  let count = 0;
  for (const held of (await unsynced(userId)).values()) count += held;
  return count;
}

/**
 * The IDs of the workspaces of `userId` whose copies on this device hold
 * mutations that the server has not confirmed.
 */
export async function unsyncedWorkspaces(userId: string): Promise<string[]> {
  return [...(await unsynced(userId))].flatMap(([workspaceId, count]) =>
    count > 0 ? [workspaceId] : [],
  );
}

/**
 * Deletes the copies on this device, all of them or those of everybody but
 * `exceptUserId`. Tabs that have one open let go of it when they are asked
 * to, see `open`, and the deletion waits for them.
 */
export async function deleteCopies(exceptUserId?: string): Promise<void> {
  for (const name of await copyNames()) {
    if (exceptUserId && name.startsWith(`${prefix}${exceptUserId}/`)) continue;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
