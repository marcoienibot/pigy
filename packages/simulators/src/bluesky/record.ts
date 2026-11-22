import type { SimCard, SimEntity, SimImage } from "../world/index.ts";
import {
  accountByHandle,
  type PostRecord,
  type State,
  type StoredBlob,
} from "./state.ts";

/**
 * What the simulated PDS checks of a post before it keeps it, and the
 * identifiers that it makes: record keys and content hashes.
 *
 * The schema is the lexicon `app.bsky.feed.post` with
 * `com.atproto.repo.strongRef`, the formats are those of the atproto
 * specifications "Record Key", "TID", "DID" and "AT URI scheme". It shares
 * nothing with the counting in @pigy/core or with the adapter, on purpose:
 * the two sides are meant to catch each other's mistakes.
 *
 * On two points this is stricter than a real PDS, on purpose. A PDS checks
 * a record against its schema and nothing else, and what it lets through
 * shows only later, in an app, as a reply that hangs in the air. So that
 * such a mistake of an adapter fails a test, the simulated PDS refuses:
 *
 * - a reply whose parent or root is no post of this world, or is named
 *   with another hash than it has,
 * - a reply whose root is not the root of the thread of its parent.
 *
 * Facets are checked against the lexicon `app.bsky.richtext.facet`, and
 * on three points more strictly than a PDS checks them, for the same
 * reason: what a PDS lets through shows in an app as a link over the
 * wrong letters, or as a mention of nobody.
 *
 * - a facet has to cover bytes of the text, and begin and end between two
 *   characters, not in the middle of one,
 * - two facets must not overlap, which the lexicon asks of a client,
 * - a mention has to name an account of this world.
 *
 * Of the embeds, two are simulated: the card of a link,
 * `app.bsky.embed.external`, without a picture, and images,
 * `app.bsky.embed.images`, whose blobs the account has to have uploaded:
 * `imagesProblem`. Not simulated, and refused: every other embed, labels,
 * extra tags and the deprecated entities.
 */

export const postCollection = "app.bsky.feed.post";
export const profileCollection = "app.bsky.actor.profile";

// The limits of the lexicon.
const maxTextGraphemes = 300;
const maxTextBytes = 3000;
const maxLangs = 3;

const encoder = new TextEncoder();

const didPattern = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const tidPattern = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const recordKeyPattern = /^[A-Za-z0-9.\-_:~]{1,512}$/;
const nsidPattern =
  /^[a-zA-Z]([a-zA-Z0-9-]{0,62})?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})?)+(\.[a-zA-Z]([a-zA-Z0-9]{0,62})?)$/;
// "Datetime" of the lexicon specification: a date and a time with seconds
// and a time zone, which may not be "-00:00".
const datetimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A CID as atproto writes it: version 1, in base32.
const cidPattern = /^b[a-z2-7]{20,}$/;
const languagePattern = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

export const isDid = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048 && didPattern.test(value);

export const isNsid = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 317 && nsidPattern.test(value);

export const isRecordKey = (value: unknown): value is string =>
  typeof value === "string" &&
  recordKeyPattern.test(value) &&
  value !== "." &&
  value !== "..";

export const isTid = (value: string) => tidPattern.test(value);

/** How many grapheme clusters `text` has. */
function graphemeLength(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

const base32 = "abcdefghijklmnopqrstuvwxyz234567";
const sortableBase32 = "234567abcdefghijklmnopqrstuvwxyz";

/** `value` as JSON whose keys are in order, so that equal values read equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A content hash for `value` in the form of a real one: a CID of version 1
 * that names DAG-CBOR and SHA-256. The same value has the same hash, and
 * another value another. It is not the hash that a PDS would compute: the
 * digest is taken of the JSON, not of the DAG-CBOR, which nothing here
 * encodes.
 */
export async function cidOf(value: unknown): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(canonical(value))),
  );
  // Version 1, DAG-CBOR, SHA-256, 32 bytes.
  const bytes = new Uint8Array([0x01, 0x71, 0x12, 0x20, ...digest]);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let text = "b";
  for (let index = 0; index < bits.length; index += 5) {
    text +=
      base32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return text;
}

/**
 * The hash that a blob is named by, of its bytes: a CID of version 1
 * with the codec "raw", in base32.
 */
