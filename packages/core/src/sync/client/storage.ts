import type { Change } from "../protocol.ts";
import type { Head, Step } from "./copy.ts";

/** A stored row, in the form of the change that brought it. */
export type StoredRow = Extract<Change, { op: "put" }>;

/** A copy as it is stored. */
export type StoredCopy = { head: Head; rows: StoredRow[] };

/**
 * Where a local copy is kept: IndexedDB in the browser. All the tabs of a
 * browser use the same one, so each of its two operations is a transaction
 * of the storage: `update` sees what the writes before it left, whichever
 * tab made them, and stores all of its own write or nothing.
 */
export interface ClientStorage {
  /** The copy as it is now, or nothing if there is none. */
  read(): Promise<StoredCopy | undefined>;

  /**
   * Changes the copy in one step. `step` is given the copy without its rows
   * and returns what to write, which is stored and handed back. If `step`
   * throws, nothing is stored and the error is passed on.
   *
   * `durable` asks for the write to be on disk before the promise resolves,
   * where the storage would otherwise leave that to the system.
   */
  update<Result>(
    step: (head: Head | undefined) => Step<Result>,
    options?: { durable?: boolean },
  ): Promise<Step<Result>>;
}
