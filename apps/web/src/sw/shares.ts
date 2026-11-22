/**
 * What is shared to pigy with files: the share target of the manifest
 * takes images, which a browser can only hand over as the body of a
 * `POST` with `multipart/form-data`. That is a navigation to `/share`,
 * which the service worker answers, `receiveShare`: it keeps the files on
 * the device and sends the browser on to the share screen, with the text
 * in the address as a share without files has it and the name of the kept
 * files beside it. The screen shows them and makes a draft of them only
 * when the person says so, as it does with a text.
 *
 * Any website can make a browser post such a form, so nothing here makes a
 * draft or sends anything anywhere: the files wait on the device for the
 * screen, and go when the person has decided, has left the screen, or
 * after `keptShareMs`, whoever looks first. They are nobody's: they came
 * before anybody was asked, as a text in an address does.
 *
 * This module is the service worker's and the page's: the worker writes,
 * the page reads and deletes. The two can be of different versions, so
 * the name of the database, the form of what it holds and the parameter
 * of the address are a contract between the versions, which does not
 * change.
 */

/**
 * The database of the shares that wait for the share screen. Not under
 * `pigy/`, where the copies of a person are: a share is nobody's.
 *
 * A contract between the versions of the app: see the top of the file.
 */
export const sharesDatabase = "pigy-shares";

/**
 * The parameter of the address of the share screen that names the files
 * that wait for it. A contract between the versions of the app.
 */
export const sharedFilesParameter = "files";

/**
 * The name of the files in the form of a share: `params.files` of the
 * share target in apps/web/public/manifest.webmanifest.
 */
export const sharedFilesField = "images";

/** How long the files of a share wait for the screen at most: an hour. */
export const keptShareMs = 60 * 60 * 1000;

/**
 * How many files of a share are kept, and how large one may be: what a
 * part of a post takes, `maxImagesPerPart` and `maxImageBytes` of
 * @pigy/core, which a service worker does not load. A test holds the two
 * to those.
 */
export const maxSharedFiles = 4;
export const maxSharedFileBytes = 20 * 1024 * 1024;

/** A file of a share, as it came. Nothing of it is taken for true yet. */
export type SharedFile = { name: string; type: string; file: Blob };

/** The files of one share. */
export type KeptShare = {
  id: string;
  /** When it came, in milliseconds since the Unix epoch. */
  at: number;
  files: SharedFile[];
  /** How many files came that were not kept: too many, or too large. */
  left: number;
};

/** Where the shares wait. */
export type ShareStore = {
  put(share: KeptShare): Promise<void>;
  get(id: string): Promise<KeptShare | undefined>;
  delete(id: string): Promise<void>;
  /** Deletes the shares that came before `time`. */
  prune(time: number): Promise<void>;
};

const done = <Result>(request: IDBRequest<Result>) =>
  new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** The shares in IndexedDB, of the service worker or of a page. */
export function indexedDbShares(factory: IDBFactory): ShareStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(sharesDatabase, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("shares", { keyPath: "id" });
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
      request.onerror = () => {
        opened = undefined;
        reject(request.error);
      };
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await database()).transaction("shares", mode).objectStore("shares");
  return {
    put: async (share) => {
      await done((await store("readwrite")).put(share));
    },
    get: async (id) => {
      const share: unknown = await done((await store("readonly")).get(id));
      return isKeptShare(share) ? share : undefined;
    },
    delete: async (id) => {
      await done((await store("readwrite")).delete(id));
    },
    prune: async (time) => {
      const shares = await done((await store("readonly")).getAll());
      const old = shares.filter(
        (share) => !isKeptShare(share) || share.at < time,
      );
      if (old.length === 0) return;
      const writable = await store("readwrite");
      await Promise.all(
        old.map((share) =>
          done(writable.delete((share as { id: IDBValidKey }).id)),
        ),
      );
    },
  };
}

/** Shares in memory, for a test. */
export function memoryShares(): ShareStore & { all(): KeptShare[] } {
  const shares = new Map<string, KeptShare>();
  return {
    put: async (share) => {
      shares.set(share.id, share);
    },
    get: async (id) => shares.get(id),
    delete: async (id) => {
      shares.delete(id);
    },
    prune: async (time) => {
      for (const [id, share] of shares) {
        if (share.at < time) shares.delete(id);
      }
    },
    all: () => [...shares.values()],
  };
}

/**
 * Whether `value` is a share as this module writes one. What a database
 * holds was written by some version of the app: one that is not as this
 * version reads it is no share.
 */
function isKeptShare(value: unknown): value is KeptShare {
  if (typeof value !== "object" || value === null) return false;
  const share = value as Partial<KeptShare>;
  return (
    typeof share.id === "string" &&
    typeof share.at === "number" &&
    typeof share.left === "number" &&
    Array.isArray(share.files) &&
    share.files.every(
      (file) =>
        typeof file?.name === "string" &&
        typeof file.type === "string" &&
        file.file instanceof Blob,
    )
  );
}

/** What `receiveShare` works with. */
export type ShareTools = {
  store: ShareStore;
  now(): number;
  /** A name for the files of a share that nobody can guess. */
  newId(): string;
};

/**
 * The answer of the service worker to a share, `request`: a `POST` of
 * `multipart/form-data` to `/share`. It keeps the files of the share for
 * the share screen and sends the browser there, with what was said as
 * the address of a share without files has it, and `files` naming the
 * kept files. A file is kept as it came: the screen reads its bytes
 * before it shows it as an image.
 *
 * A form that is no share, or that cannot be read, is a share of nothing,
 * whose screen leads to the drafts. Files that cannot be kept, because
 * the device has no room, are as good as not shared: the screen shows
 * what was said, and a share is what can be decided about on the screen,
 * which these are not.
 */
export async function receiveShare(
  request: Request,
  origin: string,
  { store, now, newId }: ShareTools,
): Promise<Response> {
  let form: FormData | undefined;
  try {
    form = await request.formData();
  } catch {
    form = undefined;
  }
  const query = new URLSearchParams();
  for (const name of ["title", "text", "url"]) {
    const value = form?.get(name);
    if (typeof value === "string" && value !== "") query.set(name, value);
  }
  const files = (form?.getAll(sharedFilesField) ?? []).filter(
    (value): value is File => typeof value !== "string" && value.size > 0,
  );
  const kept = files
    .filter((file) => file.size <= maxSharedFileBytes)
    .slice(0, maxSharedFiles);
  if (kept.length > 0) {
    const at = now();
    const id = newId();
    try {
      // What was left behind by a screen that was never shown, or by a
      // tab that was closed on it.
      await store.prune(at - keptShareMs).catch(() => {});
      await store.put({
        id,
        at,
        files: kept.map((file) => ({
          name: file.name,
          type: file.type,
          file,
        })),
        left: files.length - kept.length,
      });
      query.set(sharedFilesParameter, id);
    } catch {
      // No room on the device: the text goes on alone.
    }
  }
  const search = query.toString();
  // A redirect after a POST, which the browser follows with a GET: going
  // back to the screen, or loading it again, sends nothing a second time.
  return Response.redirect(
    new URL(`/share${search ? `?${search}` : ""}`, origin).href,
    303,
  );
}
