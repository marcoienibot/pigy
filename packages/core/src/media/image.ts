/**
 * What pigy takes for an image, found out by reading the bytes: the type by
 * how the file begins, the dimensions from its header, never from a name
 * or from what a client says. The same walk through a file makes the copy
 * that pigy keeps and publishes: the image without what it carries
 * besides the picture.
 *
 * Four types: JPEG, PNG, WebP and GIF. No SVG, which is a program.
 *
 * What the copy leaves out:
 *
 * - JPEG: Exif, where a camera writes the place and the time, XMP, IPTC,
 *   comments, and every application segment but the ones that a decoder
 *   draws with: JFIF, an ICC profile and Adobe's colour transform. The
 *   way up of the picture is in Exif too, so a copy whose picture is
 *   turned gets an Exif segment of pigy's own that says that and nothing
 *   else.
 * - PNG: every chunk but the ones that a decoder draws with. That takes
 *   the text chunks, the time and Exif.
 * - WebP: the Exif and XMP chunks, and chunks that the format does not
 *   name. A WebP whose way up is only in its Exif loses it: cameras do
 *   not write WebP.
 * - GIF: comments and the application extensions other than the one that
 *   says how often an animation repeats.
 * - Of every type: whatever follows the end of the image. A file that is
 *   an image and something else behind it is only the image afterwards.
 *
 * Nothing is decoded and nothing encoded again: the picture is the same
 * bytes. So nothing here says that a decoder will draw the file, only
 * that it is laid out as its type lays a file out.
 *
 * The walk is over a stream and holds a piece of it at a time, so a file
 * is never in memory as a whole.
 */

/** The types of image that pigy takes, as media types. */
export const imageTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type ImageType = (typeof imageTypes)[number];

/** The most bytes of an image that pigy takes: 20 MiB. */
export const maxImageBytes = 20 * 1024 * 1024;

/**
 * The most pixels of an image that pigy takes, width times height: 64
 * million. A file of a few kilobytes can claim a picture of any size, and
 * whoever decodes it pays for the pixels.
 */
export const maxImagePixels = 64_000_000;

/** What reading an image found. */
export type ImageFacts = {
  type: ImageType;
  /** As the picture is shown: a JPEG that says it lies on its side is turned. */
  width: number;
  height: number;
  /** More than one frame: a GIF, a PNG or a WebP that moves. */
  animated: boolean;
  /** How many bytes the copy has that pigy keeps. */
  size: number;
};

/** Why a file is not taken. */
export type ImageRefusal =
  /** It does not begin as any of the four types does. */
  | "not_an_image"
  /** It begins as an image and is not laid out as one. */
  | "damaged"
  | "too_many_pixels"
  | "too_large";

/** Thrown for a file that pigy does not take as an image. */
export class ImageRefused extends Error {
  constructor(
    readonly code: ImageRefusal,
    /** For people. */
    message: string,
  ) {
    super(message);
  }
}

const damaged = (what: string) =>
  new ImageRefused("damaged", `The file is not a complete image: ${what}.`);

/** The pieces of a stream, for `for await`, which not every browser has. */
export async function* chunksOf(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Whoever stops reading early lets go of the stream.
    await reader.cancel().catch(() => {});
  }
}

type Emit = (bytes: Uint8Array) => void | Promise<void>;