export async function blobCid(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  // Version 1, raw, SHA-256, 32 bytes.
  const all = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]);
  let bits = "";
  for (const byte of all) bits += byte.toString(2).padStart(8, "0");
  let text = "b";
  for (let index = 0; index < bits.length; index += 5) {
    text +=
      base32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return text;
}

/**
 * A new timestamp identifier, as the "TID" specification has it: the time
 * in microseconds and ten bits that tell apart what is made in the same
 * microsecond. The world's counter stands for both the microseconds that
 * the clock does not have and those ten bits, so no two are alike.
 */
export function nextTid(state: State): string {
  const count = state.world.nextNumber();
  const microseconds =
    BigInt(state.world.now().getTime()) * 1000n + BigInt(count % 1000);
  let number = (microseconds << 10n) | BigInt(count % 1024);
  let text = "";
  for (let index = 0; index < 13; index++) {
    text = sortableBase32[Number(number & 31n)] + text;
    number >>= 5n;
  }
  return text;
}

/** The parts of the AT URI of a record, or undefined if it is none. */
export function parseRecordUri(
  uri: unknown,
): { did: string; collection: string; rkey: string } | undefined {
  if (typeof uri !== "string") return undefined;
  const [, did, collection, rkey, ...rest] =
    /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri) ?? [];
  if (rest.length > 0 || !isDid(did) || !isNsid(collection)) return undefined;
  return isRecordKey(rkey) ? { did, collection, rkey } : undefined;
}

