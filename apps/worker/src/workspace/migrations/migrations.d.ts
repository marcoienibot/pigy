// The types of migrations.js, which `drizzle-kit generate` writes: what the
// migrator of drizzle-orm/durable-sqlite takes.
declare const migrations: {
  journal: {
    entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
  };
  /** The SQL of each migration, under "m0000", "m0001" and so on. */
  migrations: Record<string, string>;
};

export default migrations;
