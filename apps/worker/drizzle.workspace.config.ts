import { defineConfig } from "drizzle-kit";

// For the database inside the workspace's Durable Object. With this driver,
// `drizzle-kit generate` also writes migrations.js, which imports the SQL
// files: src/workspace/store.ts imports it, so the migrations are bundled
// into the Worker.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/workspace/schema.ts",
  out: "./src/workspace/migrations",
});
