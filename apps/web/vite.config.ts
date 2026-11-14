import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
      persistState: { path: "../worker/.wrangler/state" },
    }),
  ],
  resolve: {
    // Resolves the "@/" alias from tsconfig.app.json.
    tsconfigPaths: true,
  },
});
