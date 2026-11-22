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
  exifPayload,
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
  jpegTable,
  losslessWebpFile,
  pngChunk,
  pngFile,
  pngHeader,
  pngSignature,
  pngText,
  simpleWebpFile,
  webpChunk,
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

/** The bytes of `values`, each of them a byte or text. */
const bytes = (...values: (number[] | string)[]) =>
  joined(
    ...values.map((value) => (typeof value === "string" ? text(value) : value)),
  );

/**
 * A stream of `file` that fails the test if it is read beyond it: the walk
 * stops at what the file says of itself, and not at its end.
 */
async function* readTo(file: Uint8Array): AsyncGenerator<Uint8Array> {
  yield file;
  throw new Error("The walk read past what the file says");
}

test.each([
  // RIFF that says it goes on for 4 GiB, and a VP8X chunk that says the
  // same: the twenty bytes and nothing behind them.
  [
    "a WebP of 20 bytes",
    bytes(
      "RIFF",
      [0xff, 0xff, 0xff, 0xff],
      "WEBP",
      "VP8X",
      [0xf0, 0xff, 0xff, 0xff],
    ),
  ],
  // The same with the twenty bytes of a header after it.
  [
    "a WebP of 40 bytes",
    bytes(
      "RIFF",
      [0xff, 0xff, 0xff, 0xff],
      "WEBP",
      "VP8X",
      [0xf0, 0xff, 0xff, 0xff],
      new Array(20).fill(0),
    ),
  ],
  // A chunk of a PNG whose length is beyond what pigy takes.
  [
    "a PNG chunk of 2 GiB",
    joined(
      pngSignature,
      pngHeader(1, 1),
      [0x7f, 0xff, 0xff, 0xff],
      text("tEXt"),
    ),
  ],
])(
  "%s that says it is longer than pigy takes is refused before anything is read for it",
  async (_, file) => {
    // Before, the walk made room for what the chunk said before it read it:
    // 4 GiB, which ends the isolate of a Worker and stops a tab.
    await expect(scanImage(readTo(file))).rejects.toMatchObject({
      code: "too_large",
    });
  },
);

test("a WebP whose RIFF header lies about its length is refused, either way", async () => {
  const file = webpFile(12, 5, { clean: true });
  const saying = (length: number) => {
    const lying = file.slice();
    new DataView(lying.buffer).setUint32(4, length, true);
    return lying;
  };
  // Longer than the file: it ends before what it said.
  expect(await refusal(saying(file.length + 100))).toBe("damaged");
  // Shorter than its chunks: a chunk goes on beyond it.
  expect(await refusal(saying(20))).toBe("damaged");
  // What it is: taken.
  expect(await refusal(saying(file.length - 8))).toBe("taken");
});

test("a WebP whose header chunk is longer than its fields is refused", async () => {
  // VP8X has ten bytes. Whatever follows them in the chunk would be
  // copied as part of the header.
  const file = bytes(
    "RIFF",
    [38, 0, 0, 0],
    "WEBPVP8X",
    [20, 0, 0, 0],
    new Array(10).fill(0),
    "GPS:51.5N!",
    "VP8L",
    [5, 0, 0, 0],
    [0x2f, 0, 0, 0, 0],
    [0],
  );
  expect(await refusal(file)).toBe("damaged");
});

