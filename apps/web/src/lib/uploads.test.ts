import { uploadChunkBytes, uuidv7 } from "@pigy/core";
import { expect, test } from "vitest";
import { ApiError, Unanswered } from "@/lib/api";
import { memoryFiles } from "@/lib/upload-files";
import {
  type RowState,
  type UploadApi,
  type UploadLocks,
  Uploads,
} from "@/lib/uploads";

const workspaceId = "workspace";
const base = `/api/workspaces/${workspaceId}/media`;

/**
 * A server that takes chunks as the Worker does, and can be made to fail
 * a request: `fail` is handed every request before it is carried out.
 */
function server(
  fail: (request: string) => Error | undefined = () => undefined,
) {
  const received = new Map<string, Map<number, Blob>>();
  const completed: string[] = [];
  const requests: string[] = [];
  const api: UploadApi = async (path, method, body) => {
    const request = `${method} ${path.slice(base.length)}`;
    requests.push(request);
    const failure = fail(request);
    if (failure) throw failure;
    const [, mediaId = "", , number] = path.slice(base.length).split("/");
    const chunks = received.get(mediaId) ?? new Map<number, Blob>();
    received.set(mediaId, chunks);
    if (number === "complete") {
      completed.push(mediaId);
      return { status: "ready" };
    }
    if (number !== undefined && body) chunks.set(Number(number), body);
    return {
      chunkBytes: uploadChunkBytes,
      received: [...chunks.keys()].sort(),
    };
  };
  return { api, received, completed, requests };
}

/**
 * The Web Locks of a browser, which its tabs share: `tab()` is the locks
 * of a tab, and `close` closes it, which lets go of what it holds.
 */
function browserLocks() {
  type Waiter = { tab: number; grant: () => void };
  const held = new Map<string, number>();
  const queues = new Map<string, Waiter[]>();
  let tabs = 0;
  const free = (name: string) => {
    held.delete(name);
    queues.get(name)?.shift()?.grant();
  };
  return {
    held,
    tab() {
      const id = ++tabs;
      let closed = false;
      const locks: UploadLocks = {
        request(name, { ifAvailable }, callback) {
          // A closed tab runs nothing.
          if (closed) return new Promise(() => {});
          const run = async () => {
            held.set(name, id);
            try {
              await callback({ name });
            } finally {
              if (!closed && held.get(name) === id) free(name);
            }
          };
          if (!held.has(name) && !queues.get(name)?.length) return run();
          if (ifAvailable) return callback(null);
          return new Promise<void>((resolve, reject) => {
            const queue = queues.get(name) ?? [];
            queues.set(name, queue);
            queue.push({
              tab: id,
              grant: () => void run().then(resolve, reject),
            });
          });
        },
      };
      const close = () => {
        closed = true;
        for (const queue of queues.values()) {
          queue.splice(
            0,
            queue.length,
            ...queue.filter(({ tab }) => tab !== id),
          );
        }
        for (const [name, tab] of held) if (tab === id) free(name);
      };
      return { locks, close };
    },
  };
}

/** Addresses of files that a test can count. */
function fileUrls() {
  const made: string[] = [];
  const revoked: string[] = [];
  return {
    made,
    revoked,
    urls: {
      create: () => {
        made.push(`blob:${made.length + 1}`);
        return made.at(-1) as string;
      },
      revoke: (url: string) => revoked.push(url),
    },
  };
}

/** Uploads with timers that the test runs. */
function uploadsOf(
  api: UploadApi,
  files = memoryFiles(),
  more: Partial<ConstructorParameters<typeof Uploads>[0]> = {},
) {
  const waiting: (() => void)[] = [];
  const uploads = new Uploads({
    api,
    files,
    schedule: (run) => {
      waiting.push(run);
      return () => {};
    },
    ...more,
  });
  /** Lets every wait of an upload end, as when its time is up. */
  const pass = () => {
    for (const run of waiting.splice(0)) run();
  };
  return { uploads, files, pass, waiting };
}

