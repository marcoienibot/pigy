import { expect, test } from "vitest";
import {
  cleanImage,
  type ImageFacts,
  ImageRefused,
  maxImageBytes,
  scanImage,
} from "./image.ts";
import {
  cleanJpegFile,
  gifFile,
  inPieces,
  jfif,
  joined,
  jpegEnd,
  jpegFile,
  jpegFrame,
  jpegScanData,
  jpegScanHeader,
  jpegSegment,
  jpegStart,
  losslessWebpFile,
  pngChunk,
  pngFile,
  pngHeader,
  pngSignature,
  pngText,
  simpleWebpFile,
  webpFile,
} from "./test-images.ts";

const text = (value: string) => new TextEncoder().encode(value);

/** What pigy keeps of `file`, read `size` bytes at a time. */
async function copyOf(
  file: Uint8Array,
  size?: number,
): Promise<{ facts: ImageFacts; copy: Uint8Array }> {
  const facts = await scanImage(inPieces(file, size));
  const pieces: Uint8Array[] = [];
  await cleanImage(inPieces(file, size), facts, (piece) => {
    // A piece is a view of what the walk holds, which it lets go of.
    pieces.push(piece.slice());
  });
  return { facts, copy: joined(...pieces) };
}

async function refusal(file: Uint8Array): Promise<string> {
  try {
    await scanImage(inPieces(file));
  } catch (error) {
    if (error instanceof ImageRefused) return error.code;
    throw error;
  }
  return "taken";
}

const script = text("<script>alert(1)</script>");

test("a JPEG is known by its bytes, and its copy has the picture and nothing of the camera", async () => {
  const { facts, copy } = await copyOf(jpegFile(40, 30, { after: script }));
  expect(facts).toEqual({
    type: "image/jpeg",
    width: 40,
    height: 30,
    animated: false,
    size: copy.length,
  });
  // No Exif, no XMP, no comment, and nothing behind the end. The ICC
  // profile and the data of the scan, with its restart markers and fill
  // bytes, are there byte for byte.
  expect(copy).toEqual(cleanJpegFile(40, 30));
  const read = new TextDecoder("latin1").decode(copy);
  expect(read).not.toContain("GPS");
  expect(read).not.toContain("script");
});

test("a JPEG that lies on its side is as wide as it is shown, and its copy still says which way is up", async () => {
  const { facts, copy } = await copyOf(jpegFile(40, 30, { orientation: 6 }));
  expect(facts).toMatchObject({ width: 30, height: 40 });
  expect(copy).toEqual(cleanJpegFile(40, 30, 6));
  // The copy is read as the original is: the way up was not lost.
  expect(await scanImage(inPieces(copy))).toMatchObject({
    width: 30,
    height: 40,
    size: copy.length,
  });
});

test("an image reads the same however the stream is cut", async () => {
  // One byte at a time puts every boundary between two pieces once: in
  // the middle of a marker, between a 0xFF of the data and the byte that
  // says what it is, inside a length.
  for (const file of [
    jpegFile(40, 30, { orientation: 8, after: script }),
    await pngFile(3, 2, { extra: [pngText("Comment", "at home")] }),
    gifFile(9, 7, { frames: 2, after: script }),
    webpFile(12, 5, { after: script }),
  ]) {
    const whole = await copyOf(file);
    for (const size of [1, 2, 3, 7]) {
      expect(await copyOf(file, size)).toEqual(whole);
    }
  }
});

test("a progressive JPEG has several scans, and all of them are in the copy", async () => {
  const file = joined(
    jpegStart,
    jfif,
    jpegFrame(8, 8, 0xc2),
    jpegScanHeader,
    jpegScanData,
    // A table between two scans.
    jpegSegment(0xc4, [0, 1, 2]),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
  );
  const { facts, copy } = await copyOf(file);
  expect(facts).toMatchObject({ width: 8, height: 8 });
  expect(copy).toEqual(file);
});

test("a PNG keeps the chunks that draw it and loses its texts", async () => {
  const kept = pngChunk("gAMA", [0, 0, 0xb1, 0x8f]);
  const file = await pngFile(3, 2, {
    extra: [
      kept,
      pngText("Location", "45.4642 N"),
      pngChunk("eXIf", text("II*\0")),
      pngChunk("tIME", [7, 234, 1, 1, 0, 0, 0]),
    ],
    after: script,
  });
  const { facts, copy } = await copyOf(file);
  expect(facts).toEqual({
    type: "image/png",
    width: 3,
    height: 2,
    animated: false,
    size: copy.length,
  });
  expect(copy).toEqual(await pngFile(3, 2, { extra: [kept] }));
});