test("a JPEG keeps of its segments only the ones that a decoder draws with, and of those only their fields", async () => {
  const thumbnailed = jpegSegment(
    0xe0,
    // JFIF with a thumbnail of one pixel: the picture before it was cut.
    bytes("JFIF\0", [1, 2, 0, 0, 1, 0, 1, 1, 1], "RGB"),
  );
  const file = joined(
    jpegStart,
    thumbnailed,
    // A thumbnail of the extension of JFIF: a whole JPEG, with a place.
    jpegSegment(0xe0, joined(text("JFXX\0"), [0x10], jpegFile(4, 4))),
    // Adobe's colour transform, with more than its fields behind it.
    jpegSegment(0xee, bytes("Adobe", [0, 100, 0, 0, 0, 0, 1], "SECRET-GPS")),
    // An APP14 that is not Adobe's, and markers that name nothing that
    // a decoder reads.
    jpegSegment(0xee, text("SECRET-GPS 51.5N")),
    jpegSegment(0xf0, text("<html><script>alert(1)</script>")),
    jpegSegment(0x80, text("<html>")),
    jpegSegment(0xe2, text("FPXR\0<html>")),
    jpegTable,
    jpegSegment(0xdd, [0, 4]),
    jpegFrame(8, 8),
    // The number of lines, which only a frame of no height needs.
    jpegSegment(0xdc, [0, 8]),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
  );
  const { copy } = await copyOf(file);
  expect(copy).toEqual(
    joined(
      jpegStart,
      // Without its thumbnail, and saying that it has none.
      jpegSegment(0xe0, bytes("JFIF\0", [1, 2, 0, 0, 1, 0, 1, 0, 0])),
      jpegSegment(0xee, bytes("Adobe", [0, 100, 0, 0, 0, 0, 1])),
      jpegTable,
      jpegSegment(0xdd, [0, 4]),
      jpegFrame(8, 8),
      jpegScanHeader,
      jpegScanData,
      jpegEnd,
    ),
  );
});

test("a JPEG goes by its first Exif segment, as decoders do, and its copy has that one alone", async () => {
  const file = joined(
    jpegStart,
    jpegSegment(0xe1, exifPayload(6)),
    jpegSegment(0xe1, exifPayload(3)),
    jpegFrame(40, 30),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
  );
  const { facts, copy } = await copyOf(file);
  // On its side, as the first says. Before, the facts went by the last
  // and the copy had both, which a decoder reads the other way.
  expect(facts).toMatchObject({ width: 30, height: 40 });
  expect(copy).toEqual(
    joined(
      jpegStart,
      cleanJpegFile(40, 30, 6).subarray(2 + jfif.length, 2 + jfif.length + 36),
      jpegFrame(40, 30),
      jpegScanHeader,
      jpegScanData,
      jpegEnd,
    ),
  );
});

test("a JPEG keeps its colour profile, JFIF and Adobe's colour transform only before its first scan, where decoders read them", async () => {
  const profile = jpegSegment(0xe2, bytes("ICC_PROFILE\0", [1, 1], "COLOURS"));
  const file = joined(
    jpegStart,
    profile,
    jpegFrame(8, 8),
    jpegScanHeader,
    jpegScanData,
    // After the scan: no decoder reads them there, and each is laid out
    // as one, with words in the part of the profile.
    jpegSegment(0xe2, bytes("ICC_PROFILE\0", [1, 1], "AT HOME")),
    jpegSegment(0xee, bytes("Adobe", [0, 100, 0, 0, 0, 0, 1])),
    jpegSegment(0xe0, bytes("JFIF\0", [1, 2, 0, 0, 1, 0, 1, 0, 0])),
    jpegEnd,
  );
  const { copy } = await copyOf(file);
  // Before, all three were kept.
  expect(copy).toEqual(
    joined(
      jpegStart,
      profile,
      jpegFrame(8, 8),
      jpegScanHeader,
      jpegScanData,
      jpegEnd,
    ),
  );
});

/** A PNG of 3 by 2 pixels with `before` before its data and `after` after it. */
async function pngWith(before: Uint8Array[], after: Uint8Array[] = []) {
  const plain = await pngFile(3, 2);
  return joined(
    plain.subarray(0, 33),
    ...before,
    // The data, without the end.
    plain.subarray(33, plain.length - 12),
    ...after,
    pngChunk("IEND", []),
  );
}

test("a PNG keeps of a chunk its fields alone: one that is longer or shorter than they are is left out, as decoders leave it, and its end has nothing in it", async () => {
  const gamma = pngChunk("gAMA", [0, 0, 0xb1, 0x8f]);
  const pixels = pngChunk("pHYs", [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]);
  const file = await pngWith([
    // Words behind the fields: a decoder that went by the length would
    // read none of them, and the copy had them all.
    pngChunk("gAMA", bytes([0, 0, 0xb1, 0x8f], "GPS 45.4642 N")),
    pngChunk("sRGB", bytes([0], "AT HOME")),
    pngChunk("pHYs", bytes([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1], "AT HOME")),
    // Shorter than its fields.
    pngChunk("cHRM", [1, 2, 3]),
    // The first of each kind that is laid out as one is the one that
    // decoders read.
    gamma,
    pixels,
  ]);
  // Words in the end, which has none.
  const ended = joined(
    file.subarray(0, file.length - 12),
    pngChunk("IEND", text("AT HOME")),
  );
  const { facts, copy } = await copyOf(ended);
  expect(new TextDecoder("latin1").decode(copy)).not.toMatch(/HOME|GPS/);
  expect(copy).toEqual(await pngWith([gamma, pixels]));
  expect(facts.size).toBe(copy.length);
});

