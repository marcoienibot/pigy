/**
 * The files that wait to be uploaded, kept on the device: an image that
 * was put into a draft is in the memory of its tab, and here, so that a
 * tab that is loaded again, or opened later, goes on with the upload. A
 * web page cannot take a file from the disk a second time by itself: what
 * it does not keep, the person would have to choose again.
 *
 * One database per person, next to the copies of their workspaces and
 * under the same beginning of a name, so that whatever deletes the
 * copies of a person deletes these with them: `deleteCopies` of
 * sync/indexed-db.ts. A file is deleted when its upload has ended: by the
 * tab that ran the upload, or the next time a tab looks after the uploads
 * of its workspace, `Uploads` of uploads.ts.
 */

/** The name of the database with the files of `userId`. */
export function filesName(userId: string): string {
  return `pigy/${userId}/files`;
}

/** Whether `name` is the database of somebody's files, and no copy. */
export const isFilesName = (name: string) => name.endsWith("/files");

/**
 * Where files are kept by a key: `<workspace ID>/<image ID>`, so that the
 * files of each workspace can be looked through by themselves.
 */
export type FileStore = {
  put(key: string, file: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

const done = <Result>(request: IDBRequest<Result>) =>
  new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** The files of `userId` in IndexedDB. */
export function indexedDbFiles(userId: string): FileStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(filesName(userId), 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("files");
      };
      request.onsuccess = () => {
        const db = request.result;
        // Whoever deletes the database is not kept waiting.
        db.onversionchange = () => {
          db.close();
          opened = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await database()).transaction("files", mode).objectStore("files");
  return {
    put: async (key, file) => {
      await done((await store("readwrite")).put(file, key));
    },
    get: async (key) => {
      const file: unknown = await done((await store("readonly")).get(key));
      return file instanceof Blob ? file : undefined;
    },
    delete: async (key) => {
      await done((await store("readwrite")).delete(key));
    },
    keys: async () => {
      // Looked through without making the database, which opening it
      // would: a person who never attached an image has none.
      if (
        !opened &&
        "databases" in indexedDB &&
        !(await indexedDB.databases()).some(
          ({ name }) => name === filesName(userId),
        )
      ) {
        return [];
      }
      return (await done((await store("readonly")).getAllKeys())).filter(
        (key): key is string => typeof key === "string",
      );
    },
  };
}

/**
 * How many files of `userId` wait to be uploaded, by the ID of the
 * workspace of each, for the database `name` of them, which the caller
 * has found on the device: images that the server does not have, which
 * whatever deletes the copies deletes with them. The database is closed
 * afterwards, so that nobody who deletes it waits.
 */
export async function waitingFiles(name: string): Promise<Map<string, number>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    // Deleted after it was found: it is made again, empty, as by
    // `indexedDbFiles`.
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const keys = await done(
      db.transaction("files").objectStore("files").getAllKeys(),
    );
    const counts = new Map<string, number>();
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const [workspaceId = ""] = key.split("/");
      counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** Files in memory, for a test and for a device without IndexedDB. */
export function memoryFiles(): FileStore {
  const files = new Map<string, Blob>();
  return {
    put: async (key, file) => {
      files.set(key, file);
    },
    get: async (key) => files.get(key),
    delete: async (key) => {
      files.delete(key);
    },
    keys: async () => [...files.keys()],
  };
}