export const recordUri = (did: string, collection: string, rkey: string) =>
  `at://${did}/${collection}/${rkey}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The post that a strong reference names, or what is wrong with it. */
function referenced(
  state: State,
  reference: unknown,
  where: string,
): PostRecord | string {
  if (!isObject(reference)) return `${where} must be an object`;
  const { uri, cid } = reference;
  const parsed = parseRecordUri(uri);
  if (!parsed) return `${where}/uri must be a valid at-uri`;
  if (typeof cid !== "string" || !cidPattern.test(cid)) {
    return `${where}/cid must be a cid string`;
  }
  const post = state.posts.get(uri as string);
  if (!post) return `${where}/uri names no post of this world: ${uri}`;
  if (post.cid !== cid) {
    return `${where}/cid is not the hash of the post at ${uri}`;
  }
  return post;
}

/**
 * What is wrong with `record` as a post, or undefined if the simulated
 * PDS takes it. The messages are in the manner of a PDS. GUESS: their
 * exact words are not documented.
 */
export function postProblem(
  state: State,
  record: unknown,
  /** The DID of the account that writes the record. */
  account: string,
): string | undefined {
  if (!isObject(record)) return "record must be an object";
  if (record.$type !== postCollection) {
    return `record/$type must be ${postCollection}`;
  }
  for (const key of Object.keys(record)) {
    if (["labels", "tags", "entities"].includes(key)) {
      return `record/${key} is not simulated`;
    }
    if (
      ![
        "$type",
        "text",
        "createdAt",
        "reply",
        "langs",
        "facets",
        "embed",
      ].includes(key)
    ) {
      return `record/${key} is not a field of ${postCollection}`;
    }
  }

  const { text, createdAt, langs, reply } = record;
  if (typeof text !== "string") return "record/text must be a string";
  // Both limits hold at once: bytes of UTF-8, and grapheme clusters.
  if (encoder.encode(text).length > maxTextBytes) {
    return `record/text must not be longer than ${maxTextBytes} characters`;
  }
  if (graphemeLength(text) > maxTextGraphemes) {
    return `record/text must not be longer than ${maxTextGraphemes} graphemes`;
  }
  if (
    typeof createdAt !== "string" ||
    !datetimePattern.test(createdAt) ||
    createdAt.endsWith("-00:00") ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return "record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601)";
  }
  if (langs !== undefined) {
    if (!Array.isArray(langs) || langs.length > maxLangs) {
      return `record/langs must not have more than ${maxLangs} elements`;
    }
    if (
      !langs.every(
        (lang) => typeof lang === "string" && languagePattern.test(lang),
      )
    ) {
      return "record/langs must be well-formed BCP 47 language tags";
    }
  }
  const facetProblem = facetsProblem(state, text, record.facets);
  if (facetProblem) return facetProblem;
  const embedProblem =
    isObject(record.embed) && record.embed.$type === imagesEmbed
      ? imagesProblem(state, account, record.embed)
      : externalProblem(record.embed);
  if (embedProblem) return embedProblem;
  if (reply !== undefined) {
    if (!isObject(reply)) return "record/reply must be an object";
    const parent = referenced(state, reply.parent, "record/reply/parent");
    if (typeof parent === "string") return parent;
    const root = referenced(state, reply.root, "record/reply/root");
    if (typeof root === "string") return root;
    // The root of a thread is the root of the post that is replied to, or
    // that post itself if it replies to nothing.
    const parentReply = parent.record.reply;
    const expected =
      isObject(parentReply) && isObject(parentReply.root)
        ? parentReply.root.uri
        : parent.id;
    if (root.id !== expected) {
      return "record/reply/root is not the root of the thread of record/reply/parent";
    }
  }
  return undefined;
}

/** The account that `repo` names: a DID or a handle. */
export function accountOf(state: State, repo: unknown) {
  if (typeof repo !== "string") return undefined;
  return repo.startsWith("did:")
    ? state.accounts.get(repo)
    : accountByHandle(state, repo);
}

const facetPrefix = "app.bsky.richtext.facet#";
const externalEmbed = "app.bsky.embed.external";

// The limits of a tag in the lexicon: bytes, and grapheme clusters.
const maxTagBytes = 640;
const maxTagGraphemes = 64;

/** Whether `value` is an address with a scheme: the format `uri`. */
function isUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+$/.test(value);
}

/** Whether a byte begins a character in UTF-8, and is not the middle of one. */
const beginsCharacter = (byte: number | undefined) =>
  byte === undefined || (byte & 0xc0) !== 0x80;

/** What a facet of a post marks, once it is checked. */
type Facet = {
  byteStart: number;
  byteEnd: number;
  kind: SimEntity["kind"];
  target: string;
};

/** The facets of `facets` over `text`, or what is wrong with them. */
function readFacets(
  state: State,
  text: string,
  facets: unknown,
): Facet[] | string {
  if (facets === undefined) return [];
  if (!Array.isArray(facets)) return "record/facets must be an array";
  const bytes = encoder.encode(text);
  const read: Facet[] = [];
  for (const [number, facet] of facets.entries()) {
    const where = `record/facets/${number}`;
    if (!isObject(facet)) return `${where} must be an object`;
    for (const key of Object.keys(facet)) {
      if (!["$type", "index", "features"].includes(key)) {
        return `${where}/${key} is not a field of a facet`;
      }
    }
    if (
      facet.$type !== undefined &&
      facet.$type !== "app.bsky.richtext.facet"
    ) {
      return `${where}/$type must be app.bsky.richtext.facet`;
    }
    const { index, features } = facet;
    if (!isObject(index)) return `${where}/index must be an object`;
    const { byteStart, byteEnd } = index;
    if (
      !Number.isInteger(byteStart) ||
      !Number.isInteger(byteEnd) ||
      (byteStart as number) < 0 ||
      (byteEnd as number) < 0
    ) {
      return `${where}/index must have byteStart and byteEnd, integers of 0 or more`;
    }
    const [start, end] = [byteStart as number, byteEnd as number];
    // Stricter than a PDS, on purpose: see the top of this file.
    if (start >= end || end > bytes.length) {
      return `${where}/index names bytes ${start} to ${end}, and the text has ${bytes.length}`;
    }
    if (!beginsCharacter(bytes[start]) || !beginsCharacter(bytes[end])) {
      return `${where}/index begins or ends in the middle of a character`;
    }
    if (read.some((other) => start < other.byteEnd && other.byteStart < end)) {
      return `${where}/index overlaps another facet`;
    }
    if (!Array.isArray(features) || features.length !== 1) {
      // The lexicon takes several features for one stretch of text. pigy
      // sends one, and what several would mean in an app is not said.
      return `${where}/features: the simulated PDS takes one feature per facet`;
    }
    const [feature] = features as unknown[];
    if (!isObject(feature) || typeof feature.$type !== "string") {
      return `${where}/features/0 must be an object with a $type`;
    }
    const fields = Object.keys(feature).filter((key) => key !== "$type");
    const only = (name: string) =>
      fields.length === 1 && fields[0] === name
        ? undefined
        : `${where}/features/0 must have "${name}" and nothing else`;
    switch (feature.$type) {
      case `${facetPrefix}link`: {
        const problem = only("uri");
        if (problem) return problem;
        if (!isUri(feature.uri)) {
          return `${where}/features/0/uri must be a uri`;
        }
        read.push({
          byteStart: start,
          byteEnd: end,
          kind: "link",
          target: feature.uri,
        });
        break;
      }
      case `${facetPrefix}mention`: {
        const problem = only("did");
        if (problem) return problem;
        if (!isDid(feature.did)) {
          return `${where}/features/0/did must be a valid did`;
        }
        // Stricter than a PDS, on purpose: see the top of this file.
        if (!state.accounts.get(feature.did)) {
          return `${where}/features/0/did names no account of this world: ${feature.did}`;
        }
        read.push({
          byteStart: start,
          byteEnd: end,
          kind: "mention",
          target: feature.did,
        });
        break;
      }
      case `${facetPrefix}tag`: {
        const problem = only("tag");
        if (problem) return problem;
        const { tag } = feature;
        if (
          typeof tag !== "string" ||
          tag === "" ||
          encoder.encode(tag).length > maxTagBytes ||
          graphemeLength(tag) > maxTagGraphemes
        ) {
          return `${where}/features/0/tag must be a string of at most ${maxTagGraphemes} graphemes`;
        }
        // The tag is kept without its sign: "Posts" of docs.bsky.app.
        if (/^[#＃]/.test(tag)) {
          return `${where}/features/0/tag must not begin with "#"`;
        }
        read.push({
          byteStart: start,
          byteEnd: end,
          kind: "hashtag",
          target: tag,
        });
        break;
      }
      default:
        return `${where}/features/0/$type is no feature that the simulated PDS knows: ${feature.$type}`;
    }
  }
  return read;
}

function facetsProblem(state: State, text: string, facets: unknown) {
  const read = readFacets(state, text, facets);
  return typeof read === "string" ? read : undefined;
}

const imagesEmbed = "app.bsky.embed.images";

/** The lexicon `app.bsky.embed.images`: four images of a million bytes. */
export const maxImages = 4;
export const maxImageBytes = 1_000_000;

/** How long a PDS keeps a blob that no record refers to: GUESS, an hour. */
export const unreferencedBlobMs = 60 * 60 * 1000;

/** The blob of `account` with the hash `cid`, if the PDS still has it. */
export function blobOf(
  state: State,
  account: string,
  cid: string,
): StoredBlob | undefined {
  const blob = state.blobs.get(`${account}/${cid}`);
  if (
    blob &&
    blob.record === null &&
    state.world.now().getTime() - blob.createdAt >= unreferencedBlobMs
  ) {
    return undefined;
  }
  return blob;
}

/** The blobs that an embed of images refers to, in order. */
export function blobsOf(
  state: State,
  account: string,
  record: Record<string, unknown>,
): { blob: StoredBlob; alt: string }[] {
  const { embed } = record;
  if (!isObject(embed) || embed.$type !== imagesEmbed) return [];
  return (embed.images as { image: { ref: { $link: string } }; alt: string }[])
    .map(({ image, alt }) => ({
      blob: blobOf(state, account, image.ref.$link),
      alt,
    }))
    .filter((entry): entry is { blob: StoredBlob; alt: string } =>
      Boolean(entry.blob),
    );
}

/**
 * What is wrong with an embed of images, or undefined if the simulated
 * PDS takes it: the lexicon, and that every blob is one that the account
 * has uploaded and that the PDS still has, of the type and the size that
 * the record says.
 *
 * GUESS: a reference PDS refuses a record whose blob it does not have
 * with the error "BlobNotFound" and the words "Could not find blob",
 * from its code. The message below begins with them.
 */
function imagesProblem(
  state: State,
  account: string,
  embed: Record<string, unknown>,
): string | undefined {
  const { images } = embed;
  if (Object.keys(embed).length !== 2 || !Array.isArray(images)) {
    return `record/embed must have "images" and nothing else`;
  }
  if (images.length < 1 || images.length > maxImages) {
    return `record/embed/images must not have more than ${maxImages} elements`;
  }
  for (const [index, entry] of images.entries()) {
    const where = `record/embed/images/${index}`;
    if (!isObject(entry)) return `${where} must be an object`;
    for (const key of Object.keys(entry)) {
      if (!["image", "alt", "aspectRatio"].includes(key)) {
        return `${where}/${key} is not a field of an image`;
      }
    }
    if (typeof entry.alt !== "string") return `${where}/alt must be a string`;
    const { image, aspectRatio } = entry;
    if (aspectRatio !== undefined) {
      if (
        !isObject(aspectRatio) ||
        !Number.isInteger(aspectRatio.width) ||
        !Number.isInteger(aspectRatio.height) ||
        (aspectRatio.width as number) < 1 ||
        (aspectRatio.height as number) < 1
      ) {
        return `${where}/aspectRatio must have a width and a height of 1 or more`;
      }
    }
    if (
      !isObject(image) ||
      image.$type !== "blob" ||
      !isObject(image.ref) ||
      typeof image.ref.$link !== "string" ||
      typeof image.mimeType !== "string" ||
      typeof image.size !== "number"
    ) {
      return `${where}/image should be a blob ref`;
    }
    if (!image.mimeType.startsWith("image/")) {
      return `${where}/image: Wrong type of file. It is ${image.mimeType} but it must match image/*`;
    }
    if (image.size > maxImageBytes) {
      return `${where}/image: This file is too large. It is ${image.size} but the maximum size is ${maxImageBytes}`;
    }
    const stored = blobOf(state, account, image.ref.$link);
    if (!stored) return `Could not find blob: ${image.ref.$link}`;
    if (stored.mimeType !== image.mimeType || stored.size !== image.size) {
      return `${where}/image is not the blob that was uploaded`;
    }
  }
  return undefined;
}

/** What is wrong with `embed`, or undefined if the simulated PDS takes it. */
function externalProblem(embed: unknown): string | undefined {
  if (embed === undefined) return undefined;
  if (!isObject(embed)) return "record/embed must be an object";
  if (embed.$type !== externalEmbed) {
    return `record/embed: the simulated PDS takes ${externalEmbed}, ${imagesEmbed} and no other embed`;
  }
  const { external } = embed;
  if (Object.keys(embed).length !== 2 || !isObject(external)) {
    return `record/embed must have "external" and nothing else`;
  }
  for (const key of Object.keys(external)) {
    if (key === "thumb") {
      return "record/embed/external/thumb is not simulated: the simulated PDS keeps no blobs";
    }
    if (!["uri", "title", "description"].includes(key)) {
      return `record/embed/external/${key} is not a field of an external embed`;
    }
  }
  if (!isUri(external.uri)) return "record/embed/external/uri must be a uri";
  // Both are required by the lexicon, and may be empty.
  if (typeof external.title !== "string") {
    return "record/embed/external/title must be a string";
  }
  if (typeof external.description !== "string") {
    return "record/embed/external/description must be a string";
  }
  return undefined;
}

