import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` is used: it turns src/db/schema.ts into SQL
// files. Wrangler applies them, see "migrations_dir" in wrangler.jsonc.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
