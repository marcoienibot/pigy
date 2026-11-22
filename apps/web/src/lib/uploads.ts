import {
  mediaUploadPath,
  uploadChunkRange,
  uploadChunks,
  uploadStateSchema,
} from "@pigy/core";
import { ApiError, unanswered } from "@/lib/api";
import type { FileStore } from "@/lib/upload-files";

/**
 * The uploads of a tab: the images that were put into drafts on this
 * device and whose bytes the server does not have yet. SYNC.md, "Images",
 * has the row of an image, and `packages/core/src/media/upload.ts` how
 * the bytes travel.
 *
 * What "resumable" means here:
 *
 * - The file goes in chunks, and the server says which it has. An upload
 *   that is cut off, by a connection that is lost or a page that is
 *   closed, goes on with the chunks that are missing.
 * - The file is kept on the device until its upload has ended: in the
 *   memory of the tab, and in IndexedDB, where a tab that is loaded
 *   again finds it. A device that has lost the file, because the browser
 *   cleared its storage, cannot go on: the image says so, and the person
 *   attaches it again.
 * - An image that is put into a draft without a connection waits. Its
 *   row is made by a mutation, which waits in the outbox like every
 *   change, and the server knows no upload for a row that it does not
 *   have. So an upload asks nothing until the copy of its workspace says
 *   that the server has confirmed that mutation, `rowOf`, and asks again
 *   after a 404 all the same: a tab that does not sync the workspace
 *   cannot tell.
 *
 * Only the device that has the file uploads it. Another device shows the
 * image as on its way. And on the device, one tab: every tab of the
 * person is told of the rows, and the files are in a database that they
 * share. The tab that uploads an image holds the Web Lock of the upload,
 * `uploadLock`, from the moment it begins until the row says that the
 * upload has ended. Another tab waits for the lock and does not upload,
 * and takes the upload over when it gets the lock: when the tab that
 * held it is closed. A file is deleted while its lock is held, so a tab
 * that takes the lock over afterwards finds the file only if the upload
 * still needs it.
 *
 * What the tab holds of a file goes when its upload does: the address of
 * its picture, which keeps the file in the memory of the page while it
 * exists, and the file on the device. A file whose upload ended while no
 * tab ran it is deleted the next time its workspace is looked after.
 */

/** How an upload stands, for the image to say. */
export type UploadProgress = {
  /** How many bytes the server has, of `total`. */
  sent: number;
  total: number;
  /**
   * Why nothing moves, if nothing does, or null. `connection`: no answer
   * came. `server`: the server does not take the upload yet, because the
   * row of the image has not reached it, or it is asked too often. Either
   * way the upload tries again by itself.
   */
  waiting: "connection" | "server" | null;
  /** Why the upload has ended without the image, for the person. */
  error: string | null;
};

/** What an upload asks of the server: see `uploadRequest` of lib/api.ts. */
export type UploadApi = (
  path: string,
  method: "POST" | "PUT",
  body?: Blob,
) => Promise<unknown>;

/**
 * What an upload takes of the Web Locks of a browser, `navigator.locks`:
 * a lock by a name, held until the promise of `callback` settles, and
 * with `ifAvailable` handed `null` in place of a lock that somebody holds.
 */
export type UploadLocks = {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
};

/**
 * The name of the Web Lock that the tab which uploads the image `mediaId`
 * holds. A contract between the tabs of a device, which can run two
 * versions of the app: it does not change.
 */
export const uploadLock = (mediaId: string) => `pigy/upload/${mediaId}`;

/**
 * How the row of an image stands for the server, as far as the copy of
 * its workspace in this tab can tell. `sent`: the server has confirmed
 * the mutation that makes it. Until then, `offline` while the tab cannot
 * reach the server, and `waiting` while it can.
 */
export type RowState = "sent" | "offline" | "waiting";

/** Addresses of files, for pictures: `URL.createObjectURL` and its undoing. */
export type FileUrls = {
  create(file: Blob): string;
  revoke(url: string): void;
};

/** How long an upload waits before it asks again, in milliseconds, by the try. */
export const retryWaitsMs = [1000, 2000, 5000, 15_000, 30_000];

/**
 * The same for a server that does not have the row of the image yet: the
 * mutation that makes the row is on its way, a moment behind the file.
 */
export const rowWaitsMs = [200, 500, 1000, 2000, 5000, 15_000, 30_000];

