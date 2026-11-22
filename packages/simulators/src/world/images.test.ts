import {
  gifFile,
  jpegFile,
  losslessWebpFile,
  pngFile,
  simpleWebpFile,
  webpFile,
} from "@pigy/core/test-images";
import { expect, test } from "vitest";
import { createBlobs, hasExif, imageInfo, maxBlobBytes } from "./images.ts";
import { memoryStorage } from "./storage.ts";

test("an image is known by its bytes", async () => {
  expect(imageInfo(await pngFile(40, 30))).toEqual({
    type: "image/png",
    width: 40,
    height: 30,
  });
  expect(imageInfo(jpegFile(50, 20))).toEqual({
    type: "image/jpeg",
    width: 50,
    height: 20,
  });
  expect(imageInfo(gifFile(9, 7))).toEqual({
    type: "image/gif",
    width: 9,
    height: 7,
  });
  for (const webp of [
    simpleWebpFile(64, 48),
    losslessWebpFile(64, 48),
    webpFile(64, 48),
  ]) {
    expect(imageInfo(webp)).toEqual({
      type: "image/webp",
      width: 64,
      height: 48,
    });
  }
});

test("what is no image is none, whatever it is called", () => {
  for (const file of [
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "<script>alert(1)</script>",
    "",
    "RIFF\0\0\0\0WAVEfmt                  ",
  ]) {
    expect(imageInfo(new TextEncoder().encode(file))).toBeNull();
  }
});

test("Exif is seen where a camera wrote it", () => {
  expect(hasExif(jpegFile(4, 4))).toBe(true);
  expect(hasExif(webpFile(4, 4))).toBe(true);
  expect(hasExif(webpFile(4, 4, { clean: true }))).toBe(false);
});

test("a world keeps the bytes of its images, the latest of them within a limit", () => {
  let number = 0;
  const blobs = createBlobs(memoryStorage(), () => ++number);
  // Larger than one value of the storage holds, and not a multiple of it.
  const large = new Uint8Array(1_300_000).map((_, index) => index % 251);
  const first = blobs.put(large);
  expect(blobs.get(first)).toEqual(large);
  expect(blobs.get("blob999")).toBeUndefined();

  // Enough of them to go over the limit: the oldest go, the latest stay.
  const piece = new Uint8Array(8 * 1024 * 1024);
  const ids = Array.from({ length: maxBlobBytes / piece.length }, () =>
    blobs.put(piece),
  );
  expect(blobs.get(first)).toBeUndefined();
  expect(blobs.get(ids.at(-1) ?? "")?.length).toBe(piece.length);
  expect(blobs.get(ids[0] ?? "")?.length).toBe(piece.length);
  blobs.put(piece);
  expect(blobs.get(ids[0] ?? "")).toBeUndefined();
});