test("a PNG keeps the first chunk of each kind, and only where decoders read it", async () => {
  const gamma = pngChunk("gAMA", [0, 0, 0xb1, 0x8f]);
  // A palette that a picture of red, green and blue may suggest.
  const palette = pngChunk("PLTE", [0, 0, 0, 255, 255, 255]);
  const background = pngChunk("bKGD", [0, 1, 0, 1, 0, 1]);
  const { copy } = await copyOf(
    await pngWith(
      [
        gamma,
        // A second of a kind, which decoders pass over.
        pngChunk("gAMA", text("HOME")),
        palette,
        pngChunk("PLTE", text("AT HOME!!")),
        // What has to come before the palette, after it.
        pngChunk("sRGB", [0]),
        background,
        // What a picture of grey has, in one of red, green and blue.
        pngChunk("tRNS", text("HO")),
      ],
      // After the data, where decoders read nothing but frames.
      [pngChunk("pHYs", [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])],
    ),
  );
  expect(copy).toEqual(await pngWith([gamma, palette, background]));
});

test("a PNG keeps a colour profile only as one is laid out, and frames only after the chunk that says that it moves", async () => {
  const profile = pngChunk("iCCP", bytes("ICC", [0, 0], [0x78, 0x9c, 3, 0]));
  const frame = pngChunk("fcTL", [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3,
    0,
    0,
    0,
    2,
    ...new Array(8).fill(0),
    0,
    1,
    0,
    10,
    0,
    0,
  ]);
  const frameData = pngChunk("fdAT", [0, 0, 0, 1, 0x78, 0x9c, 3, 0]);
  const moving = pngChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]);
  // A profile without a name, and one whose name does not end.
  const withProfiles = await pngWith([
    pngChunk("iCCP", bytes([0, 0], "AT HOME")),
    pngChunk("iCCP", text("AT HOME".repeat(20))),
    profile,
  ]);
  expect((await copyOf(withProfiles)).copy).toEqual(await pngWith([profile]));

  // Frames after a chunk that is not laid out as the one that says that
  // the picture moves: no decoder shows them, and the copy is still.
  const notMoving = await copyOf(
    await pngWith(
      [pngChunk("acTL", bytes([0, 0, 0, 2, 0, 0, 0, 0], "AT HOME")), frame],
      [frameData],
    ),
  );
  expect(notMoving.facts.animated).toBe(false);
  expect(notMoving.copy).toEqual(await pngWith([]));
  const animation = await pngWith([moving, frame], [frameData]);
  const kept = await copyOf(animation);
  expect(kept.facts.animated).toBe(true);
  expect(kept.copy).toEqual(animation);
});

test("a GIF keeps of its extensions only what is drawn: no text, and nothing behind the fields of a control or of how often it repeats", async () => {
  const blocks = (...data: number[][]) =>
    joined(...data.map((block) => [block.length, ...block]), [0]);
  const file = joined(
    text("GIF89a"),
    [1, 0, 1, 0, 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    // How often it repeats, and a block of words behind it.
    [0x21, 0xff],
    blocks([...text("NETSCAPE2.0")], [1, 0, 0], [...text("AT HOME")]),
    // An application whose name has not eleven letters.
    [0x21, 0xff],
    blocks([...text("XMP")], [...text("AT HOME")]),
    // Text that is drawn, which no browser draws.
    [0x21, 0x01],
    blocks([0, 0, 0, 0, 1, 0, 1, 0, 8, 8, 0, 0], [...text("HOME ADDRESS")]),
    // The control of a frame, and words behind it.
    [0x21, 0xf9],
    blocks([0, 10, 0, 0], [...text("AT HOME")]),
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0],
    [2],
    blocks([0x4c, 0x01]),
    [0x3b],
  );
  const { facts, copy } = await copyOf(file);
  expect(facts).toMatchObject({ width: 1, height: 1, animated: false });
  expect(new TextDecoder("latin1").decode(copy)).not.toMatch(/HOME|XMP/);
  expect(copy).toEqual(
    joined(
      text("GIF89a"),
      [1, 0, 1, 0, 0x80, 0, 0],
      [0, 0, 0, 255, 255, 255],
      [0x21, 0xff],
      blocks([...text("NETSCAPE2.0")], [1, 0, 0]),
      [0x21, 0xf9],
      blocks([0, 10, 0, 0]),
      [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0],
      [2],
      blocks([0x4c, 0x01]),
      [0x3b],
    ),
  );
});

