import type { SimStorage } from "./storage.ts";

/**
 * What the simulated networks do with the bytes of an image: say what the
 * bytes are, and keep them, for the feeds of a world to show.
 *
 * The code that reads a file is the simulators' own, and shares nothing
 * with the code of pigy that reads one: a simulator checks what pigy
 * sends, so it must not agree with pigy by being the same code.
 */

/** The types of image that a simulated network can tell. */
export type SimImageType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/** What a network finds in the bytes of an image. */
export type SimImageInfo = {
  type: SimImageType;
  width: number;
  height: number;
};

const text = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

/**
 * What `bytes` are, by how they begin and by what their header says of
 * the picture, or null if they are none of the four types. Nothing is
 * decoded: a network would, and a simulated one stands in for one that
 * takes every file whose header it can read.
 */
export function imageInfo(bytes: Uint8Array): SimImageInfo | null {
  try {
    return readInfo(bytes);
  } catch (error) {
    // A header that ends before what it should say.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function readInfo(bytes: Uint8Array): SimImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && text(bytes, 1, 3) === "PNG" && bytes[0] === 0x89) {
    return {
      type: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(text(bytes, 0, 6))) {
    return {
      type: "image/gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }
  if (
    bytes.length >= 16 &&
    text(bytes, 0, 4) === "RIFF" &&
    text(bytes, 8, 4) === "WEBP"
  ) {
    const kind = text(bytes, 12, 4);
    if (kind === "VP8X") {
      return {
        type: "image/webp",
        width: (view.getUint32(24, true) & 0xffffff) + 1,
        height: (view.getUint32(27, true) & 0xffffff) + 1,
      };
    }
    if (kind === "VP8L") {
      const bits = view.getUint32(21, true);
      return {
        type: "image/webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (kind === "VP8 ") {
      return {
        type: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // From segment to segment, to the one that has the size.
    let at = 2;
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1] as number;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const frame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame) {
        return {
          type: "image/jpeg",
          height: view.getUint16(at + 5),
          width: view.getUint16(at + 7),
        };
      }
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  return null;
}

/**
 * Whether `bytes` say anything of where or with what a picture was
 * taken: Exif in a JPEG, a PNG or a WebP. For a test that claims that
 * pigy publishes none.
 */
export function hasExif(bytes: Uint8Array): boolean {
  const all = new TextDecoder("latin1").decode(bytes);
  return (
    all.includes("Exif\0\0") || all.includes("eXIf") || all.includes("EXIF")
  );
}

/** The most bytes of images that a world keeps: 48 MiB. */
export const maxBlobBytes = 48 * 1024 * 1024;

// A value of the storage is far smaller than an image may be.
const pieceBytes = 512 * 1024;

type BlobRecord = { size: number; pieces: number; number: number };

/**
 * The bytes that a world keeps: of the images that were published in it.
 * A world keeps so many bytes and no more, `maxBlobBytes`: the oldest go
 * when there are more, and whoever asks for one of them is told that it
 * is gone. A simulated network shows what was posted lately, which is
 * what a sandbox is looked at for.
 */
export type SimBlobs = {
  /** Keeps `bytes`, and returns the name to ask for them by. */
  put(bytes: Uint8Array): string;
  /** The bytes under `id`, or undefined if the world has none. */
  get(id: string): Uint8Array | undefined;
};

export function createBlobs(
  storage: SimStorage,
  nextNumber: () => number,
): SimBlobs {
  const record = (id: string) =>
    storage.get(`blob/${id}`) as BlobRecord | undefined;
  const drop = (id: string, { pieces }: BlobRecord) => {
    for (let piece = 0; piece < pieces; piece++) {
      storage.delete(`blob-piece/${id}/${piece}`);
    }
    storage.delete(`blob/${id}`);
  };
  return {
    put(bytes) {
      const number = nextNumber();
      const id = `blob${number}`;
      const pieces = Math.ceil(bytes.length / pieceBytes);
      for (let piece = 0; piece < pieces; piece++) {
        storage.put(
          `blob-piece/${id}/${piece}`,
          bytes.slice(piece * pieceBytes, (piece + 1) * pieceBytes),
        );
      }
      storage.put(`blob/${id}`, {
        size: bytes.length,
        pieces,
        number,
      } satisfies BlobRecord);
      // The oldest first, until what is left is within the limit.
      const kept = Array.from(
        storage.list({ prefix: "blob/" }),
        ([key, value]) => ({
          id: key.slice("blob/".length),
          record: value as BlobRecord,
        }),
      ).sort((a, b) => a.record.number - b.record.number);
      let total = kept.reduce((sum, { record }) => sum + record.size, 0);
      for (const old of kept) {
        if (total <= maxBlobBytes || old.id === id) break;
        drop(old.id, old.record);
        total -= old.record.size;
      }
      return id;
    },
    get(id) {
      const found = record(id);
      if (!found) return undefined;
      const bytes = new Uint8Array(found.size);
      for (let piece = 0; piece < found.pieces; piece++) {
        const part = storage.get(`blob-piece/${id}/${piece}`);
        if (!(part instanceof Uint8Array)) return undefined;
        bytes.set(part, piece * pieceBytes);
      }
      return bytes;
    },
  };
}