/** Reads a stream of bytes forward, and writes the copy. */
class Walk {
  private readonly source: AsyncIterator<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;
  /** How many bytes were read. */
  read = 0;
  /** How many bytes the copy has so far. */
  written = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly emit: Emit | undefined,
  ) {
    this.source = source[Symbol.asyncIterator]();
  }

  /** Lets go of the source: nothing more is read. */
  async close(): Promise<void> {
    await this.source.return?.();
  }

  /** Makes the buffer hold a byte, or returns false at the end. */
  private async more(): Promise<boolean> {
    while (this.offset >= this.buffer.length) {
      const next = await this.source.next();
      if (next.done) return false;
      this.buffer = next.value;
      this.offset = 0;
    }
    return true;
  }

  /** Puts back `bytes`, which were the last that were taken. */
  unread(bytes: Uint8Array): void {
    const rest = this.buffer.subarray(this.offset);
    const buffer = new Uint8Array(bytes.length + rest.length);
    buffer.set(bytes);
    buffer.set(rest, bytes.length);
    this.buffer = buffer;
    this.offset = 0;
    this.read -= bytes.length;
  }

  /** Writes `bytes` into the copy. */
  async write(bytes: Uint8Array): Promise<void> {
    this.written += bytes.length;
    if (this.emit && bytes.length > 0) await this.emit(bytes);
  }

  /** The next `length` bytes, as an array of their own. */
  async take(length: number): Promise<Uint8Array> {
    const taken = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (!(await this.more())) throw damaged("it ends early");
      const piece = this.buffer.subarray(
        this.offset,
        this.offset + length - filled,
      );
      taken.set(piece, filled);
      filled += piece.length;
      this.offset += piece.length;
    }
    this.read += length;
    if (this.read > maxImageBytes) throw tooLarge();
    return taken;
  }

  /** Passes over the next `length` bytes: into the copy if `keep`. */
  async pass(length: number, keep: boolean): Promise<void> {
    let left = length;
    while (left > 0) {
      if (!(await this.more())) throw damaged("it ends early");
      const piece = this.buffer.subarray(this.offset, this.offset + left);
      this.offset += piece.length;
      left -= piece.length;
      this.read += piece.length;
      if (this.read > maxImageBytes) throw tooLarge();
      if (keep) await this.write(piece);
    }
  }

  /**
   * Passes the compressed data of a JPEG scan into the copy, up to the
   * marker that ends it, and returns that marker, which is read and not
   * written. In the data a 0xFF is followed by 0x00, by a restart marker
   * or by more 0xFF: anything else is the marker.
   */
  async passScan(): Promise<number> {
    // Whether the byte before was a 0xFF that is still to be judged, and
    // so not written yet.
    let pending = false;
    for (;;) {
      if (!(await this.more())) throw damaged("its data has no end");
      const { buffer } = this;
      const start = this.offset;
      let index = start;
      let marker = -1;
      // The first byte to write of this piece.
      let from = start;
      while (index < buffer.length) {
        const byte = buffer[index] as number;
        if (pending) {
          if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) {
            // Data. The 0xFF before the piece was held back.
            if (index === start) await this.write(ff);
            pending = false;
            index += 1;
          } else if (byte === 0xff) {
            // A fill byte: the one before it is written, and this one
            // waits in its place.
            if (index === start) await this.write(ff);
            index += 1;
          } else {
            marker = byte;
            break;
          }
        } else {
          const found = buffer.indexOf(0xff, index);
          if (found < 0) {
            index = buffer.length;
          } else {
            pending = true;
            index = found + 1;
          }
        }
      }
      if (marker >= 0) {
        // Everything up to the 0xFF of the marker, which is not written.
        const end = index === start ? start : index - 1;
        if (end > from) await this.write(buffer.subarray(from, end));
        this.read += index + 1 - start;
        this.offset = index + 1;
        if (this.read > maxImageBytes) throw tooLarge();
        return marker;
      }
      // The piece is used up. A 0xFF at its end waits for the next.
      const end = pending ? buffer.length - 1 : buffer.length;
      if (end > from) await this.write(buffer.subarray(from, end));
      from = end;
      this.read += buffer.length - start;
      this.offset = buffer.length;
      if (this.read > maxImageBytes) throw tooLarge();
    }
  }
}

const ff = Uint8Array.of(0xff);

const tooLarge = () =>
  new ImageRefused(
    "too_large",
    `The image is larger than ${maxImageBytes / 1024 / 1024} MB.`,
  );

function checkedSize(width: number, height: number): void {
  if (width < 1 || height < 1) throw damaged("it has no size");
  if (width * height > maxImagePixels) {
    throw new ImageRefused(
      "too_many_pixels",
      `The image is ${width} by ${height} pixels. pigy takes ${maxImagePixels / 1_000_000} million pixels at most.`,
    );
  }
}

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

const startsWith = (bytes: Uint8Array, text: string) =>
  bytes.length >= text.length && ascii(bytes, 0, text.length) === text;

const u16be = (bytes: Uint8Array, at: number) =>
  ((bytes[at] as number) << 8) | (bytes[at + 1] as number);

const u16le = (bytes: Uint8Array, at: number) =>
  (bytes[at] as number) | ((bytes[at + 1] as number) << 8);

const u24le = (bytes: Uint8Array, at: number) =>
  u16le(bytes, at) | ((bytes[at + 2] as number) << 16);

const u32be = (bytes: Uint8Array, at: number) =>
  u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);

const u32le = (bytes: Uint8Array, at: number) =>
  u16le(bytes, at) + u16le(bytes, at + 2) * 0x10000;