test.each([
  [
    // The screen of one pixel, and a frame of 65535 by 65535 in it.
    "a GIF frame larger than its screen",
    joined(
      text("GIF89a"),
      [1, 0, 1, 0, 0, 0, 0],
      [0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0],
      [2, 2, 0x4c, 0x01, 0],
      [0x3b],
    ),
  ],
  [
    "a GIF frame beside its screen",
    joined(
      text("GIF89a"),
      [8, 0, 8, 0, 0, 0, 0],
      [0x2c, 7, 0, 0, 0, 2, 0, 1, 0, 0],
      [2, 2, 0x4c, 0x01, 0],
      [0x3b],
    ),
  ],
  [
    "an APNG frame larger than its picture",
    joined(
      pngSignature,
      pngHeader(1, 1),
      pngChunk("acTL", [0, 0, 0, 1, 0, 0, 0, 0]),
      pngChunk("fcTL", [
        ...[0, 0, 0, 0],
        ...[0, 0, 0xff, 0xff],
        ...[0, 0, 0xff, 0xff],
        ...[0, 0, 0, 0, 0, 0, 0, 0],
        ...[0, 1, 0, 10, 0, 0],
      ]),
      pngChunk("IDAT", [0x78, 0x9c, 0x03, 0, 0, 0, 0, 1]),
      pngChunk("IEND", []),
    ),
  ],
  [
    "a still WebP whose picture is larger than its header says",
    webpFile(1, 1, { clean: true, picture: [16_000, 16_000] }),
  ],
  [
    "a WebP frame larger than its picture",
    webpFile(4, 4, { clean: true, animated: true, frame: [8, 8] }),
  ],
  [
    "a WebP frame whose picture is larger than the frame",
    webpFile(4, 4, {
      clean: true,
      animated: true,
      frame: [2, 2],
      picture: [16_000, 16_000],
    }),
  ],
  [
    "a WebP frame with a chunk that is not its picture",
    webpFile(4, 4, {
      clean: true,
      animated: true,
      inFrame: webpChunk("XXXX", text("SECRET!!")),
    }),
  ],
  [
    "a WebP that moves and has no frame",
    webpFile(4, 4, { clean: true, animated: true, frames: 0 }),
  ],
])(
  "%s is refused: what decodes it would be another picture than the one that pigy read",
  async (_, file) => {
    expect(await refusal(file)).toBe("damaged");
  },
);

/** A WebP of `chunks`, with the header of the extended layout first. */
const extendedWebp = (flags: number, ...chunks: Uint8Array[]) => {
  const body = joined(
    text("WEBP"),
    // 3 by 2 pixels.
    webpChunk("VP8X", [flags, 0, 0, 0, 2, 0, 0, 1, 0, 0]),
    ...chunks,
  );
  const length = body.length;
  return joined(
    text("RIFF"),
    [length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff, length >>> 24],
    body,
  );
};
const lossy = webpChunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 3, 0, 2, 0, 1, 2]);
const lossless = webpChunk("VP8L", [0x2f, 2, 0x40, 0, 0, 7]);
const alpha = (what: string) => webpChunk("ALPH", text(what));
/** A frame of an animation of 3 by 2 pixels that holds `chunks`. */
const webpFrame = (...chunks: Uint8Array[]) =>
  webpChunk(
    "ANMF",
    joined([0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 100, 0, 0, 0], ...chunks),
  );

