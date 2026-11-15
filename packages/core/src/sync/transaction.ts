import type { Row, TableName } from "./tables.ts";

/**
 * What a mutator sees of the data: the synced tables of one workspace, and
 * the time. The server implements it over the workspace's database, where
 * its writes are what the other clients receive. A client implements it over
 * its local copy, to show a change before the server has confirmed it.
 *
 * Everything is synchronous, and a row that comes out is a copy: changing it
 * changes nothing until it is `put`.
 */
export interface Transaction {
  /**
   * The time of the mutation, in milliseconds since the Unix epoch. It is
   * the same for the whole mutation.
   */
  readonly now: number;

  /** The row with this ID, if there is one. */
  get<Table extends TableName>(
    table: Table,
    id: string,
  ): Row<Table> | undefined;

  /** The rows whose `column` is `value`, in no particular order. */
  find<Table extends TableName, Column extends keyof Row<Table>>(
    table: Table,
    column: Column,
    value: Row<Table>[Column],
  ): Row<Table>[];

  /** Stores `row`, in place of the row with the same ID if there is one. */
  put<Table extends TableName>(table: Table, row: Row<Table>): void;

  /** Removes the row with this ID. Does nothing if there is none. */
  delete(table: TableName, id: string): void;
}
