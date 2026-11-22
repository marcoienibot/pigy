import { maxImageBytes, maxImagesPerPart } from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  keptShareMs,
  maxSharedFileBytes,
  maxSharedFiles,
  memoryShares,
  receiveShare,
  type ShareTools,
  sharedFilesField,
  sharedFilesParameter,
} from "./shares.ts";

const origin = "https://pigy.example";

/** A share as the share target of the manifest posts it. */
function share(fields: Record<string, string | File | File[]>): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      form.append(name, one);
    }
  }
  return new Request(`${origin}/share`, { method: "POST", body: form });
}

const image = (name: string, bytes = 3) =>
  new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });

function tools(now = 10_000) {
  const store = memoryShares();
  let next = 0;
  const shareTools: ShareTools = {
    store,
    now: () => now,
    newId: () => `share-${++next}`,
  };
  return { store, shareTools };
}

/** Where the answer sends the browser, as a path with its query. */
async function whereTo(answer: Response): Promise<string> {
  expect(answer.status).toBe(303);
  const location = new URL(answer.headers.get("Location") ?? "");
  expect(location.origin).toBe(origin);
  return location.pathname + location.search;
}

describe("receiveShare", () => {
  it("sends a share of a text on to the share screen with the text in the address, and keeps nothing", async () => {
    const { store, shareTools } = tools();
    const answer = await receiveShare(
      share({ title: "A page", text: "", url: "https://example.com/a" }),
      origin,
      shareTools,
    );
    // As the share target of a GET sent it, which the screen reads.
    expect(await whereTo(answer)).toBe(
      "/share?title=A+page&url=https%3A%2F%2Fexample.com%2Fa",
    );
    expect(store.all()).toEqual([]);
  });

  it("keeps the files of a share for the screen, and names them in the address", async () => {
    const { store, shareTools } = tools();
    const files = [image("one.jpg"), image("two.jpg")];
    const answer = await receiveShare(
      share({ text: "Two photos", [sharedFilesField]: files }),
      origin,
      shareTools,
    );
    expect(await whereTo(answer)).toBe(
      `/share?text=Two+photos&${sharedFilesParameter}=share-1`,
    );
    const [kept] = store.all();
    expect(kept).toMatchObject({
      id: "share-1",
      at: 10_000,
      left: 0,
      files: [
        { name: "one.jpg", type: "image/jpeg" },
        { name: "two.jpg", type: "image/jpeg" },
      ],
    });
    // As they came: what they are is read on the screen.
    expect(await kept?.files[0]?.file.arrayBuffer()).toEqual(
      await files[0]?.arrayBuffer(),
    );
  });

  it("keeps as many files as a part takes, none larger than an image may be, and counts the others", async () => {
    const { store, shareTools } = tools();
    await receiveShare(
      share({
        [sharedFilesField]: [
          image("large.jpg", maxSharedFileBytes + 1),
          ...Array.from({ length: 5 }, (_, index) => image(`${index}.jpg`)),
          // An empty file is no file.
          image("empty.jpg", 0),
        ],
      }),
      origin,
      shareTools,
    );
    const [kept] = store.all();
    expect(kept?.files.map(({ name }) => name)).toEqual([
      "0.jpg",
      "1.jpg",
      "2.jpg",
      "3.jpg",
    ]);
    expect(kept?.left).toBe(2);
  });

  it("goes by what a part of a post takes, which the service worker cannot load", () => {
    expect(maxSharedFiles).toBe(maxImagesPerPart);
    expect(maxSharedFileBytes).toBe(maxImageBytes);
  });

  it("deletes what earlier shares left behind when one comes", async () => {
    const { store, shareTools } = tools(keptShareMs + 5000);
    await store.put({ id: "old", at: 4000, files: [], left: 0 });
    await store.put({ id: "recent", at: 6000, files: [], left: 0 });
    await receiveShare(
      share({ [sharedFilesField]: image("new.jpg") }),
      origin,
      shareTools,
    );
    expect(store.all().map(({ id }) => id)).toEqual(["recent", "share-1"]);
  });

  it("makes a share of nothing of a form that is none", async () => {
    const { store, shareTools } = tools();
    const answer = await receiveShare(
      new Request(`${origin}/share`, { method: "POST", body: "text=x" }),
      origin,
      shareTools,
    );
    expect(await whereTo(answer)).toBe("/share");
    expect(store.all()).toEqual([]);
  });

  it("sends the text on where the device has no room for the files", async () => {
    const { store, shareTools } = tools();
    store.put = async () => {
      throw new DOMException("No room", "QuotaExceededError");
    };
    const answer = await receiveShare(
      share({ text: "Hello", [sharedFilesField]: image("a.jpg") }),
      origin,
      shareTools,
    );
    expect(await whereTo(answer)).toBe("/share?text=Hello");
  });
});
