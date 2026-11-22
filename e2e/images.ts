import { crc32, deflateSync } from "node:zlib";

/**
 * Image files for the tests of images, made here: the tests import no code
 * of the application. Each is a PNG that a decoder draws.
 */

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * A PNG of this size: in one colour, or in noise with `noise`, which does
 * not compress and so makes a file of a size.
 */
export function png(
  width: number,
  height: number,
  { color = [200, 60, 60], noise = false } = {},
): Buffer {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) {
      // xorshift32: the same noise in every run.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw[y * row + 1 + x] = noise ? seed & 0xff : (color[x % 3] ?? 0);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Eight bits each of red, green and blue.
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: noise ? 0 : 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `buffer` as a file that a person chooses, under `name`. */
export const file = (name: string, buffer: Buffer, mimeType = "image/png") => ({
  name,
  mimeType,
  buffer,
});