/**
 * What an app shows of a post that the simulated PDS has taken, besides
 * its text: what its facets mark, by where they stand in the text as a
 * string, and the card of its embed.
 */
export function shownOf(
  state: State,
  record: Record<string, unknown>,
  /** The DID of the account whose record it is. */
  account: string,
): { entities: SimEntity[]; card: SimCard | null; images?: SimImage[] } {
  const images = blobsOf(state, account, record).map(
    ({ blob, alt }): SimImage => ({
      blob: blob.blob,
      // Read from the bytes when they were uploaded.
      type: blob.mimeType as SimImage["type"],
      width: blob.width,
      height: blob.height,
      size: blob.size,
      alt,
    }),
  );
  const text = record.text as string;
  const facets = readFacets(state, text, record.facets);
  const bytes = encoder.encode(text);
  const decoder = new TextDecoder();
  /** The place in the string of what is `byte` bytes into its UTF-8. */
  const offset = (byte: number) =>
    decoder.decode(bytes.subarray(0, byte)).length;
  const external = isObject(record.embed) ? record.embed.external : undefined;
  return {
    entities: (typeof facets === "string" ? [] : facets)
      .map(({ byteStart, byteEnd, kind, target }) => ({
        kind,
        start: offset(byteStart),
        end: offset(byteEnd),
        target,
      }))
      .sort((a, b) => a.start - b.start),
    card: isObject(external)
      ? {
          url: external.uri as string,
          title: external.title as string,
          description: external.description as string,
        }
      : null,
    ...(images.length > 0 && { images }),
  };
}
