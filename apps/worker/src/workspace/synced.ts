import type { Row, TableName } from "@pigy/core";
import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  channels,
  media,
  notifications,
  partMedia,
  postParts,
  posts,
  postTargets,
  scheduleSlots,
  settings,
  targetPartResults,
} from "./schema.ts";

/**
 * The synced tables and, for each, its synced columns: the ones that clients
 * hold a copy of and that mutators read and write. Every row that leaves the
 * object is read here, from these columns alone, so a column that is not
 * listed cannot get into a sync message. The same goes for a table.
 *
 * The compiler holds the lists to the rows that @pigy/core describes: a
 * column that is missing here, one that is not a field of the row, or one of
 * another type does not compile. Neither does a column that can be null
 * where the field cannot, or the other way round.
 */
const synced = {
  post: {
    table: posts,
    columns: {
      id: posts.id,
      status: posts.status,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      mode: posts.mode,
      dueAt: posts.dueAt,
      queuePosition: posts.queuePosition,
      heldAt: posts.heldAt,
      trashedAt: posts.trashedAt,
    },
  },
  post_part: {
    table: postParts,
    columns: {
      id: postParts.id,
      postId: postParts.postId,
      targetId: postParts.targetId,
      position: postParts.position,
      text: postParts.text,
    },
  },
  channel: {
    table: channels,
    columns: {
      id: channels.id,
      network: channels.network,
      accountId: channels.accountId,
      handle: channels.handle,
      name: channels.name,
      avatarUrl: channels.avatarUrl,
      profileUrl: channels.profileUrl,
      status: channels.status,
      connectedAt: channels.connectedAt,
      expiresAt: channels.expiresAt,
      limits: channels.limits,
      limitsCheckedAt: channels.limitsCheckedAt,
    },
  },
  post_target: {
    table: postTargets,
    columns: {
      id: postTargets.id,
      postId: postTargets.postId,
      channelId: postTargets.channelId,
      status: postTargets.status,
      attempt: postTargets.attempt,
      error: postTargets.error,
      queuedAt: postTargets.queuedAt,
      sentAt: postTargets.sentAt,
      disconnected: postTargets.disconnected,
    },
  },
  target_part_result: {
    table: targetPartResults,
    columns: {
      id: targetPartResults.id,
      targetId: targetPartResults.targetId,
      partId: targetPartResults.partId,
      remoteId: targetPartResults.remoteId,
      url: targetPartResults.url,
    },
  },
  notification: {
    table: notifications,
    columns: {
      id: notifications.id,
      kind: notifications.kind,
      postId: notifications.postId,
      channelId: notifications.channelId,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
    },
  },
  schedule_slot: {
    table: scheduleSlots,
    columns: {
      id: scheduleSlots.id,
      weekday: scheduleSlots.weekday,
      minute: scheduleSlots.minute,
    },
  },
  settings: {
    table: settings,
    columns: {
      id: settings.id,
      timeZone: settings.timeZone,
      queuePaused: settings.queuePaused,
    },
  },
  media: {
    table: media,
    columns: {
      id: media.id,
      kind: media.kind,
      status: media.status,
      name: media.name,
      type: media.type,
      size: media.size,
      width: media.width,
      height: media.height,
      animated: media.animated,
      createdAt: media.createdAt,
      error: media.error,
      originalGoneAt: media.originalGoneAt,
    },
  },
  part_media: {
    table: partMedia,
    columns: {
      id: partMedia.id,
      partId: partMedia.partId,
      mediaId: partMedia.mediaId,
      position: partMedia.position,
      alt: partMedia.alt,
    },
  },
} satisfies {
  [Table in TableName]: {
    table: SQLiteTable;
    columns: {
      [Field in keyof Row<Table>]: SQLiteColumn & {
        _: {
          data: NonNullable<Row<Table>[Field]>;
          notNull: null extends Row<Table>[Field] ? false : true;
        };
      };
    };
  };
};

type Database = DrizzleSqliteDODatabase;

/**
 * A synced table as the functions below handle it: any of them. What they
 * read is a row of the table they were asked for because `synced` is checked
 * against the rows above.
 */
type Synced = {
  table: SQLiteTable;
  columns: Record<string, SQLiteColumn> & { id: SQLiteColumn };
};

/** The row of `table` with this ID, if there is one. */
export function readRow<Table extends TableName>(
  db: Database,
  table: Table,
  id: string,
): Row<Table> | undefined {
  const { table: from, columns }: Synced = synced[table];
  return db.select(columns).from(from).where(eq(columns.id, id)).get() as
    | Row<Table>
    | undefined;
}

/** The rows of `table` whose `column` is `value`. */
export function findRows<Table extends TableName>(
  db: Database,
  table: Table,
  column: string,
  value: unknown,
): Row<Table>[] {
  const { table: from, columns }: Synced = synced[table];
  const where = columns[column];
  if (!where) throw new Error(`${table} has no synced column ${column}`);
  return db
    .select(columns)
    .from(from)
    .where(eq(where, value))
    .all() as Row<Table>[];
}

/** Every row of `table`. */
export function readRows<Table extends TableName>(
  db: Database,
  table: Table,
): Row<Table>[] {
  const { table: from, columns }: Synced = synced[table];
  return db.select(columns).from(from).all() as Row<Table>[];
}

/**
 * Stores the synced columns of `row`, in place of those of the row with the
 * same ID if there is one. The other columns of a row that exists keep their
 * values.
 */
export function writeRow<Table extends TableName>(
  db: Database,
  table: Table,
  row: Row<Table>,
): void {
  const { table: into, columns }: Synced = synced[table];
  const fields: Record<string, unknown> = row;
  const values = Object.fromEntries(
    Object.keys(columns).map((column) => [column, fields[column]]),
  );
  db.insert(into)
    .values(values)
    .onConflictDoUpdate({ target: columns.id, set: values })
    .run();
}

/** Removes the row of `table` with this ID. Returns whether there was one. */
export function deleteRow(db: Database, table: TableName, id: string): boolean {
  const { table: from, columns }: Synced = synced[table];
  const deleted = db
    .delete(from)
    .where(eq(columns.id, id))
    .returning({ id: columns.id })
    .all();
  return deleted.length > 0;
}