test("a WebP keeps its alpha directly before its lossy picture", async () => {
  const still = extendedWebp(0x10, alpha("ALPHA"), lossy);
  expect((await copyOf(still)).copy).toEqual(still);
  // What stands between them is left out, as everything that a decoder
  // does not draw with.
  expect(
    (
      await copyOf(
        extendedWebp(
          0x10,
          alpha("ALPHA"),
          webpChunk("ZZZZ", text("AT HOME")),
          lossy,
        ),
      )
    ).copy,
  ).toEqual(still);
  const frames = extendedWebp(
    0x12,
    webpChunk("ANIM", [255, 255, 255, 255, 0, 0]),
    webpFrame(alpha("ALPHA"), lossy),
  );
  expect((await copyOf(frames)).copy).toEqual(frames);
});

test.each([
  // libwebp draws with the last, its demuxer stops at the second.
  ["two alphas", extendedWebp(0x10, alpha("ALPHA"), alpha("AT HOME"), lossy)],
  // A lossless picture has its alpha in itself.
  [
    "an alpha before a lossless picture",
    extendedWebp(0x10, alpha("AT HOME"), lossless),
  ],
  [
    "an alpha before a lossless picture in a frame",
    extendedWebp(
      0x12,
      webpChunk("ANIM", [255, 255, 255, 255, 0, 0]),
      webpFrame(alpha("AT HOME"), lossless),
    ),
  ],
])(
  "a WebP with %s is refused: decoders do not agree on what it is",
  async (_, file) => {
    expect(await refusal(file)).toBe("damaged");
  },
);

test("a WebP that moves keeps its frames, and of the chunk of its animation only the fields", async () => {
  const { facts, copy } = await copyOf(
    webpFile(12, 5, { animated: true, frames: 2, after: script }),
  );
  expect(facts).toMatchObject({
    type: "image/webp",
    width: 12,
    height: 5,
    animated: true,
  });
  expect(copy).toEqual(
    webpFile(12, 5, { animated: true, frames: 2, clean: true }),
  );
});

test("the copy is handed out in pieces of 64 KiB, however many segments the file has", async () => {
  // Twenty thousand tables of one byte each, which before were written
  // one by one: each a write to the bucket while an upload is completed.
  const tables = Array.from({ length: 20_000 }, () => jpegSegment(0xc4, [0]));
  const file = joined(
    jpegStart,
    jfif,
    ...tables,
    jpegFrame(8, 8),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
  );
  const facts = await scanImage(inPieces(file));
  const pieces: number[] = [];
  await cleanImage(inPieces(file, 7), facts, (piece) => {
    pieces.push(piece.length);
  });
  expect(pieces).toEqual([65_536, facts.size - 65_536]);
});

test("a file of more parts than an image has is refused, at once", async () => {
  // 20 MiB of segments of four bytes, each a segment that is passed over:
  // five million of them, which took the walk seconds to go through.
  const segment = [0xff, 0xe0, 0x00, 0x02];
  const count = Math.floor((maxImageBytes - 1024) / segment.length);
  const file = new Uint8Array(2 + count * segment.length);
  file.set(jpegStart);
  for (let at = 2; at < file.length; at += segment.length) {
    file.set(segment, at);
  }
  const started = performance.now();
  expect(await refusal(file)).toBe("damaged");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("data in blocks of one byte is no part of its own: a GIF of them is taken, and soon", async () => {
  // Encoders write blocks of 255 bytes, and nothing says that they must.
  // Four million blocks of one byte, read as fast as the bytes are.
  const count = 4_000_000;
  const data = new Uint8Array(count * 2);
  for (let at = 0; at < data.length; at += 2) data.set([1, 0], at);
  const file = joined(
    text("GIF89a"),
    [1, 0, 1, 0, 0, 0, 0],
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0],
    [2],
    data,
    [0, 0x3b],
  );
  const started = performance.now();
  const { facts } = await copyOf(file, 64 * 1024);
  expect(facts).toMatchObject({ width: 1, height: 1, size: file.length });
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a copy is refused for a file that is not the one that was scanned", async () => {
  const facts = await scanImage(inPieces(jpegFile(40, 30)));
  await expect(
    cleanImage(inPieces(jpegFile(40, 30, { orientation: 6 })), facts, () => {}),
  ).rejects.toThrow("changed");
});