/**
 * The way up that the Exif payload of a JPEG names, 1 to 8, or 1 where it
 * names none or cannot be read: Exif that cannot be read turns nothing.
 */
function orientationOf(exif: Uint8Array): number {
  // "Exif\0\0", then a TIFF: its byte order, 42, and where the first
  // directory is.
  const tiff = exif.subarray(6);
  if (tiff.length < 8) return 1;
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return 1;
  const u16 = order === "II" ? u16le : u16be;
  const u32 = order === "II" ? u32le : u32be;
  if (u16(tiff, 2) !== 42) return 1;
  const directory = u32(tiff, 4);
  if (directory + 2 > tiff.length) return 1;
  const entries = u16(tiff, directory);
  for (let entry = 0; entry < entries; entry++) {
    const at = directory + 2 + entry * 12;
    if (at + 12 > tiff.length) return 1;
    // Tag 0x0112, one SHORT.
    if (u16(tiff, at) === 0x0112) {
      const value = u16(tiff, at + 8);
      return u16(tiff, at + 2) === 3 && value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** An Exif segment of a JPEG that says the way up and nothing else. */
function orientationSegment(orientation: number): Uint8Array {
  return Uint8Array.of(
    ...[0xff, 0xe1, 0x00, 0x22],
    // "Exif\0\0"
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00],
    // Big-endian TIFF, whose first directory follows its header.
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
    // One entry: the tag 0x0112, a SHORT, one value.
    ...[0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01],
    ...[0x00, orientation, 0x00, 0x00],
    // No directory after it.
    ...[0x00, 0x00, 0x00, 0x00],
  );
}

type Found = Omit<ImageFacts, "size">;

async function walkJpeg(walk: Walk, soi: Uint8Array): Promise<Found> {
  await walk.write(soi.subarray(0, 2));
  let size: { width: number; height: number } | null = null;
  let orientation = 1;
  let marker = await jpegMarker(walk, soi.subarray(2));
  for (;;) {
    if (marker === 0xd9) {
      if (!size) throw damaged("it has no picture");
      await walk.write(Uint8Array.of(0xff, 0xd9));
      break;
    }
    // Markers that stand alone have no place between segments.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      throw damaged("a marker is out of place");
    }
    const head = await walk.take(2);
    const length = u16be(head, 0);
    if (length < 2) throw damaged("a segment has no length");
    const payload = await walk.take(length - 2);
    const frame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    let keep = true;
    if (frame) {
      if (payload.length < 5) throw damaged("its header is cut short");
      // A file has one frame. A second one is not this picture's.
      if (size) throw damaged("it has two pictures");
      size = { height: u16be(payload, 1), width: u16be(payload, 3) };
      checkedSize(size.width, size.height);
    } else if (marker === 0xe1) {
      keep = false;
      if (startsWith(payload, "Exif\0\0") && !size) {
        orientation = orientationOf(payload);
        // In the place of the segment that said it, with nothing else.
        if (orientation !== 1)
          await walk.write(orientationSegment(orientation));
      }
    } else if (marker === 0xe2) {
      // An ICC profile is what the colours mean. Whatever else is here
      // is not the picture: a second picture, by its place in the file.
      keep = startsWith(payload, "ICC_PROFILE\0");
    } else if (marker >= 0xe0 && marker <= 0xef) {
      // JFIF and Adobe's colour transform are read by decoders.
      keep = marker === 0xe0 || marker === 0xee;
    } else if (marker === 0xfe) {
      keep = false;
    }
    if (keep) {
      await walk.write(Uint8Array.of(0xff, marker));
      await walk.write(head);
      await walk.write(payload);
    }
    if (marker === 0xda) {
      if (!size) throw damaged("its data comes before its header");
      marker = await walk.passScan();
    } else {
      marker = await jpegMarker(walk);
    }
  }
  // 5 to 8 lie on their side.
  const turned = orientation >= 5;
  return {
    type: "image/jpeg",
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
    animated: false,
  };
}

/** The next marker of a JPEG, between segments. */
async function jpegMarker(walk: Walk, first?: Uint8Array): Promise<number> {
  let bytes = first ?? (await walk.take(2));
  if (bytes[0] !== 0xff) throw damaged("a segment does not begin as one");
  let marker = bytes[1] as number;
  // Any number of 0xFF may stand before a marker.
  while (marker === 0xff) {
    bytes = await walk.take(1);
    marker = bytes[0] as number;
  }
  if (marker === 0x00) throw damaged("a segment does not begin as one");
  return marker;
}

/** The chunks of a PNG that a decoder draws with. */
const pngChunks = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "bKGD",
  "pHYs",
  "cICP",
  "mDCV",
  "cLLI",
  // An animation.
  "acTL",
  "fcTL",
  "fdAT",
]);

