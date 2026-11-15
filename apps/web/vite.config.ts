import { randomUUID } from "node:crypto";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { unstable_readConfig } from "wrangler";
import { serviceWorker } from "./service-worker-plugin.ts";

const workerConfig = "../worker/wrangler.jsonc";

/**
 * The paths that reach the Worker, read from where Cloudflare reads them.
 * The service worker must leave them alone, and gets the list from here,
 * so that a path which is added there cannot be forgotten here.
 */
function workerFirst(): string[] {
  const patterns = unstable_readConfig({ config: workerConfig }).assets
    ?.run_worker_first;
  if (!Array.isArray(patterns)) {
    throw new Error(
      `assets.run_worker_first in ${workerConfig} is not a list of paths. The service worker has to know which paths are the Worker's.`,
    );
  }
  return patterns;
}

/**
 * The port that `pnpm preview:e2e` serves the e2e build on:
 * `PIGY_E2E_PORT`, or 4173. `pnpm e2e` sets the variable for the server it
 * starts, see e2e/playwright.config.ts.
 */
function e2ePort(): number {
  const value = process.env.PIGY_E2E_PORT ?? "4173";
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`PIGY_E2E_PORT is "${value}", which is not a port`);
  }
  return port;
}

/**
 * Writes a new random ID into every e2e build, at /e2e-build.txt. The
 * browser tests compare what the server on their port serves there with
 * the file in this checkout's build, and so find out when they talk to the
 * build of another checkout: see e2e/server.ts. A digest of the build would
 * not tell them, because two checkouts of the same commit build the same
 * files. The production build has none, which scripts/check-build.mjs
 * checks by the text that the file begins with.
 */
function e2eBuildId(): Plugin {
  return {
    name: "pigy:e2e-build-id",
    apply: "build",
    // The Worker is built by the same command, as another environment.
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "e2e-build.txt",
        source: `pigy-e2e-build ${randomUUID()}`,
      });
    },
  };
}

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
    // Without `strictPort`, a port that is taken would be swapped for the
    // next one, where the browser tests do not look.
    ...(e2e && { preview: { port: e2ePort(), strictPort: true } }),
    plugins: [
      // Must come before the React plugin.
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      // Runs the Worker from apps/worker in the Workers runtime, on the same
      // port as the web app, in dev and in preview.
      cloudflare({
        configPath: workerConfig,
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
      ...(e2e ? [e2eBuildId()] : []),
      // Builds /sw.js once the web app is built. Not in `pnpm dev`.
      serviceWorker({ workerFirst: workerFirst() }),
    ],
    resolve: {
      // Resolves the "@/" alias from tsconfig.app.json.
      tsconfigPaths: true,
    },
  };
});
