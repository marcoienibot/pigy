/**
 * What pigy takes for an image, found out by reading the bytes: the type by
 * how the file begins, the dimensions from its header, never from a name
 * or from what a client says. The same walk through a file makes the copy
 * that pigy keeps and publishes: the image without what it carries
 * besides the picture.
 *
 * Four types: JPEG, PNG, WebP and GIF. No SVG, which is a program.
 *
 * The copy keeps what a decoder draws with and nothing else: what is
 * kept is listed, and whatever a list does not name is left out, also
 * what no format names, which is where anything can hide. A part that is
 * kept for its fields keeps those fields alone.
 *
 * - JPEG: the frame, the scans and their tables. Of the application
 *   segments before the first scan, which is where decoders read them,
 *   the first JFIF, without its thumbnail, which is the picture before
 *   it was cut, an ICC profile, which is what the colours mean, and the
 *   first of Adobe's colour transforms. Not Exif, where a camera
 *   writes the place and the time, nor XMP, IPTC, comments, the
 *   extension of JFIF with its thumbnails, or any other marker. The way
 *   up of the picture is in Exif, so a copy whose picture is turned gets
 *   an Exif segment of pigy's own that says that and nothing else. The
 *   first Exif segment before the scans is the one that counts, as for
 *   decoders: a second one says nothing.
 * - PNG: the chunks that a decoder draws with, each the first of its kind
 *   that is as long as its fields, where decoders read it, and an end
 *   with nothing in it: `pngAncillary`. That takes the text chunks, the
 *   time and Exif, and a chunk that has more than its fields, or is out
 *   of its place, as decoders pass it over. The frames only of a picture
 *   that says that it moves.
 * - WebP: the header, the ICC profile, the picture with its alpha
 *   directly before it, or the frames of an animation with its fields.
 *   A second alpha, or one for a lossless picture, which has its alpha
 *   in itself, is refused: decoders do not agree on what it is. A frame is its picture and
 *   its alpha and nothing else, or the file is refused: what a frame
 *   holds cannot be left out of it without saying its length anew before
 *   it. A WebP whose way up is only in its Exif loses it: cameras do not
 *   write WebP.
 * - GIF: the frames, their controls, and how often an animation repeats.
 *   Not comments, the text that a GIF can draw, which no browser draws,
 *   or other applications' extensions.
 * - Of every type: whatever follows the end of the image. A file that is
 *   an image and something else behind it is only the image afterwards.
 *
 * What pigy says of an image is what a decoder draws. So every frame has
 * to lie within the picture, as the formats have it: a GIF of a pixel
 * with a frame of four billion pixels is refused, and not taken for a
 * pixel. And so is a picture whose header says another size than the
 * one around it.
 *
 * Nothing is decoded and nothing encoded again: the picture is the same
 * bytes. So nothing here says that a decoder will draw the file, only
 * that it is laid out as its type lays a file out.
 *
 * The walk is over a stream and holds a piece of it at a time, so a file
 * is never in memory as a whole. A length that a file declares is checked
 * against what pigy takes before anything is read for it, and the walk is
 * bounded by the bytes that it reads: a file has `maxImageParts` parts at
 * most, and the copy goes out in pieces of `copyPieceBytes`.
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

/**
 * The most parts that an image may have: segments of a JPEG, chunks of a
 * PNG or a WebP, extensions and frames of a GIF. A JPEG has a few dozen,
 * and an animation two for each frame. The data of a GIF comes in blocks
 * of 255 bytes at most, which are no parts: they are read as fast as
 * their bytes. A file of 20 MiB of empty segments has five million.
 */
export const maxImageParts = 50_000;

/** How many bytes of the copy are handed out at a time: 64 KiB. */
export const copyPieceBytes = 64 * 1024;

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