/**
 * How old an image is, by the time in its ID, before a file of it whose
 * row the tab does not know is taken for one whose row is gone, in
 * milliseconds: a day, after which the server deletes the row of an image
 * that is in no part. A younger row may not have reached the tab yet.
 */
export const unknownRowMs = 24 * 60 * 60 * 1000;

type Running = {
  workspaceId: string;
  file: Blob;
  progress: UploadProgress;
  /** Ends the wait before the next try. */
  wake: (() => void) | null;
  /** Ends the wait for the row, for an upload that is stopped. */
  halt: (() => void) | null;
  stopped: boolean;
  /** Lets go of the lock of the upload. */
  release: () => void;
};

/** Where the file of an image is kept on the device. */
const fileKey = (workspaceId: string, mediaId: string) =>
  `${workspaceId}/${mediaId}`;

/** When the image `mediaId` was made, by the time that a UUID v7 has in it. */
const madeAt = (mediaId: string) =>
  Number.parseInt(mediaId.replaceAll("-", "").slice(0, 12), 16);

export class Uploads {
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<() => void>();
  private readonly urls = new Map<string, string>();
  /** The images whose file the device was asked for and does not have. */
  private readonly missing = new Set<string>();
  /** The images whose lock the tab waits for: another tab uploads them. */
  private readonly others = new Set<string>();
  /** The images whose lock the tab has asked for and not been given yet. */
  private readonly asked = new Set<string>();
  /** What the rows of each workspace said last of the images on their way. */
  private readonly uploading = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly deps: {
      api: UploadApi;
      files: FileStore;
      /** Calls `run` after `ms`. Returns what calls it off. */
      schedule: (run: () => void, ms: number) => () => void;
      /** The Web Locks of the browser, where it has them. */
      locks?: UploadLocks | undefined;
      /**
       * Calls `told` with how the row of the image `mediaId` stands, at
       * once and whenever that may have changed, until what it returns is
       * called. Without it, an upload asks at once.
       */
      rowOf?: (
        workspaceId: string,
        mediaId: string,
        told: (row: RowState) => void,
      ) => () => void;
      urls?: FileUrls;
      now?: () => number;
    },
  ) {}

  private get fileUrls(): FileUrls {
    return (
      this.deps.urls ?? {
        create: (file) => URL.createObjectURL(file),
        revoke: (url) => URL.revokeObjectURL(url),
      }
    );
  }

  /** Tells `listener` of every change of an upload. Returns what ends that. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** How the upload of an image stands, or undefined if this tab runs none. */
  progress(mediaId: string): UploadProgress | undefined {
    return this.running.get(mediaId)?.progress;
  }

  /**
   * Whether the device is known not to have the file of an image that is
   * on its way: another device has it, or this one has lost it.
   */
  lacks(mediaId: string): boolean {
    return this.missing.has(mediaId);
  }

  /** Whether another tab of the device uploads the image. */
  elsewhere(mediaId: string): boolean {
    return this.others.has(mediaId);
  }

  /**
   * An address of the file of an image, for a picture, while the tab
   * uploads it.
   */
  url(mediaId: string): string | undefined {
    return this.urls.get(mediaId);
  }

  /**
   * Takes the file of an image whose row the app has just made, and
   * begins to upload it.
   */
  async add(workspaceId: string, mediaId: string, file: Blob): Promise<void> {
    // The lock is asked for before the file is stored, so that no other
    // tab takes the file for one whose upload has ended.
    this.start(workspaceId, mediaId, file, this.hold(mediaId));
    try {
      await this.deps.files.put(fileKey(workspaceId, mediaId), file);
    } catch {
      // The device could not keep it: the upload goes on from the memory
      // of the tab, and does not outlast it.
    }
  }

  /**
   * Goes on with the uploads of the images `uploading` of a workspace,
   * which are the ones whose rows say so: of each whose file the device
   * has, and that no tab of the device runs. Lets go of what the tab
   * holds of an image that is no longer among them. And deletes the files
   * that the device keeps of the workspace and that no upload needs any
   * more: of an image among `known`, the images whose rows the tab has,
   * that is not on its way, and of one whose row is gone.
   */
  async resume(
    workspaceId: string,
    uploading: readonly string[],
    known: readonly string[] = uploading,
  ): Promise<void> {
    this.uploading.set(workspaceId, new Set(uploading));
    for (const [mediaId, upload] of this.running) {
      if (upload.workspaceId === workspaceId && !uploading.includes(mediaId)) {
        this.stop(mediaId);
      }
    }
    for (const mediaId of uploading) {
      if (
        this.running.has(mediaId) ||
        this.asked.has(mediaId) ||
        this.missing.has(mediaId)
      ) {
        continue;
      }
      this.take(workspaceId, mediaId);
    }
    await this.tidy(workspaceId, uploading, known);
  }

  /** Tries again now what waits for a connection. */
  retry(): void {
    for (const upload of this.running.values()) upload.wake?.();
  }

  /** Whether the rows of `workspaceId` last said that `mediaId` is on its way. */
  private wanted(workspaceId: string, mediaId: string): boolean {
    return this.uploading.get(workspaceId)?.has(mediaId) ?? false;
  }

  /**
   * Asks for the lock of the upload of `mediaId`, which a tab holds for
   * as long as it runs the upload. Returns what lets go of it.
   */
  private hold(mediaId: string): () => void {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void this.deps.locks
      ?.request(uploadLock(mediaId), {}, () => held)
      .catch(() => {});
    return release;
  }

  /**
   * Uploads an image whose row says that it is on its way, from the file
   * that the device keeps, once the tab holds its lock: at once if no tab
   * runs the upload, and when the one that does lets go of it otherwise.
   */
  private take(workspaceId: string, mediaId: string): void {
    this.asked.add(mediaId);
    const { files, locks } = this.deps;
    /** Runs the upload while the lock is held, and returns when it may go. */
    const run = async () => {
      this.asked.delete(mediaId);
      const wasOther = this.others.delete(mediaId);
      if (!this.wanted(workspaceId, mediaId) || this.running.has(mediaId)) {
        if (wasOther) this.changed();
        return;
      }
      let file: Blob | undefined;
      try {
        file = await files.get(fileKey(workspaceId, mediaId));
      } catch {
        file = undefined;
      }
      // Ended meanwhile, or taken up by `add`.
      if (!this.wanted(workspaceId, mediaId) || this.running.has(mediaId)) {
        return;
      }
      if (!file) {
        this.missing.add(mediaId);
        this.changed();
        return;
      }
      const upload = file;
      await new Promise<void>((release) =>
        this.start(workspaceId, mediaId, upload, release),
      );
    };
    if (!locks) {
      void run();
      return;
    }
    void locks
      .request(uploadLock(mediaId), { ifAvailable: true }, async (lock) => {
        if (lock) return run();
        // Another tab uploads it. This one takes it over when that one
        // lets go: when its tab is closed, or the upload has ended.
        this.others.add(mediaId);
        this.changed();
        void locks
          .request(uploadLock(mediaId), {}, run)
          .catch(() => this.asked.delete(mediaId));
      })
      .catch(() => this.asked.delete(mediaId));
  }

  /**
   * Deletes the files of `workspaceId` that no upload needs: see
   * `resume`. Only a file whose lock is free, so that a tab that uploads
   * the image, and may know of a row that this one has not heard of yet,
   * keeps it. Without Web Locks, nothing is deleted here: signing out
   * deletes the files.
   */
  private async tidy(
    workspaceId: string,
    uploading: readonly string[],
    known: readonly string[],
  ): Promise<void> {
    const { files, locks, now = Date.now } = this.deps;
    if (!locks) return;
    let keys: string[];
    try {
      keys = await files.keys();
    } catch {
      return;
    }
    for (const key of keys) {
      const [owner, mediaId = ""] = key.split("/");
      if (
        owner !== workspaceId ||
        uploading.includes(mediaId) ||
        this.running.has(mediaId) ||
        this.asked.has(mediaId)
      ) {
        continue;
      }
      const gone = known.includes(mediaId)
        ? true
        : now() - madeAt(mediaId) > unknownRowMs;
      if (!gone) continue;
      await locks
        .request(uploadLock(mediaId), { ifAvailable: true }, async (lock) => {
          if (lock) await files.delete(key);
        })
        .catch(() => {});
    }
  }

  /**
   * Ends the upload of an image in this tab, forgets its file, and lets go
   * of its lock once the file is deleted.
   */
  private stop(mediaId: string): void {
    const upload = this.running.get(mediaId);
    if (!upload) return;
    upload.stopped = true;
    upload.wake?.();
    upload.halt?.();
    this.running.delete(mediaId);
    const url = this.urls.get(mediaId);
    if (url !== undefined) {
      this.fileUrls.revoke(url);
      this.urls.delete(mediaId);
    }
    void this.deps.files
      .delete(fileKey(upload.workspaceId, mediaId))
      .catch(() => {})
      .finally(upload.release);
    this.changed();
  }

  private start(
    workspaceId: string,
    mediaId: string,
    file: Blob,
    release: () => void,
  ): void {
    const upload: Running = {
      workspaceId,
      file,
      progress: { sent: 0, total: file.size, waiting: null, error: null },
      wake: null,
      halt: null,
      stopped: false,
      release,
    };
    this.running.set(mediaId, upload);
    if (!this.urls.has(mediaId)) {
      this.urls.set(mediaId, this.fileUrls.create(file));
    }
    this.missing.delete(mediaId);
    this.changed();
    void this.run(mediaId, upload);
  }

  private set(upload: Running, progress: Partial<UploadProgress>): void {
    upload.progress = { ...upload.progress, ...progress };
    this.changed();
  }

  /**
   * Waits until the server has the row of the image, as far as the tab can
   * tell, and says meanwhile what the upload waits for: a request before
   * would be answered with a 404, which the browser writes into the
   * console of the page. Over when the upload is stopped too.
   */
  private async rowFirst(mediaId: string, upload: Running): Promise<void> {
    const { rowOf } = this.deps;
    if (!rowOf) return;
    await new Promise<void>((resolve) => {
      let done = false;
      let stopFollowing: (() => void) | undefined;
      const end = () => {
        if (done) return;
        done = true;
        upload.halt = null;
        stopFollowing?.();
        resolve();
      };
      upload.halt = end;
      stopFollowing = rowOf(upload.workspaceId, mediaId, (row) => {
        if (done) return;
        if (row === "sent") end();
        else {
          this.set(upload, {
            waiting: row === "offline" ? "connection" : "server",
          });
        }
      });
      // Told at once, before it returned what stops it.
      if (done) stopFollowing();
    });
  }

  private async run(mediaId: string, upload: Running): Promise<void> {
    const { api } = this.deps;
    await this.rowFirst(mediaId, upload);
    const path = mediaUploadPath(upload.workspaceId, mediaId);
    const { file } = upload;
    const sentOf = (received: readonly number[]) =>
      received.reduce((sum, number) => {
        const { start, end } = uploadChunkRange(file.size, number);
        return sum + end - start;
      }, 0);
    for (let tries = 0; !upload.stopped; tries++) {
      try {
        let { received } = uploadStateSchema.parse(await api(path, "POST"));
        this.set(upload, { sent: sentOf(received), waiting: null });
        for (let number = 1; number <= uploadChunks(file.size); number++) {
          if (received.includes(number) || upload.stopped) continue;
          const { start, end } = uploadChunkRange(file.size, number);
          ({ received } = uploadStateSchema.parse(
            await api(`${path}/${number}`, "PUT", file.slice(start, end)),
          ));
          this.set(upload, { sent: sentOf(received) });
          tries = 0;
        }
        if (upload.stopped) return;
        await api(`${path}/complete`, "POST");
        // The row says how it ended, and `resume` lets go of the file
        // when it does.
        this.set(upload, { sent: file.size });
        return;
      } catch (error) {
        const lost = unanswered(error);
        // The row has not reached the server yet, as in a tab that cannot
        // tell, or the image is gone, which `resume` hears of.
        const early = error instanceof ApiError && error.status === 404;
        const again =
          lost ||
          early ||
          // The server is asked too often, or has trouble of its own.
          (error instanceof ApiError &&
            (error.status === 429 || error.status >= 500));
        if (!again) {
          // Refused: the row says why, when the server has made it say
          // so, and this until then.
          this.set(upload, {
            waiting: null,
            error:
              error instanceof ApiError
                ? error.message
                : "The image could not be uploaded.",
          });
          return;
        }
        this.set(upload, { waiting: lost ? "connection" : "server" });
        const waits = early ? rowWaitsMs : retryWaitsMs;
        await new Promise<void>((resolve) => {
          const cancel = this.deps.schedule(
            resolve,
            waits[Math.min(tries, waits.length - 1)] ?? 30_000,
          );
          upload.wake = () => {
            cancel();
            resolve();
          };
        });
        upload.wake = null;
      }
    }
  }
}