async function walkPng(walk: Walk, signature: Uint8Array): Promise<Found> {
  await walk.write(signature);
  const first = await walk.take(8);
  if (u32be(first, 0) !== 13 || ascii(first, 4, 4) !== "IHDR") {
    throw damaged("it does not begin with its header");
  }
  const header = await walk.take(13 + 4);
  const width = u32be(header, 0);
  const height = u32be(header, 4);
  checkedSize(width, height);
  await walk.write(first);
  await walk.write(header);
  let animated = false;
  let data = false;
  for (;;) {
    const head = await walk.take(8);
    const length = u32be(head, 0);
    const type = ascii(head, 4, 4);
    if (type === "IHDR") throw damaged("it has two headers");
    if (type === "acTL") animated = true;
    if (type === "IDAT") data = true;
    const keep = pngChunks.has(type);
    if (keep) await walk.write(head);
    // The data and its checksum.
    await walk.pass(length + 4, keep);
    if (type === "IEND") break;
  }
  if (!data) throw damaged("it has no picture");
  return { type: "image/png", width, height, animated };
}

async function walkGif(walk: Walk, head: Uint8Array): Promise<Found> {
  // The version, then the screen: width, height, flags, two more bytes.
  await walk.write(head);
  const screen = await walk.take(13 - head.length);
  await walk.write(screen);
  const all = new Uint8Array(13);
  all.set(head);
  all.set(screen, head.length);
  const width = u16le(all, 6);
  const height = u16le(all, 8);
  checkedSize(width, height);
  const flags = all[10] as number;
  if (flags & 0x80) await walk.pass(3 * 2 ** ((flags & 0x07) + 1), true);
  let frames = 0;
  /** Passes over data in sub-blocks, each with its length before it. */
  const blocks = async (keep: boolean) => {
    for (;;) {
      const length = await walk.take(1);
      if (keep) await walk.write(length);
      if (length[0] === 0) return;
      await walk.pass(length[0] as number, keep);
    }
  };
  for (;;) {
    const [introducer] = await walk.take(1);
    if (introducer === 0x3b) {
      await walk.write(Uint8Array.of(0x3b));
      break;
    }
    if (introducer === 0x2c) {
      frames += 1;
      // Its place and size, and its flags, then a colour table of its
      // own if the flags say so, the code size and the data.
      const descriptor = await walk.take(9);
      await walk.write(Uint8Array.of(0x2c));
      await walk.write(descriptor);
      const local = descriptor[8] as number;
      if (local & 0x80) await walk.pass(3 * 2 ** ((local & 0x07) + 1), true);
      await walk.pass(1, true);
      await blocks(true);
    } else if (introducer === 0x21) {
      const [label] = await walk.take(1);
      if (label === 0xff) {
        // An application extension: its first block names the
        // application. Only the one that says how often an animation
        // repeats is the picture's.
        const name = await walk.take(12);
        const keep =
          name[0] === 11 &&
          ["NETSCAPE2.0", "ANIMEXTS1.0"].includes(ascii(name, 1, 11));
        if (keep) {
          await walk.write(Uint8Array.of(0x21, 0xff));
          await walk.write(name);
        }
        await blocks(keep);
      } else {
        // The control of the next frame, and text that is drawn, are
        // the picture's. A comment is not.
        const keep = label === 0xf9 || label === 0x01;
        if (keep) await walk.write(Uint8Array.of(0x21, label as number));
        await blocks(keep);
      }
    } else {
      throw damaged("a block does not begin as one");
    }
  }
  if (frames === 0) throw damaged("it has no picture");
  return { type: "image/gif", width, height, animated: frames > 1 };
}

/** The chunks of a WebP that are the picture. */
const webpChunks = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
]);

