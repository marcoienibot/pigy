/**
 * Image files for tests, made byte by byte, for every package: an entry
 * point of its own, `@pigy/core/test-images`, which nothing but tests
 * imports. They are small, and laid out as their
 * types lay a file out. The PNG is a real one, which a decoder draws. The
 * others have a header and data that no decoder would take: they are for
 * code that reads the layout of a file and not its picture.
 */

const text = (value: string) =>
  Uint8Array.from(value, (character) => character.charCodeAt(0));

export function joined(...pieces: (Uint8Array | number[])[]): Uint8Array {
  const arrays = pieces.map((piece) =>
    piece instanceof Uint8Array ? piece : Uint8Array.from(piece),
  );
  const whole = new Uint8Array(
    arrays.reduce((length, piece) => length + piece.length, 0),
  );
  let at = 0;
  for (const piece of arrays) {
    whole.set(piece, at);
    at += piece.length;
  }
  return whole;
}

const u16be = (value: number) => [value >> 8, value & 0xff];
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u32le = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];

/** A segment of a JPEG: its marker, its length and `payload`. */
export const jpegSegment = (marker: number, payload: Uint8Array | number[]) =>
  joined([0xff, marker], u16be(payload.length + 2), payload);

/** The Exif payload of a JPEG that says the way up, and a place. */
export function exifPayload(orientation: number): Uint8Array {
  return joined(
    text("Exif\0\0"),
    // Little-endian TIFF with two entries: the way up, and a tag that
    // stands for where the picture was taken.
    text("II"),
    u16le(42),
    u32le(8),
    u16le(2),
    [...u16le(0x0112), ...u16le(3), ...u32le(1), ...u16le(orientation), 0, 0],
    [...u16le(0x8825), ...u16le(4), ...u32le(1), ...u32le(38)],
    u32le(0),
    text("GPS: 45.4642 N, 9.1900 E"),
  );
}

/** The frame header of a JPEG of this size. */
export const jpegFrame = (width: number, height: number, marker = 0xc0) =>
  jpegSegment(marker, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]);

/** The compressed data of a scan, with every kind of 0xFF in it. */
export const jpegScanData = Uint8Array.of(
  ...[0x12, 0xff, 0x00, 0x34],
  // A restart marker, and fill bytes before one.
  ...[0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78],
);

