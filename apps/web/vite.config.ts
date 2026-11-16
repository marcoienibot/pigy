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
 * Where `pnpm preview:e2e` serves the e2e build: at 127.0.0.1, on the port
 * of `PIGY_E2E_PORT`, or 4173 when it is unset. Port 0 has the system choose
 * a port, and Vite says in its output which one: that is how `pnpm e2e`
 * learns its port when it is given none, see e2e/playwright.config.ts.
 *
 * One address and not `localhost`, which can be 127.0.0.1 or ::1: the
 * browser of the tests is made to go to 127.0.0.1 alone, so the server has
 * to be there, and a server at ::1 on the same port is never asked.
 * Without `strictPort`, a port that is taken would be swapped for the next
 * one, where the browser tests do not look.
 */
function e2ePreview() {
  const value = process.env.PIGY_E2E_PORT ?? "4173";
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(`PIGY_E2E_PORT is "${value}", which is not a port`);
  }
  return { host: "127.0.0.1", port, strictPort: true };
}

/**
 * Writes a new random ID into every e2e build, at /e2e-build.txt, and says
 * it in the output of the build. The browser tests take the ID from that
 * output and compare it with what the server on their port serves there,
 * and with the file in this checkout's build, and so find out when they
 * talk to the build of another checkout, or when their own was built over:
 * see e2e/server.ts. A digest of the build would not tell them, because two
 * checkouts of the same commit build the same files. The production build
 * has none, which scripts/check-build.mjs checks by the text that the ID
 * begins with.
 */
function e2eBuildId(): Plugin {
  const id = `pigy-e2e-build ${randomUUID()}`;
  return {
    name: "pigy:e2e-build-id",
    apply: "build",
    // The Worker is built by the same command, as another environment.
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "e2e-build.txt", source: id });
    },
    writeBundle() {
      // e2e/playwright.config.ts reads this line.
      console.log(`The ID of this e2e build is "${id}".`);
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
    ...(e2e && { preview: e2ePreview() }),
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