async function walkWebp(
  walk: Walk,
  head: Uint8Array,
  /** The size of the copy, which its first bytes have to say. */
  copySize: number | undefined,
): Promise<Found> {
  // "RIFF", the size of what follows, "WEBP".
  let left = u32le(head, 4) - 4;
  const riff = head.slice(0, 12);
  if (copySize !== undefined) {
    new DataView(riff.buffer).setUint32(4, copySize - 8, true);
  }
  await walk.write(riff);
  let found: Found | null = null;
  let first = true;
  while (left >= 8) {
    const chunk = await walk.take(8);
    const type = ascii(chunk, 0, 4);
    const length = u32le(chunk, 4);
    // A chunk of an odd length has a byte after it.
    const padded = length + (length % 2);
    left -= 8 + padded;
    if (left < 0) throw damaged("a chunk is longer than the file says");
    if (first) {
      first = false;
      if (type === "VP8X") {
        if (length < 10) throw damaged("its header is cut short");
        const data = await walk.take(padded);
        const width = u24le(data, 4) + 1;
        const height = u24le(data, 7) + 1;
        checkedSize(width, height);
        found = {
          type: "image/webp",
          width,
          height,
          animated: ((data[0] as number) & 0x02) !== 0,
        };
        // The copy has neither Exif nor XMP, and says so.
        data[0] = (data[0] as number) & ~0x0c;
        await walk.write(chunk);
        await walk.write(data);
        continue;
      }
      if (type === "VP8 ") {
        if (length < 10) throw damaged("its header is cut short");
        const data = await walk.take(10);
        if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
          throw damaged("its picture does not begin as one");
        }
        const width = u16le(data, 6) & 0x3fff;
        const height = u16le(data, 8) & 0x3fff;
        checkedSize(width, height);
        found = { type: "image/webp", width, height, animated: false };
        await walk.write(chunk);
        await walk.write(data);
        await walk.pass(padded - 10, true);
        continue;
      }
      if (type === "VP8L") {
        if (length < 5) throw damaged("its header is cut short");
        const data = await walk.take(5);
        if (data[0] !== 0x2f)
          throw damaged("its picture does not begin as one");
        const bits = u32le(data, 1);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        checkedSize(width, height);
        found = { type: "image/webp", width, height, animated: false };
        await walk.write(chunk);
        await walk.write(data);
        await walk.pass(padded - 5, true);
        continue;
      }
      throw damaged("it does not begin with its header");
    }
    const keep = webpChunks.has(type) && type !== "VP8X";
    if (keep) await walk.write(chunk);
    await walk.pass(padded, keep);
  }
  if (!found) throw damaged("it has no picture");
  return found;
}

async function walkImage(
  source: AsyncIterable<Uint8Array>,
  emit: Emit | undefined,
  copySize: number | undefined,
): Promise<ImageFacts> {
  const walk = new Walk(source, emit);
  try {
    let head: Uint8Array;
    try {
      head = await walk.take(12);
    } catch (error) {
      // Too short to be any of them.
      if (error instanceof ImageRefused && error.code === "damaged") {
        throw notAnImage();
      }
      throw error;
    }
    let found: Found;
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      // The start and the first marker. What was read beyond them is
      // read again as the first segment.
      walk.unread(head.subarray(4));
      found = await walkJpeg(walk, head);
    } else if (
      head[0] === 0x89 &&
      ascii(head, 1, 3) === "PNG" &&
      u32be(head, 4) === 0x0d0a1a0a
    ) {
      walk.unread(head.subarray(8));
      found = await walkPng(walk, head.slice(0, 8));
    } else if (startsWith(head, "GIF87a") || startsWith(head, "GIF89a")) {
      found = await walkGif(walk, head);
    } else if (startsWith(head, "RIFF") && ascii(head, 8, 4) === "WEBP") {
      found = await walkWebp(walk, head, copySize);
    } else {
      throw notAnImage();
    }
    return { ...found, size: walk.written };
  } finally {
    await walk.close();
  }
}

const notAnImage = () =>
  new ImageRefused(
    "not_an_image",
    "The file is not an image that pigy takes: JPEG, PNG, WebP or GIF.",
  );

/**
 * Reads an image and says what it is. Throws `ImageRefused` for a file
 * that pigy does not take.
 */
export function scanImage(
  source: AsyncIterable<Uint8Array>,
): Promise<ImageFacts> {
  return walkImage(source, undefined, undefined);
}

/**
 * Reads an image that `scanImage` has read, which found `facts`, and
 * hands the copy that pigy keeps to `emit`, piece by piece: `facts.size`
 * bytes. Throws if the file is not the one that was scanned.
 */
export async function cleanImage(
  source: AsyncIterable<Uint8Array>,
  facts: ImageFacts,
  emit: Emit,
): Promise<void> {
  const again = await walkImage(source, emit, facts.size);
  if (again.size !== facts.size || again.type !== facts.type) {
    throw new Error("The image changed between two readings of it");
  }
}
