import {
  applyMutation,
  type Row,
  type TableName,
  type Transaction,
} from "../src/index.ts";

type Tables = { [Table in TableName]: Map<string, Row<Table>> };

/**
 * The synced tables of a workspace, held in memory, for the tests of the
 * mutators. It does what SYNC.md asks of whoever runs a mutator: rows are
 * copied on their way in and out, and a mutation that throws leaves nothing
 * behind.
 */
export function memoryWorkspace() {
  let tables: Tables = { post: new Map(), post_part: new Map() };

  const transaction = (now: number): Transaction => ({
    now,
    get: (table, id) => {
      const row = tables[table].get(id);
      return row && { ...row };
    },
    find: (table, column, value) =>
      [...tables[table].values()]
        .filter((row) => row[column] === value)
        .map((row) => ({ ...row })),
    put: (table, row) => {
      tables[table].set(row.id, { ...row });
    },
    delete: (table, id) => {
      tables[table].delete(id);
    },
  });

  return {
    /** Runs a mutation at the time `now`. */
    mutate(name: string, args: unknown, now = 0): void {
      const before = tables;
      tables = {
        post: new Map(before.post),
        post_part: new Map(before.post_part),
      };
      try {
        applyMutation(transaction(now), name, args);
      } catch (error) {
        tables = before;
        throw error;
      }
    },
    /** Stores a row as it is, without a mutator. */
    put<Table extends TableName>(table: Table, row: Row<Table>): void {
      tables[table].set(row.id, row);
    },
    rows<Table extends TableName>(table: Table): Row<Table>[] {
      return [...tables[table].values()];
    },
  };
}
