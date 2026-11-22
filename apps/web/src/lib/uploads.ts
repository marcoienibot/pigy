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
 *   have: the upload asks again until it does.
 *
 * Only the device that has the file uploads it. Another device shows the
 * image as on its way.
 */

/** How an upload stands, for the image to say. */
export type UploadProgress = {
  /** How many bytes the server has, of `total`. */
  sent: number;
  total: number;
  /**
   * Why nothing moves, if nothing does: no answer came, and the upload
   * tries again by itself.
   */
  waiting: boolean;
  /** Why the upload has ended without the image, for the person. */
  error: string | null;
};

/** What an upload asks of the server: see `uploadRequest` of lib/api.ts. */
export type UploadApi = (
  path: string,
  method: "POST" | "PUT",
  body?: Blob,
) => Promise<unknown>;

/** How long an upload waits before it asks again, in milliseconds, by the try. */
export const retryWaitsMs = [1000, 2000, 5000, 15_000, 30_000];

type Running = {
  workspaceId: string;
  file: Blob;
  progress: UploadProgress;
  /** Ends the wait before the next try. */
  wake: (() => void) | null;
  stopped: boolean;
};

export class Uploads {
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<() => void>();
  private readonly urls = new Map<string, string>();
  /** The images whose file the device was asked for and does not have. */
  private readonly missing = new Set<string>();

  constructor(
    private readonly deps: {
      api: UploadApi;
      files: FileStore;
      /** Calls `run` after `ms`. Returns what calls it off. */
      schedule: (run: () => void, ms: number) => () => void;
    },
  ) {}

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

  /** An address of the file of an image, for a picture, if the tab has it. */
  url(mediaId: string): string | undefined {
    return this.urls.get(mediaId);
  }

  /**
   * Takes the file of an image whose row the app has just made, and
   * begins to upload it.
   */
  async add(workspaceId: string, mediaId: string, file: Blob): Promise<void> {
    this.urls.set(mediaId, URL.createObjectURL(file));
    this.start(workspaceId, mediaId, file);
    try {
      await this.deps.files.put(mediaId, file);
    } catch {
      // The device could not keep it: the upload goes on from the memory
      // of the tab, and does not outlast it.
    }
  }

  /**
   * Goes on with the uploads of the images `uploading` of a workspace,
   * which are the ones whose rows say so: of each whose file the device
   * has, and that is not under way in this tab. And lets go of what the
   * tab holds of an image that is no longer among them.
   */
  async resume(workspaceId: string, uploading: readonly string[]) {
    for (const [mediaId, upload] of this.running) {
      if (upload.workspaceId === workspaceId && !uploading.includes(mediaId)) {
        this.stop(mediaId);
      }
    }
    for (const mediaId of uploading) {
      if (this.running.has(mediaId) || this.missing.has(mediaId)) continue;
      let file: Blob | undefined;
      try {
        file = await this.deps.files.get(mediaId);
      } catch {
        file = undefined;
      }
      // Asked for meanwhile, by a second call.
      if (this.running.has(mediaId)) continue;
      if (!file) {
        this.missing.add(mediaId);
        this.changed();
        continue;
      }
      if (!this.urls.has(mediaId)) {
        this.urls.set(mediaId, URL.createObjectURL(file));
      }
      this.start(workspaceId, mediaId, file);
    }
  }

  /** Tries again now what waits for a connection. */
  retry(): void {
    for (const upload of this.running.values()) upload.wake?.();
  }

  /** Ends the upload of an image in this tab, and forgets its file. */
  private stop(mediaId: string): void {
    const upload = this.running.get(mediaId);
    if (!upload) return;
    upload.stopped = true;
    upload.wake?.();
    this.running.delete(mediaId);
    void this.deps.files.delete(mediaId).catch(() => {});
    this.changed();
  }

  private start(workspaceId: string, mediaId: string, file: Blob): void {
    const upload: Running = {
      workspaceId,
      file,
      progress: { sent: 0, total: file.size, waiting: false, error: null },
      wake: null,
      stopped: false,
    };
    this.running.set(mediaId, upload);
    this.missing.delete(mediaId);
    this.changed();
    void this.run(mediaId, upload);
  }

  private set(upload: Running, progress: Partial<UploadProgress>): void {
    upload.progress = { ...upload.progress, ...progress };
    this.changed();
  }

  private async run(mediaId: string, upload: Running): Promise<void> {
    const { api } = this.deps;
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
        this.set(upload, { sent: sentOf(received), waiting: false });
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
        const again =
          unanswered(error) ||
          (error instanceof ApiError &&
            // The row has not reached the server yet, the server is
            // asked too often, or it has trouble of its own.
            (error.status === 404 ||
              error.status === 429 ||
              error.status >= 500));
        if (!again) {
          // Refused: the row says why, when the server has made it say
          // so, and this until then.
          this.set(upload, {
            waiting: false,
            error:
              error instanceof ApiError
                ? error.message
                : "The image could not be uploaded.",
          });
          return;
        }
        this.set(upload, { waiting: true });
        await new Promise<void>((resolve) => {
          const cancel = this.deps.schedule(
            resolve,
            retryWaitsMs[Math.min(tries, retryWaitsMs.length - 1)] ?? 30_000,
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
