import { applyMutation } from "../mutators.ts";
import type { Row, TableName } from "../tables.ts";
import type { Transaction } from "../transaction.ts";
import type { MutationCall, Tables } from "./copy.ts";

/** A row of any table, or null for a row that was deleted. */
type Written = Map<TableName, Map<string, Row<TableName> | null>>;

/**
 * The `Transaction` of a mutation that is run for display. It reads the rows
 * of the server under what the mutations before it wrote, and keeps what it
 * writes to itself until `keep()`.
 *
 * The maps hold rows of any table by the name of the table, which the
 * compiler cannot follow. A row gets into one only through `put`, whose
 * signature ties it to its table, so the casts on the way out are sound.
 */
class ViewTransaction implements Transaction {
  private readonly own: Written = new Map();

  constructor(
    private readonly rows: Tables,
    private readonly written: Written,
    readonly now: number,
  ) {}

  get<Table extends TableName>(
    table: Table,
    id: string,
  ): Row<Table> | undefined {
    for (const layer of [this.own, this.written]) {
      const row = layer.get(table)?.get(id);
      if (row === null) return undefined;
      if (row) return { ...row } as Row<Table>;
    }
    const row = this.rows[table].get(id);
    return row && { ...row };
  }

  find<Table extends TableName, Column extends keyof Row<Table>>(
    table: Table,
    column: Column,
    value: Row<Table>[Column],
  ): Row<Table>[] {
    const found: Row<Table>[] = [];
    const seen = new Set<string>();
    const look = (id: string, row: Row<Table> | null) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (row && row[column] === value) found.push({ ...row });
    };
    for (const layer of [this.own, this.written]) {
      for (const [id, row] of layer.get(table) ?? []) {
        look(id, row as Row<Table> | null);
      }
    }
    for (const [id, row] of this.rows[table]) look(id, row);
    return found;
  }

  put<Table extends TableName>(table: Table, row: Row<Table>): void {
    this.layer(table).set(row.id, { ...row });
  }

  delete(table: TableName, id: string): void {
    // Not noted if there is nothing to delete, so that the table counts as
    // unchanged.
    if (this.get(table, id)) this.layer(table).set(id, null);
  }

  /** Adds what the mutation wrote to what the ones after it see. */
  keep(): void {
    for (const [table, rows] of this.own) {
      let written = this.written.get(table);
      if (!written) {
        written = new Map();
        this.written.set(table, written);
      }
      for (const [id, row] of rows) written.set(id, row);
    }
  }

  private layer(table: TableName) {
    let rows = this.own.get(table);
    if (!rows) {
      rows = new Map();
      this.own.set(table, rows);
    }
    return rows;
  }
}

/**
 * The latest time that a mutator has written into `rows`, 0 if there is
 * none. Mutators take the time from their transaction and keep it in these
 * columns: `createdAt` of a post and its `updatedAt`, which is that time or
 * a later one, when a channel was connected and its limits were read, and
 * when a target was asked for and sent. A mutator that writes the time of
 * its transaction to another column needs that column looked at here too.
 */
function latestTime(rows: Tables): number {
  let latest = 0;
  const look = (time: number | null) => {
    if (time !== null && time > latest) latest = time;
  };
  for (const { updatedAt } of rows.post.values()) look(updatedAt);
  for (const { connectedAt, limitsCheckedAt } of rows.channel.values()) {
    look(connectedAt);
    look(limitsCheckedAt);
  }
  for (const { queuedAt, sentAt } of rows.post_target.values()) {
    look(queuedAt);
    look(sentAt);
  }
  return latest;
}

/**
 * What to show: `rows`, which are the server's, after `mutations`, which
 * the server has not confirmed. This is step 5 of SYNC.md section 3. It is
 * computed from the server's rows every time, so a patch that changes them
 * moves the mutations on top of the new rows by itself.
 *
 * A mutation that its mutator refuses on these rows is left out, the way
 * the server will reject it. A table that no mutation writes to is the same
 * object as in `rows`.
 *
 * A mutation is run at the time it was made, by the clock of the device,
 * unless that is not after the latest time in `rows` and the time of the
 * mutation before it: then it is run one millisecond after the later of
 * the two. The server will run the mutations in this order, after
 * everything that it has confirmed, and by its own clock. So what it will
 * say of their order is known, and the view says the same before it does:
 * whatever is sorted by time stays in its order when a confirmation
 * arrives, on a device whose clock is behind the server's as on any other.
 * SYNC.md section 4 has the rule.
 */
export function viewOf(
  rows: Tables,
  mutations: readonly MutationCall[],
): Tables {
  const written: Written = new Map();
  let time = mutations.length > 0 ? latestTime(rows) : 0;
  for (const { name, args, at } of mutations) {
    time = Math.max(at, time + 1);
    const tx = new ViewTransaction(rows, written, time);
    try {
      // As the client that made it: what only the server may run is left
      // out here as the server will reject it.
      applyMutation(tx, name, args, "client");
    } catch {
      // Whatever it wrote before it gave up is dropped with `tx`.
      continue;
    }
    tx.keep();
  }
  if (written.size === 0) return rows;

  const view: Partial<Record<TableName, Map<string, Row<TableName>>>> = {};
  for (const [table, changed] of written) {
    const merged = new Map<string, Row<TableName>>(rows[table]);
    for (const [id, row] of changed) {
      if (row) merged.set(id, row);
      else merged.delete(id);
    }
    view[table] = merged;
  }
  return { ...rows, ...view } as Tables;
}