test("a GIF says whether it moves, and loses its comment and its XMP", async () => {
  const still = await copyOf(gifFile(9, 7, { after: script }));
  expect(still.facts).toMatchObject({
    type: "image/gif",
    width: 9,
    height: 7,
    animated: false,
  });
  expect(still.copy).toEqual(gifFile(9, 7, { clean: true }));
  const moving = await copyOf(gifFile(9, 7, { frames: 3 }));
  expect(moving.facts.animated).toBe(true);
  // How often it repeats is kept: it is part of how the picture is shown.
  expect(moving.copy).toEqual(gifFile(9, 7, { frames: 3, clean: true }));
});

test("a WebP of each layout says its size", async () => {
  expect(await scanImage(inPieces(simpleWebpFile(640, 480)))).toMatchObject({
    type: "image/webp",
    width: 640,
    height: 480,
  });
  expect(await scanImage(inPieces(losslessWebpFile(641, 479)))).toMatchObject({
    width: 641,
    height: 479,
  });
  expect(
    await scanImage(inPieces(webpFile(70_000, 3, { animated: true }))),
  ).toMatchObject({ width: 70_000, height: 3, animated: true });
});

test("a WebP loses its Exif and its XMP, and its header says the length and that they are gone", async () => {
  const { copy } = await copyOf(webpFile(12, 5, { after: script }));
  expect(copy).toEqual(webpFile(12, 5, { clean: true }));
});

test.each([
  ["a script with the name of an image", text("<script>alert(1)</script>    ")],
  ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ["a file of a few bytes", Uint8Array.of(0xff, 0xd8, 0xff)],
  ["nothing", new Uint8Array(0)],
  ["a RIFF file that is no WebP", text("RIFF\x10\0\0\0WAVEfmt ")],
])("%s is not an image", async (_, file) => {
  expect(await refusal(file)).toBe("not_an_image");
});

test("a file that begins as an image and is not laid out as one is refused", async () => {
  // Cut off in its data.
  expect(await refusal(jpegFile(4, 4).subarray(0, 120))).toBe("damaged");
  // No frame header: nothing says how large the picture is.
  expect(
    await refusal(
      joined(jpegStart, jfif, jpegScanHeader, jpegScanData, jpegEnd),
    ),
  ).toBe("damaged");
  // A PNG whose first chunk is not its header.
  expect(
    await refusal(joined(pngSignature, pngText("a", "b"), pngHeader(1, 1))),
  ).toBe("damaged");
  // A PNG without data.
  expect(
    await refusal(joined(pngSignature, pngHeader(1, 1), pngChunk("IEND", []))),
  ).toBe("damaged");
  expect(await refusal(gifFile(0, 7))).toBe("damaged");
});

test("a small file that claims a huge picture is refused by what its header says", async () => {
  // The decompression bomb: 60000 by 60000 pixels in a few bytes.
  expect(
    await refusal(
      joined(
        pngSignature,
        pngHeader(60_000, 60_000),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0, 0, 0, 0, 1]),
        pngChunk("IEND", []),
      ),
    ),
  ).toBe("too_many_pixels");
  expect(await refusal(jpegFile(65_000, 65_000))).toBe("too_many_pixels");
  expect(await refusal(gifFile(60_000, 60_000))).toBe("too_many_pixels");
  // Within the limit, the same layout is taken.
  expect(await refusal(jpegFile(8000, 8000))).toBe("taken");
});

test("a file that is longer than pigy takes is refused while it is read", async () => {
  // A PNG whose chunk says that it goes on beyond the limit: the walk
  // stops at the limit and not at the end of what it is fed.
  async function* endless() {
    yield joined(
      pngSignature,
      pngHeader(1, 1),
      [0x7f, 0xff, 0xff, 0xff],
      text("IDAT"),
    );
    const piece = new Uint8Array(1024 * 1024);
    for (
      let sent = 0;
      sent < maxImageBytes + piece.length * 2;
      sent += piece.length
    ) {
      yield piece;
    }
    throw new Error("The walk read past its limit");
  }
  await expect(scanImage(endless())).rejects.toMatchObject({
    code: "too_large",
  });
});

test("a copy is refused for a file that is not the one that was scanned", async () => {
  const facts = await scanImage(inPieces(jpegFile(40, 30)));
  await expect(
    cleanImage(inPieces(jpegFile(40, 30, { orientation: 6 })), facts, () => {}),
  ).rejects.toThrow("changed");
});
