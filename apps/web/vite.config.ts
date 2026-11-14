import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  // The mode of `pnpm preview:e2e` and of the build that the end-to-end
  // tests run against. The Worker is built with a simulated Google in this
  // mode, see apps/worker/src/index.ts. The build has its own directory, so
  // that `dist` only ever holds a production build, and its own database.
  const e2e = mode === "e2e";

  return {
    build: {
      outDir: e2e ? "dist-e2e" : "dist",
    },
    plugins: [
      // Must come before the React plugin.
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      // Runs the Worker from apps/worker in the Workers runtime, on the same
      // port as the web app, in dev and in preview.
      cloudflare({
        configPath: "../worker/wrangler.jsonc",
        // Local D1, Durable Object and R2 data lives next to the Worker's
        // config, where the wrangler CLI reads and writes it too.
        persistState: {
          path: e2e
            ? "../worker/.wrangler/state-e2e"
            : "../worker/.wrangler/state",
        },
        // Declaring which secrets the Worker takes makes wrangler read only
        // those from apps/worker/.dev.vars. The e2e build declares none, so
        // that it behaves the same on every machine, whatever is in that
        // file.
        ...(e2e && { config: { secrets: { required: [] } } }),
      }),
    ],
    resolve: {
      // Resolves the "@/" alias from tsconfig.app.json.
      tsconfigPaths: true,
    },
  };
});
