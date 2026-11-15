import { defineConfig } from "drizzle-kit";

// For D1. Only `drizzle-kit generate` is used: it turns src/db/schema.ts into
// SQL files. Wrangler applies them, see "migrations_dir" in wrangler.jsonc.
// drizzle.workspace.config.ts is the same for the workspace's Durable Object.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
