import { uploadChunkBytes } from "@pigy/core";
import { expect, test } from "vitest";
import { ApiError, Unanswered } from "@/lib/api";
import { memoryFiles } from "@/lib/upload-files";
import { type UploadApi, Uploads } from "@/lib/uploads";

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

/** Uploads with timers that the test runs. */
function uploadsOf(api: UploadApi, files = memoryFiles()) {
  const waiting: (() => void)[] = [];
  const uploads = new Uploads({
    api,
    files,
    schedule: (run) => {
      waiting.push(run);
      return () => {};
    },
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
    waiting: false,
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
  await until(() => uploads.progress("one")?.waiting === true);
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
  await until(() => uploads.progress("late")?.waiting === true);
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

test("a tab that is loaded again goes on with the files that the device kept, and says which it does not have", async () => {
  const { api, completed } = server();
  const files = memoryFiles();
  await files.put("kept", fileOf(10));
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
  expect(await files.get("kept")).toBeUndefined();
});
