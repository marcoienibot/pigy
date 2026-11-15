/**
 * Where a simulated world keeps its state: values under keys, read and
 * written without waiting. A value is anything that can be cloned, and what
 * comes back is a copy.
 *
 * This is the shape of `ctx.storage.kv` of a Durable Object with SQLite, so
 * that the Worker can keep a world in one and pass that storage as it is.
 * Tests use `memoryStorage`.
 */
export type SimStorage = {
  /** The value under `key`, or undefined. */
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  /** Whether there was something to delete. */
  delete(key: string): boolean;
  /** The entries whose keys begin with `prefix`, in ascending order of key. */
  list(options: { prefix: string }): Iterable<[string, unknown]>;
};

// The order of a Durable Object's storage: by the UTF-8 form of the keys,
// which is the order of their code points.
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < left.length && index < right.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** A storage that lasts as long as the process. */
export function memoryStorage(): SimStorage {
  const entries = new Map<string, unknown>();
  return {
    // Copies in both directions, as a real storage makes them: a value that
    // is changed after it was put, or after it was read, must not change
    // what is stored.
    get: (key) => structuredClone(entries.get(key)),
    put: (key, value) => {
      entries.set(key, structuredClone(value));
    },
    delete: (key) => entries.delete(key),
    list: ({ prefix }) =>
      [...entries.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(byCodePoint)
        .map((key): [string, unknown] => [
          key,
          structuredClone(entries.get(key)),
        ]),
  };
}

/** Rows of one kind in a storage, each under an ID. */
export type Table<Row> = {
  get(id: string): Row | undefined;
  put(id: string, row: Row): void;
  delete(id: string): void;
  /** Every row, in ascending order of ID. */
  all(): Row[];
};

/**
 * The table `name` of `storage`. What it returns is typed as `Row` without
 * a check: a table is read by the code that wrote it, and by nobody else.
 */
export function table<Row>(storage: SimStorage, name: string): Table<Row> {
  const prefix = `${name}/`;
  return {
    get: (id) => storage.get(prefix + id) as Row | undefined,
    put: (id, row) => storage.put(prefix + id, row),
    delete: (id) => {
      storage.delete(prefix + id);
    },
    all: () => Array.from(storage.list({ prefix }), ([, row]) => row as Row),
  };
}