/**
 * Takes a piece of the copy, which is its own: the walk does not touch it
 * again.
 */
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
  /** How many parts were read. */
  private parts = 0;
  /** What is written and not handed out yet, and how much of it there is. */
  private out: Uint8Array;
  private outLength = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly emit: Emit | undefined,
  ) {
    this.source = source[Symbol.asyncIterator]();
    this.out = new Uint8Array(emit ? copyPieceBytes : 0);
  }

  /** Lets go of the source: nothing more is read. */
  async close(): Promise<void> {
    await this.source.return?.();
  }

  /** Counts a part of the file. Throws for one too many. */
  part(): void {
    this.parts += 1;
    if (this.parts > maxImageParts) {
      throw damaged("it has more parts than an image has");
    }
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

  /**
   * Throws if `length` more bytes would take the walk past what pigy
   * takes: before anything is made room for or read for them. A length
   * is what a file says of itself, up to 4 GiB in a few bytes.
   */
  private within(length: number): void {
    if (this.read + length > maxImageBytes) throw tooLarge();
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

  /**
   * Writes `bytes` into the copy, which hands it out once it has a piece
   * of `copyPieceBytes`. `bytes` is copied, and can change afterwards.
   */
  async write(bytes: Uint8Array): Promise<void> {
    this.written += bytes.length;
    if (!this.emit) return;
    let from = 0;
    while (from < bytes.length) {
      const length = Math.min(
        copyPieceBytes - this.outLength,
        bytes.length - from,
      );
      this.out.set(bytes.subarray(from, from + length), this.outLength);
      this.outLength += length;
      from += length;
      if (this.outLength === copyPieceBytes) await this.flush();
    }
  }

  /** Hands out what the copy has that is not handed out yet. */
  async flush(): Promise<void> {
    if (!this.emit || this.outLength === 0) return;
    const piece = this.out.subarray(0, this.outLength);
    this.out = new Uint8Array(copyPieceBytes);
    this.outLength = 0;
    await this.emit(piece);
  }

  /** The next byte. */
  async byte(): Promise<number> {
    if (!(await this.more())) throw damaged("it ends early");
    this.within(1);
    this.read += 1;
    return this.buffer[this.offset++] as number;
  }

  /** The next `length` bytes, as an array of their own. */
  async take(length: number): Promise<Uint8Array> {
    this.within(length);
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
    return taken;
  }

  /** Passes over the next `length` bytes: into the copy if `keep`. */
  async pass(length: number, keep: boolean): Promise<void> {
    this.within(length);
    let left = length;
    while (left > 0) {
      if (!(await this.more())) throw damaged("it ends early");
      const piece = this.buffer.subarray(this.offset, this.offset + left);
      this.offset += piece.length;
      left -= piece.length;
      this.read += piece.length;
      if (keep) await this.write(piece);
    }
  }

  /**
   * Passes over bytes that are `value`, and returns the first byte that is
   * not. None of them is written.
   */
  async after(value: number): Promise<number> {
    for (;;) {
      if (!(await this.more())) throw damaged("it ends early");
      const { buffer } = this;
      let index = this.offset;
      while (index < buffer.length && buffer[index] === value) index += 1;
      const found = index < buffer.length;
      const passed = index - this.offset + (found ? 1 : 0);
      this.within(passed);
      this.read += passed;
      this.offset += passed;
      if (found) return buffer[index] as number;
    }
  }

  /**
   * Passes over data in the blocks of a GIF, each with its length before
   * it, up to the empty one that ends them, which is passed too: into the
   * copy if `keep`. The blocks that lie whole in a piece of the stream are
   * gone through at once, however small they are.
   */
  async passBlocks(keep: boolean): Promise<void> {
    for (;;) {
      if (!(await this.more())) throw damaged("it ends early");
      const { buffer } = this;
      const start = this.offset;
      let index = start;
      let ended = false;
      while (index < buffer.length) {
        const length = buffer[index] as number;
        if (length === 0) {
          index += 1;
          ended = true;
          break;
        }
        if (index + 1 + length > buffer.length) break;
        index += 1 + length;
      }
      this.within(index - start);
      this.read += index - start;
      this.offset = index;
      if (keep) await this.write(buffer.subarray(start, index));
      if (ended) return;
      if (index < buffer.length) {
        // A block that goes on in the next piece.
        const length = await this.byte();
        if (keep) await this.write(Uint8Array.of(length));
        await this.pass(length, keep);
      }
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
        this.within(index + 1 - start);
        if (end > from) await this.write(buffer.subarray(from, end));
        this.read += index + 1 - start;
        this.offset = index + 1;
        return marker;
      }
      // The piece is used up. A 0xFF at its end waits for the next.
      const end = pending ? buffer.length - 1 : buffer.length;
      this.within(buffer.length - start);
      if (end > from) await this.write(buffer.subarray(from, end));
      from = end;
      this.read += buffer.length - start;
      this.offset = buffer.length;
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

/**
 * Throws unless a frame of `width` by `height` at `left`, `top` lies
 * within a picture of `within`: the formats have it so, and a decoder
 * that met another frame would draw another picture than the one that
 * pigy read, or a larger one.
 */
function checkedFrame(
  left: number,
  top: number,
  width: number,
  height: number,
  within: { width: number; height: number },
): void {
  if (left + width > within.width || top + height > within.height) {
    throw damaged("a frame does not lie within the picture");
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
 * The way up that the TIFF of an Exif segment names, 1 to 8, or 1 where
 * it names none or cannot be read: Exif that cannot be read turns
 * nothing.
 */
function orientationOf(tiff: Uint8Array): number {
  // Its byte order, 42, and where the first directory is.
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

/** The markers of a JPEG whose segment is a frame header. */
const isFrame = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/**
 * The tables of a JPEG, which a decoder needs as they are: of the
 * Huffman codes, of arithmetic coding, of quantization, and the interval
 * of the restart markers.
 */
const jpegTables = new Set([0xc4, 0xcc, 0xdb, 0xdd]);

/**
 * The fields of JFIF: its name, version, units, densities and the size of
 * its thumbnail.
 */
const jfifLength = 14;

/** The fields of Adobe's segment: its name, version, flags and transform. */
const adobeLength = 12;

/** The name of an ICC profile, before its parts. */
const iccName = "ICC_PROFILE\0";

/** Writes a segment of `marker` with `payload` into the copy. */
async function writeSegment(walk: Walk, marker: number, payload: Uint8Array) {
  const length = payload.length + 2;
  await walk.write(Uint8Array.of(0xff, marker, length >> 8, length & 0xff));
  await walk.write(payload);
}

async function walkJpeg(walk: Walk, soi: Uint8Array): Promise<Found> {
  await walk.write(soi.subarray(0, 2));
  let size: { width: number; height: number } | null = null;
  let orientation = 1;
  // What decoders read of the segments is what comes before the first
  // scan, and of each kind the first.
  let scanned = false;
  let exif = false;
  let jfif = false;
  let adobe = false;
  let marker = await jpegMarker(walk, soi.subarray(2));
  for (;;) {
    walk.part();
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
    const payloadLength = length - 2;
    if (isFrame(marker)) {
      const payload = await walk.take(payloadLength);
      if (payload.length < 5) throw damaged("its header is cut short");
      // A file has one frame. A second one is not this picture's.
      if (size) throw damaged("it has two pictures");
      size = { height: u16be(payload, 1), width: u16be(payload, 3) };
      checkedSize(size.width, size.height);
      await writeSegment(walk, marker, payload);
    } else if (jpegTables.has(marker) || marker === 0xda) {
      await walk.write(Uint8Array.of(0xff, marker));
      await walk.write(head);
      await walk.pass(payloadLength, true);
    } else if (marker === 0xe1 && !exif && !scanned) {
      const name = await walk.take(Math.min(payloadLength, 6));
      if (startsWith(name, "Exif\0\0")) {
        exif = true;
        orientation = orientationOf(await walk.take(payloadLength - 6));
        // In the place of the segment that said it, with nothing else.
        if (orientation !== 1) {
          await walk.write(orientationSegment(orientation));
        }
      } else {
        await walk.pass(payloadLength - name.length, false);
      }
    } else if (marker === 0xe0 && !jfif && !scanned) {
      const fields = await walk.take(Math.min(payloadLength, jfifLength));
      if (fields.length === jfifLength && startsWith(fields, "JFIF\0")) {
        jfif = true;
        // No thumbnail: it is a picture of its own, and the one before
        // the picture was cut.
        fields[12] = 0;
        fields[13] = 0;
        await writeSegment(walk, marker, fields);
      }
      await walk.pass(payloadLength - fields.length, false);
    } else if (marker === 0xe2 && !scanned) {
      // A part of the profile, which can take several segments.
      const name = await walk.take(Math.min(payloadLength, iccName.length));
      const keep = startsWith(name, iccName);
      if (keep) {
        await walk.write(Uint8Array.of(0xff, marker));
        await walk.write(head);
        await walk.write(name);
      }
      await walk.pass(payloadLength - name.length, keep);
    } else if (marker === 0xee && !adobe && !scanned) {
      const fields = await walk.take(Math.min(payloadLength, adobeLength));
      if (fields.length === adobeLength && startsWith(fields, "Adobe")) {
        adobe = true;
        await writeSegment(walk, marker, fields);
      }
      await walk.pass(payloadLength - fields.length, false);
    } else {
      await walk.pass(payloadLength, false);
    }
    if (marker === 0xda) {
      if (!size) throw damaged("its data comes before its header");
      scanned = true;
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
  const start = first ? (first[0] as number) : await walk.byte();
  if (start !== 0xff) throw damaged("a segment does not begin as one");
  // Any number of 0xFF may stand before a marker.
  let marker = first ? (first[1] as number) : 0xff;
  if (marker === 0xff) marker = await walk.after(0xff);
  if (marker === 0x00) throw damaged("a segment does not begin as one");
  return marker;
}

/** How long a chunk of a PNG is for each type of colour, where that decides it. */
type ByColour = Partial<Record<number, number>>;

/**
 * Whether a chunk of a PNG of `length` bytes is laid out as its kind, in a
 * picture of the type of colour `colour` whose palette has `palette`
 * entries, none if it has no palette yet.
 */
type PngFits = (length: number, colour: number, palette: number) => boolean;

const exactly =
  (fields: number): PngFits =>
  (length) =>
    length === fields;

const byColour =
  (lengths: ByColour): PngFits =>
  (length, colour) =>
    lengths[colour] === length;

/**
 * The chunks of a PNG besides its header, its palette, its data, its
 * frames and its end that a decoder draws with: how long each is, and
 * whether it comes before the palette as well as before the data. A
 * decoder reads the first of each kind that is laid out as one, where it
 * reads it: one that is longer or shorter than its fields, out of its
 * place or a second of its kind, it passes over, and the copy leaves it
 * out. Whatever a chunk holds beyond its fields would otherwise be
 * copied with it.
 */
const pngAncillary: Record<string, { beforePalette: boolean; fits: PngFits }> =
  {
    cHRM: { beforePalette: true, fits: exactly(32) },
    gAMA: { beforePalette: true, fits: exactly(4) },
    // Its name, a zero, how it is compressed, and the profile: read below.
    iCCP: { beforePalette: true, fits: (length) => length >= 4 },
    sBIT: {
      beforePalette: true,
      fits: byColour({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }),
    },
    sRGB: { beforePalette: true, fits: exactly(1) },
    cICP: { beforePalette: true, fits: exactly(4) },
    mDCV: { beforePalette: true, fits: exactly(24) },
    cLLI: { beforePalette: true, fits: exactly(8) },
    tRNS: {
      beforePalette: false,
      // An alpha for each entry of the palette, at most, or the one colour
      // that is transparent. A picture with alpha has none.
      fits: (length, colour, palette) =>
        colour === 3
          ? length >= 1 && length <= palette
          : byColour({ 0: 2, 2: 6 })(length, colour, palette),
    },
    bKGD: {
      beforePalette: false,
      fits: (length, colour, palette) =>
        colour === 3
          ? palette > 0 && length === 1
          : byColour({ 0: 2, 4: 2, 2: 6, 6: 6 })(length, colour, palette),
    },
    pHYs: { beforePalette: false, fits: exactly(9) },
    // That the picture moves: how many frames, and how often they repeat.
    acTL: { beforePalette: false, fits: exactly(8) },
  };

/** The end of a PNG, which has nothing in it, with its checksum. */
const pngEnd = Uint8Array.of(
  0,
  0,
  0,
  0,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
);

/**
 * The longest name of a colour profile, and with it the zero after the
 * name and the byte that says how the profile is compressed.
 */
const iccpNameLength = 79;

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
  const colour = header[9] as number;
  await walk.write(first);
  await walk.write(header);
  /** The kinds of chunk that the copy has. */
  const kept = new Set<string>();
  /** How many entries the palette has that the copy has. */
  let palette = 0;
  let animated = false;
  let data = false;
  for (;;) {
    walk.part();
    const head = await walk.take(8);
    const length = u32be(head, 0);
    const type = ascii(head, 4, 4);
    if (type === "IHDR") throw damaged("it has two headers");
    if (type === "IEND") {
      // The end has nothing in it: whatever a file put there is left out.
      await walk.pass(length + 4, false);
      await walk.write(pngEnd);
      break;
    }
    const rule = pngAncillary[type];
    if (type === "IDAT") {
      data = true;
      await walk.write(head);
      await walk.pass(length + 4, true);
    } else if (type === "PLTE") {
      // The first, before the data, of a picture in colour, with whole
      // entries: three bytes each, 256 at most.
      const keep =
        palette === 0 &&
        !data &&
        colour !== 0 &&
        colour !== 4 &&
        length >= 3 &&
        length <= 3 * 256 &&
        length % 3 === 0;
      if (keep) {
        palette = length / 3;
        await walk.write(head);
      }
      await walk.pass(length + 4, keep);
    } else if (type === "fcTL" && animated) {
      // A frame: its number, its size and its place, then how long it is
      // shown and how it is drawn over the one before.
      if (length !== 26) throw damaged("a frame is not laid out as one");
      const frame = await walk.take(26);
      const frameWidth = u32be(frame, 4);
      const frameHeight = u32be(frame, 8);
      if (frameWidth < 1 || frameHeight < 1) {
        throw damaged("a frame has no size");
      }
      checkedFrame(
        u32be(frame, 12),
        u32be(frame, 16),
        frameWidth,
        frameHeight,
        { width, height },
      );
      await walk.write(head);
      await walk.write(frame);
      await walk.pass(4, true);
    } else if (type === "fdAT" && animated) {
      // The data of a frame.
      await walk.write(head);
      await walk.pass(length + 4, true);
    } else if (
      rule &&
      !kept.has(type) &&
      !data &&
      !(rule.beforePalette && palette > 0) &&
      rule.fits(length, colour, palette)
    ) {
      // A profile is its name, a zero, a zero for how it is compressed,
      // and what is compressed.
      const start =
        type === "iCCP"
          ? await walk.take(Math.min(length, iccpNameLength + 2))
          : new Uint8Array(0);
      const named = start.indexOf(0);
      const keep =
        type !== "iCCP" ||
        (named >= 1 &&
          named <= iccpNameLength &&
          named + 2 < length &&
          start[named + 1] === 0);
      if (keep) {
        kept.add(type);
        if (type === "acTL") animated = true;
        await walk.write(head);
        await walk.write(start);
      }
      await walk.pass(length - start.length + 4, keep);
    } else {
      // Texts, the time, Exif, frames of a picture that does not move,
      // and whatever is not laid out as its kind or not in its place.
      await walk.pass(length + 4, false);
    }
  }
  if (!data) throw damaged("it has no picture");
  return { type: "image/png", width, height, animated };
}

/** The applications of a GIF that say how often it repeats, by their names. */
const loopNames = ["NETSCAPE2.0", "ANIMEXTS1.0"];

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
  for (;;) {
    walk.part();
    const introducer = await walk.byte();
    if (introducer === 0x3b) {
      await walk.write(Uint8Array.of(0x3b));
      break;
    }
    if (introducer === 0x2c) {
      frames += 1;
      // Its place and size, and its flags, then a colour table of its
      // own if the flags say so, the code size and the data.
      const descriptor = await walk.take(9);
      checkedFrame(
        u16le(descriptor, 0),
        u16le(descriptor, 2),
        u16le(descriptor, 4),
        u16le(descriptor, 6),
        { width, height },
      );
      await walk.write(Uint8Array.of(0x2c));
      await walk.write(descriptor);
      const local = descriptor[8] as number;
      if (local & 0x80) await walk.pass(3 * 2 ** ((local & 0x07) + 1), true);
      await walk.pass(1, true);
      await walk.passBlocks(true);
    } else if (introducer === 0x21) {
      const label = await walk.byte();
      // The first block of an extension: its fields.
      const length = await walk.byte();
      // An extension without a block has ended.
      if (length === 0) continue;
      const fields = await walk.take(length);
      if (label === 0xf9 && length === 4) {
        // The control of the next frame: how long it is shown, and how.
        await walk.write(Uint8Array.of(0x21, 0xf9, 4));
        await walk.write(fields);
        await walk.write(Uint8Array.of(0));
      } else if (
        label === 0xff &&
        length === 11 &&
        loopNames.includes(ascii(fields, 0, 11))
      ) {
        // Only the block that says how often an animation repeats is the
        // picture's, and only if it comes first.
        const loop = await walk.byte();
        if (loop === 0) continue;
        const block = await walk.take(loop);
        if (loop === 3 && block[0] === 1) {
          await walk.write(Uint8Array.of(0x21, 0xff, 11));
          await walk.write(fields);
          await walk.write(Uint8Array.of(3));
          await walk.write(block);
          await walk.write(Uint8Array.of(0));
        }
      }
      // A comment, text that is drawn, which no browser draws, another
      // application, and whatever follows the fields that are kept.
      await walk.passBlocks(false);
    } else {
      throw damaged("a block does not begin as one");
    }
  }
  if (frames === 0) throw damaged("it has no picture");
  return { type: "image/gif", width, height, animated: frames > 1 };
}

/** The first bytes of the picture in a chunk of a WebP, and its size. */
async function webpPicture(
  walk: Walk,
  type: string,
  length: number,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  if (type === "VP8 ") {
    if (length < 10) throw damaged("its header is cut short");
    const data = await walk.take(10);
    if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
      throw damaged("its picture does not begin as one");
    }
    return {
      data,
      width: u16le(data, 6) & 0x3fff,
      height: u16le(data, 8) & 0x3fff,
    };
  }
  if (length < 5) throw damaged("its header is cut short");
  const data = await walk.take(5);
  if (data[0] !== 0x2f) throw damaged("its picture does not begin as one");
  const bits = u32le(data, 1);
  return {
    data,
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

const isWebpPicture = (type: string) => type === "VP8 " || type === "VP8L";

async function walkWebp(
  walk: Walk,
  head: Uint8Array,
  /** The size of the copy, which its first bytes have to say. */
  copySize: number | undefined,
): Promise<Found> {
  // "RIFF", the size of what follows, "WEBP".
  const declared = u32le(head, 4);
  if (declared > maxImageBytes - 8) throw tooLarge();
  let left = declared - 4;
  const riff = head.slice(0, 12);
  if (copySize !== undefined) {
    new DataView(riff.buffer).setUint32(4, copySize - 8, true);
  }
  await walk.write(riff);

  /** The head of the next chunk, which has to lie within `room` bytes. */
  const chunkIn = async (room: number) => {
    walk.part();
    if (room < 8) throw damaged("a chunk is longer than the file says");
    const chunk = await walk.take(8);
    const length = u32le(chunk, 4);
    // A chunk of an odd length has a byte after it.
    const padded = length + (length % 2);
    if (8 + padded > room) {
      throw damaged("a chunk is longer than the file says");
    }
    return { chunk, type: ascii(chunk, 0, 4), length, padded };
  };
  /** Writes a chunk of a picture whose first bytes were read, and the rest of it. */
  const keepPicture = async (
    chunk: Uint8Array,
    { data }: { data: Uint8Array },
    padded: number,
  ) => {
    await walk.write(chunk);
    await walk.write(data);
    await walk.pass(padded - data.length, true);
  };

  const first = await chunkIn(left);
  left -= 8 + first.padded;
  if (isWebpPicture(first.type)) {
    // The simple layout: the picture, and nothing that the copy keeps
    // after it.
    const picture = await webpPicture(walk, first.type, first.length);
    checkedSize(picture.width, picture.height);
    await keepPicture(first.chunk, picture, first.padded);
    await walk.pass(left, false);
    return {
      type: "image/webp",
      width: picture.width,
      height: picture.height,
      animated: false,
    };
  }
  if (first.type !== "VP8X") {
    throw damaged("it does not begin with its header");
  }
  // Ten bytes, as libwebp has them too: whatever came after them would be
  // copied as part of the header.
  if (first.length !== 10) throw damaged("its header is not as long as one");
  const header = await walk.take(10);
  const canvas = {
    width: u24le(header, 4) + 1,
    height: u24le(header, 7) + 1,
  };
  checkedSize(canvas.width, canvas.height);
  const animated = ((header[0] as number) & 0x02) !== 0;
  // The copy has neither Exif nor XMP, and says so.
  header[0] = (header[0] as number) & ~0x0c;
  await walk.write(first.chunk);
  await walk.write(header);

  // The picture of a still, or the frames of an animation.
  let pictures = 0;
  let profile = false;
  let loop = false;
  // Whether the alpha of the picture was kept, which goes directly before
  // it in the copy: a lossy picture has its alpha beside it, a lossless
  // one in itself. Decoders do not agree on a second alpha, or on one
  // for a lossless picture, so a file that has either is refused.
  let alpha = false;
  const alphaFor = (type: string) => {
    if (alpha && type !== "VP8 ") {
      throw damaged("its alpha is not where decoders read it");
    }
  };
  while (left > 0) {
    const { chunk, type, length, padded } = await chunkIn(left);
    left -= 8 + padded;
    if (type === "ICCP" && !profile && pictures === 0 && !alpha) {
      profile = true;
      await walk.write(chunk);
      await walk.pass(padded, true);
    } else if (animated && type === "ANIM" && !loop) {
      // The colour behind the frames, and how often they repeat.
      if (length < 6) throw damaged("its animation is cut short");
      loop = true;
      const fields = await walk.take(6);
      await walk.write(Uint8Array.of(...chunk.subarray(0, 4), 6, 0, 0, 0));
      await walk.write(fields);
      await walk.pass(padded - 6, false);
    } else if (animated && type === "ANMF") {
      // A frame: its place, its size, how long it is shown and how, then
      // an alpha of its own if it has one, and its picture, of its size.
      if (length < 16) throw damaged("a frame is cut short");
      const frame = await walk.take(16);
      const width = u24le(frame, 6) + 1;
      const height = u24le(frame, 9) + 1;
      checkedFrame(
        u24le(frame, 0) * 2,
        u24le(frame, 3) * 2,
        width,
        height,
        canvas,
      );
      await walk.write(chunk);
      await walk.write(frame);
      let inside = length - 16;
      let sub = await chunkIn(inside);
      inside -= 8 + sub.padded;
      alpha = false;
      if (sub.type === "ALPH") {
        alpha = true;
        await walk.write(sub.chunk);
        await walk.pass(sub.padded, true);
        sub = await chunkIn(inside);
        inside -= 8 + sub.padded;
      }
      if (!isWebpPicture(sub.type)) {
        throw damaged("a frame holds something other than its picture");
      }
      alphaFor(sub.type);
      alpha = false;
      const picture = await webpPicture(walk, sub.type, sub.length);
      if (picture.width !== width || picture.height !== height) {
        throw damaged("a frame does not lie within the picture");
      }
      await keepPicture(sub.chunk, picture, sub.padded);
      if (inside !== 0) {
        throw damaged("a frame holds something other than its picture");
      }
      pictures += 1;
    } else if (!animated && type === "ALPH" && pictures === 0) {
      alphaFor(type);
      alpha = true;
      await walk.write(chunk);
      await walk.pass(padded, true);
    } else if (!animated && isWebpPicture(type)) {
      // The one picture, of the size that the header says.
      if (pictures > 0) throw damaged("it has two pictures");
      alphaFor(type);
      const picture = await webpPicture(walk, type, length);
      if (picture.width !== canvas.width || picture.height !== canvas.height) {
        throw damaged("its picture is not of the size that it says");
      }
      await keepPicture(chunk, picture, padded);
      pictures += 1;
    } else {
      // Exif, XMP, and what the format does not name or does not have
      // in this place: no decoder draws it.
      await walk.pass(padded, false);
    }
  }
  if (pictures === 0) throw damaged("it has no picture");
  return { type: "image/webp", ...canvas, animated };
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
    await walk.flush();
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
 * hands the copy that pigy keeps to `emit`, in pieces of
 * `copyPieceBytes` and a last one that is shorter: `facts.size` bytes in
 * all. Each piece is `emit`'s own. Throws if the file is not the one that
 * was scanned.
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