export const jpegStart = Uint8Array.of(0xff, 0xd8);
export const jpegEnd = Uint8Array.of(0xff, 0xd9);
export const jfif = jpegSegment(
  0xe0,
  joined(text("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0]),
);
export const jpegScanHeader = jpegSegment(0xda, [1, 1, 0, 0, 63, 0]);
export const jpegTable = jpegSegment(0xdb, new Uint8Array(65));

/**
 * A JPEG of this size as a camera writes one: with Exif that says the way
 * up and a place, with XMP, a comment, an ICC profile, and `after` behind
 * its end.
 */
export function jpegFile(
  width: number,
  height: number,
  { orientation = 1, after = new Uint8Array(0) } = {},
): Uint8Array {
  return joined(
    jpegStart,
    jfif,
    jpegSegment(0xe1, exifPayload(orientation)),
    jpegSegment(0xe1, text("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>")),
    jpegSegment(0xe2, joined(text("ICC_PROFILE\0"), [1, 1, 9, 9])),
    jpegSegment(0xfe, text("made at home")),
    jpegTable,
    jpegFrame(width, height),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
    after,
  );
}

/** What pigy keeps of `jpegFile`. */
export function cleanJpegFile(
  width: number,
  height: number,
  orientation = 1,
): Uint8Array {
  return joined(
    jpegStart,
    jfif,
    orientation === 1
      ? []
      : jpegSegment(0xe1, [
          ...text("Exif\0\0"),
          ...text("MM"),
          ...[0, 42, 0, 0, 0, 8, 0, 1],
          ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
          ...[0, 0, 0, 0],
        ]),
    jpegSegment(0xe2, joined(text("ICC_PROFILE\0"), [1, 1, 9, 9])),
    jpegTable,
    jpegFrame(width, height),
    jpegScanHeader,
    jpegScanData,
    jpegEnd,
  );
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A chunk of a PNG, with its checksum. */
export function pngChunk(
  type: string,
  data: Uint8Array | number[],
): Uint8Array {
  const body = joined(text(type), data);
  return joined(u32be(data.length), body, u32be(crc32(body)));
}

export const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

async function deflated(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The header chunk of a PNG of this size: eight bits of red, green, blue. */
export const pngHeader = (width: number, height: number) =>
  pngChunk("IHDR", [...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]);

/**
 * A PNG of this size that a decoder draws, in one colour, or in noise with
 * `noise`, which does not compress: a way to a file of a size. `extra`
 * are chunks that go before the data.
 */
export async function pngFile(
  width: number,
  height: number,
  {
    color = [200, 60, 60],
    noise = false,
    extra = [] as Uint8Array[],
    after = new Uint8Array(0),
  } = {},
): Promise<Uint8Array> {
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  // Noise that is the same in every run.
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        // xorshift32: every step within 32 bits.
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        raw[y * row + 1 + x * 3 + channel] = noise
          ? seed & 0xff
          : (color[channel] as number);
      }
    }
  }
  return joined(
    pngSignature,
    pngHeader(width, height),
    ...extra,
    pngChunk("IDAT", await deflated(raw)),
    pngChunk("IEND", []),
    after,
  );
}

/** A text chunk of a PNG. */
export const pngText = (keyword: string, value: string) =>
  pngChunk("tEXt", text(`${keyword}\0${value}`));

const gifBlocks = (data: Uint8Array | number[]) => [data.length, ...data, 0];

/** A GIF of this size with so many frames, a comment and XMP. */
export function gifFile(
  width: number,
  height: number,
  { frames = 1, after = new Uint8Array(0), clean = false } = {},
): Uint8Array {
  const frame = joined(
    // How long the frame is shown.
    [0x21, 0xf9, ...gifBlocks([0, 10, 0, 0])],
    [0x2c, 0, 0, 0, 0, ...u16le(width), ...u16le(height), 0],
    [2, ...gifBlocks([0x4c, 0x01])],
  );
  return joined(
    text("GIF89a"),
    [...u16le(width), ...u16le(height), 0x80, 0, 0],
    // A colour table of two colours.
    [0, 0, 0, 255, 255, 255],
    [0x21, 0xff, 11, ...text("NETSCAPE2.0"), ...gifBlocks([1, 0, 0])],
    clean ? [] : [0x21, 0xfe, ...gifBlocks(text("made at home"))],
    clean
      ? []
      : [0x21, 0xff, 11, ...text("XMP DataXMP"), ...gifBlocks(text("<x/>"))],
    ...Array.from({ length: frames }, () => frame),
    [0x3b],
    clean ? [] : after,
  );
}

const webpChunk = (type: string, data: Uint8Array | number[]) =>
  joined(text(type), u32le(data.length), data, data.length % 2 ? [0] : []);

const riff = (...chunks: Uint8Array[]) => {
  const body = joined(text("WEBP"), ...chunks);
  return joined(text("RIFF"), u32le(body.length), body);
};

/** A lossy WebP of this size, with nothing besides its picture. */
export const simpleWebpFile = (width: number, height: number) =>
  riff(
    webpChunk("VP8 ", [
      ...[0, 0, 0, 0x9d, 0x01, 0x2a],
      ...u16le(width),
      ...u16le(height),
      ...[1, 2, 3],
    ]),
  );

/** A lossless WebP of this size. */
export const losslessWebpFile = (width: number, height: number) =>
  riff(
    webpChunk("VP8L", [
      0x2f,
      ...u32le((width - 1) | ((height - 1) << 14)),
      ...[1, 2],
    ]),
  );

/**
 * A WebP of this size in the extended layout, with Exif and XMP, or
 * without and saying so with `clean`: what pigy keeps of the first.
 */
export function webpFile(
  width: number,
  height: number,
  { clean = false, animated = false, after = new Uint8Array(0) } = {},
): Uint8Array {
  const u24le = (value: number) => u32le(value).slice(0, 3);
  // The flags: Exif, XMP, an animation.
  const flags = (clean ? 0 : 0x0c) | (animated ? 0x02 : 0);
  const file = riff(
    webpChunk("VP8X", [
      flags,
      0,
      0,
      0,
      ...u24le(width - 1),
      ...u24le(height - 1),
    ]),
    webpChunk("VP8L", [0x2f, ...u32le((width - 1) | ((height - 1) << 14)), 7]),
    ...(clean
      ? []
      : [
          webpChunk("EXIF", text("GPS: 45.4642 N, 9.1900 E")),
          webpChunk("XMP ", text("<x:xmpmeta/>")),
        ]),
  );
  return clean ? file : joined(file, after);
}

/** `bytes` as a stream that hands out `size` bytes at a time. */
export async function* inPieces(
  bytes: Uint8Array,
  size = bytes.length || 1,
): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.subarray(at, at + size);
  }
}