/** Until `done` says so: what an upload does is not awaited by its caller. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 1000 && !done(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}

const fileOf = (bytes: number) => new Blob([new Uint8Array(bytes).fill(7)]);

test("a file goes up in chunks, each the bytes of its place, and is completed", async () => {
  const { api, received, completed } = server();
  const { uploads } = uploadsOf(api);
  const file = fileOf(uploadChunkBytes + 1000);
  await uploads.add(workspaceId, "one", file);
  await until(() => completed.length === 1);
  const chunks = received.get("one");
  expect(chunks?.get(1)?.size).toBe(uploadChunkBytes);
  expect(chunks?.get(2)?.size).toBe(1000);
  expect(uploads.progress("one")).toMatchObject({
    sent: file.size,
    total: file.size,
    waiting: null,
    error: null,
  });
});

test("an upload that got no answer waits, says so, and goes on with the chunks that are missing", async () => {
  // The second chunk gets no answer the first time, as on a connection
  // that is lost.
  let lost = false;
  const { api, received, completed, requests } = server((request) => {
    if (request === "PUT /one/upload/2" && !lost) {
      lost = true;
      return new Unanswered("Failed to fetch", undefined);
    }
    return undefined;
  });
  const { uploads, pass } = uploadsOf(api);
  await uploads.add(workspaceId, "one", fileOf(uploadChunkBytes * 2 + 10));
  await until(() => uploads.progress("one")?.waiting === "connection");
  expect(uploads.progress("one")?.sent).toBe(uploadChunkBytes);
  expect(completed).toEqual([]);

  pass();
  await until(() => completed.length === 1);
  // It asked what the server has, and sent the first chunk once.
  expect(
    requests.filter((request) => request === "PUT /one/upload/1"),
  ).toHaveLength(1);
  expect([...(received.get("one")?.keys() ?? [])]).toEqual([1, 2, 3]);
});

test("an upload whose row the server does not have yet asks again, and one that is refused says why and stops", async () => {
  let known = false;
  const { api, completed } = server((request) => {
    if (request.startsWith("POST /late/") && !known) {
      return new ApiError(404, "There is no such image");
    }
    if (request.startsWith("POST /full/")) {
      return new ApiError(413, "The workspace holds as many images as it can.");
    }
    return undefined;
  });
  const { uploads, pass, waiting } = uploadsOf(api);
  await uploads.add(workspaceId, "late", fileOf(10));
  await uploads.add(workspaceId, "full", fileOf(10));
  // Not for a connection: the server answered, and has no such image yet.
  await until(() => uploads.progress("late")?.waiting === "server");
  await until(() => uploads.progress("full")?.error !== null);
  expect(uploads.progress("full")?.error).toBe(
    "The workspace holds as many images as it can.",
  );
  // Only the one that waits has a timer.
  expect(waiting).toHaveLength(1);

  // The mutation that makes the row has arrived.
  known = true;
  pass();
  await until(() => completed.includes("late"));
  expect(completed).toEqual(["late"]);
});

test("an upload asks for nothing until the server has the row of its image, and says meanwhile what it waits for", async () => {
  const { api, completed, requests } = server();
  // How the row stands, as the copy of the workspace says, and the
  // uploads that follow it.
  let row: RowState = "offline";
  const following = new Set<(row: RowState) => void>();
  const tell = (now: RowState) => {
    row = now;
    for (const told of [...following]) told(now);
  };
  const { uploads } = uploadsOf(api, memoryFiles(), {
    rowOf: (_, __, told) => {
      following.add(told);
      told(row);
      return () => following.delete(told);
    },
  });
  await uploads.add(workspaceId, "one", fileOf(10));
  await until(() => uploads.progress("one")?.waiting === "connection");
  tell("waiting");
  expect(uploads.progress("one")?.waiting).toBe("server");
  // Before, the first request went out at once, and the server answered
  // it with a 404 while the mutation that makes the row was on its way.
  expect(requests).toEqual([]);

  tell("sent");
  await until(() => completed.length === 1);
  expect(requests[0]).toBe("POST /one/upload");
  expect(following.size).toBe(0);

  // An upload that ends while it waits asks for nothing.
  tell("waiting");
  await uploads.add(workspaceId, "two", fileOf(10));
  await until(() => following.size === 1);
  await uploads.resume(workspaceId, []);
  expect(following.size).toBe(0);
  expect(requests.filter((request) => request.includes("/two/"))).toEqual([]);
});

test("an upload whose file the device could not keep is counted until it ends: signing out would lose it", async () => {
  const { api, completed } = server((request) =>
    // The server does not answer yet, so the upload goes on.
    request.startsWith("PUT ")
      ? new Unanswered("Failed to fetch", undefined)
      : undefined,
  );
  // The device has no room for the first file, and room for the second.
  const files = memoryFiles();
  const full = {
    ...files,
    put: async (key: string, file: Blob) => {
      if (key.endsWith("/unkept")) {
        throw new DOMException("The disk is full", "QuotaExceededError");
      }
      await files.put(key, file);
    },
  };
  const { uploads } = uploadsOf(api, full);
  await uploads.add(workspaceId, "unkept", fileOf(10));
  await until(() => uploads.progress("unkept")?.waiting === "connection");
  expect(uploads.unkept()).toBe(1);
  // A file that the device kept is not counted here: whoever counts what
  // the device holds counts it.
  await uploads.add(workspaceId, "kept", fileOf(10));
  expect(uploads.unkept()).toBe(1);

  // The row says that the upload has ended.
  await uploads.resume(workspaceId, ["kept"]);
  expect(uploads.unkept()).toBe(0);
  expect(completed).toEqual([]);
});

test("a tab that is loaded again goes on with the files that the device kept, and says which it does not have", async () => {
  const { api, completed } = server();
  const files = memoryFiles();
  await files.put(`${workspaceId}/kept`, fileOf(10));
  const { uploads } = uploadsOf(api, files);
  await uploads.resume(workspaceId, ["kept", "elsewhere"]);
  await until(() => completed.length === 1);
  expect(completed).toEqual(["kept"]);
  expect(uploads.lacks("elsewhere")).toBe(true);
  expect(uploads.lacks("kept")).toBe(false);
  expect(uploads.url("kept")).toMatch(/^blob:/);

  // The row says that the upload has ended: the file is let go of.
  await uploads.resume(workspaceId, ["elsewhere"]);
  await until(() => uploads.progress("kept") === undefined);
  expect(await files.get(`${workspaceId}/kept`)).toBeUndefined();
});

test("of two tabs, one uploads an image, and the other takes it over when that tab is closed", async () => {
  const { api, completed } = server();
  const sent = { first: [] as string[], second: [] as string[] };
  // The first tab's upload gets no answer for as long as the tab lives.
  const first: UploadApi = (path, method) => {
    sent.first.push(`${method} ${path}`);
    return new Promise(() => {});
  };
  const second: UploadApi = (path, method, body) => {
    sent.second.push(`${method} ${path}`);
    return api(path, method, body);
  };
  const browser = browserLocks();
  const files = memoryFiles();
  const one = browser.tab();
  const two = browser.tab();
  const a = uploadsOf(first, files, { locks: one.locks });
  const b = uploadsOf(second, files, { locks: two.locks });

  await a.uploads.add(workspaceId, "one", fileOf(10));
  // The second tab hears of the row, as every tab of the person does, and
  // finds the file that the first one keeps. Before, it uploaded it too.
  await b.uploads.resume(workspaceId, ["one"]);
  await until(() => b.uploads.elsewhere("one"));
  expect(sent.second).toEqual([]);
  expect(b.uploads.lacks("one")).toBe(false);

  // The first tab is closed in the middle of its upload.
  one.close();
  await until(() => completed.includes("one"));
  expect(sent.second[0]).toBe(`POST ${base}/one/upload`);
  expect(b.uploads.elsewhere("one")).toBe(false);
  expect(completed).toEqual(["one"]);
});

test("a tab that waits for another to upload an image does not upload it once that one is done", async () => {
  const { api, completed, requests } = server();
  const browser = browserLocks();
  const files = memoryFiles();
  const one = browser.tab();
  const two = browser.tab();
  const a = uploadsOf(api, files, { locks: one.locks });
  const b = uploadsOf(
    () => Promise.reject(new Error("The second tab sent a request")),
    files,
    { locks: two.locks },
  );
  await a.uploads.add(workspaceId, "one", fileOf(10));
  await b.uploads.resume(workspaceId, ["one"]);
  await until(() => completed.includes("one"));
  // The row says that the upload has ended, the first tab first: it lets
  // go of the file and then of the lock, and the second tab, which has not
  // heard yet, finds no file.
  await a.uploads.resume(workspaceId, []);
  await until(() => b.uploads.lacks("one"));
  await b.uploads.resume(workspaceId, []);
  expect(
    requests.filter((request) => request.startsWith("POST /one/upload")),
  ).toHaveLength(2);
  expect(await files.keys()).toEqual([]);
  expect(browser.held.size).toBe(0);
});

test("the address of a file goes with its upload", async () => {
  const { api, completed } = server();
  const { urls, made, revoked } = fileUrls();
  const { uploads } = uploadsOf(api, memoryFiles(), { urls });
  await uploads.add(workspaceId, "one", fileOf(10));
  await until(() => completed.includes("one"));
  expect(uploads.url("one")).toBe("blob:1");
  // The row says that the image is ready: the tile shows the small
  // picture, and the file, which may be of millions of pixels, is let go.
  await uploads.resume(workspaceId, []);
  expect(revoked).toEqual(made);
  expect(uploads.url("one")).toBeUndefined();
});

test("the files of uploads that ended while no tab ran them are deleted, and the ones that may still be needed are kept", async () => {
  const { api } = server();
  const files = memoryFiles();
  const now = new Date("2026-11-22T12:00:00Z");
  const ended = uuidv7(new Date("2026-11-22T11:00:00Z"));
  const gone = uuidv7(new Date("2026-11-20T12:00:00Z"));
  const unheard = uuidv7(new Date("2026-11-22T11:59:00Z"));
  for (const id of [ended, gone, unheard]) {
    await files.put(`${workspaceId}/${id}`, fileOf(10));
  }
  await files.put(`other/${gone}`, fileOf(10));
  const { uploads } = uploadsOf(api, files, {
    locks: browserLocks().tab().locks,
    now: () => now.getTime(),
  });
  // The tab knows the row of the first, which is ready. Of the second it
  // knows nothing, and it is two days old: its row is gone. The third is
  // a minute old: its row may not have reached this tab yet. Before, all
  // of them stayed until the person signed out.
  await uploads.resume(workspaceId, [], [ended]);
  expect((await files.keys()).sort()).toEqual(
    [`${workspaceId}/${unheard}`, `other/${gone}`].sort(),
  );
});
