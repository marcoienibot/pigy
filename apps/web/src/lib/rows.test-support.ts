import {
  emptyTables,
  type Row,
  type TableName,
  type Tables,
  unscheduled,
} from "@pigy/core";

/**
 * Rows of the synced tables for the tests of what a screen makes of them.
 * Each has what a mutator would have written, and takes what a test sets.
 */

let next = 0;

/** A new ID of the form of a row's, unique in the test run. */
export function id(): string {
  next += 1;
  return `01900000-0000-7000-8000-${next.toString(16).padStart(12, "0")}`;
}

export function channel(fields: Partial<Row<"channel">> = {}): Row<"channel"> {
  return {
    id: id(),
    network: "mastodon",
    accountId: "1",
    handle: "@ada@mastodon.example",
    name: "Ada Lovelace",
    avatarUrl: null,
    profileUrl: null,
    status: "connected",
    connectedAt: 1,
    expiresAt: null,
    limits: { network: "mastodon", maxCharacters: 500, charactersPerUrl: 23 },
    limitsCheckedAt: 1,
    ...fields,
  };
}

/** The limits that every Bluesky account has. */
export const blueskyLimits = {
  network: "bluesky",
  maxCharacters: 300,
  maxBytes: 3000,
} as const;

export function post(fields: Partial<Row<"post">> = {}): Row<"post"> {
  return {
    id: id(),
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ...unscheduled,
    ...fields,
  };
}

export function part(
  postId: string,
  fields: Partial<Row<"post_part">> = {},
): Row<"post_part"> {
  return {
    id: id(),
    postId,
    targetId: null,
    position: 0,
    text: "Hello",
    ...fields,
  };
}

export function target(
  postId: string,
  channelId: string,
  fields: Partial<Row<"post_target">> = {},
): Row<"post_target"> {
  return {
    id: id(),
    postId,
    channelId,
    status: "pending",
    attempt: 0,
    error: null,
    queuedAt: null,
    sentAt: null,
    disconnected: false,
    ...fields,
  };
}

export function result(
  targetId: string,
  partId: string,
  fields: Partial<Row<"target_part_result">> = {},
): Row<"target_part_result"> {
  return {
    id: id(),
    targetId,
    partId,
    remoteId: "1",
    url: null,
    ...fields,
  };
}

export function media(fields: Partial<Row<"media">> = {}): Row<"media"> {
  return {
    id: id(),
    kind: "image",
    status: "ready",
    name: "photo.jpg",
    type: "image/jpeg",
    size: 400_000,
    width: 1600,
    height: 1200,
    animated: false,
    createdAt: 1,
    error: null,
    originalGoneAt: null,
    ...fields,
  };
}

export function metric(
  targetId: string,
  fields: Partial<Row<"metric">> = {},
): Row<"metric"> {
  return {
    id: targetId,
    status: "counted",
    likes: 0,
    reposts: 0,
    replies: 0,
    quotes: 0,
    views: null,
    countedAt: 1,
    reason: null,
    ...fields,
  };
}

export function partMedia(
  partId: string,
  mediaId: string,
  fields: Partial<Row<"part_media">> = {},
): Row<"part_media"> {
  return { id: id(), partId, mediaId, position: 0, alt: "", ...fields };
}

/** The tables that hold `rows`, each in the table that it is named with. */
export function tablesOf(
  rows: {
    [Table in TableName]?: Row<Table>[];
  },
): Tables {
  const tables = emptyTables() as {
    [Table in TableName]: Map<string, Row<Table>>;
  };
  for (const name of Object.keys(rows) as TableName[]) {
    for (const row of rows[name] ?? []) {
      (tables[name] as Map<string, { id: string }>).set(row.id, row);
    }
  }
  return tables;
}
