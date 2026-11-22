import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { build, type Plugin } from "vite";
import type { Build } from "./src/sw/build.ts";

/**
 * Builds the service worker, `src/sw/sw.ts`, into `sw.js` next to
 * `index.html`, after the web app has been built: the worker is told which
 * files that build has, and keeps them on the device.
 *
 * It is a build of its own, into one file with no imports, because a
 * service worker is loaded as a classic script and not as a module. And it
 * runs for a build only: `pnpm dev` has no service worker. There the files
 * come from the dev server one module at a time and change under hot
 * reload, so there is no list to keep, and a worker that answered from a
 * cache would get in the way of every edit.
 */
export function serviceWorker(options: {
  /**
   * The paths that belong to the Worker, as `assets.run_worker_first` has
   * them. The service worker leaves them to the network.
   */
  workerFirst: readonly string[];
}): Plugin {
  return {
    name: "pigy:service-worker",
    apply: "build",
    // The Worker is built by the same command, as another environment.
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle: {
      // After every other plugin has written what it writes.
      order: "post",
      sequential: true,
      async handler() {
        const { root, mode, build: target } = this.environment.config;
        const directory = join(root, target.outDir);
        const manifest: Build = {
          ...filesOf(directory),
          workerFirst: options.workerFirst,
        };
        await build({
          configFile: false,
          root,
          mode,
          logLevel: "warn",
          publicDir: false,
          define: { __BUILD__: JSON.stringify(manifest) },
          build: {
            outDir: directory,
            emptyOutDir: false,
            rolldownOptions: {
              input: join(root, "src/sw/sw.ts"),
              output: { format: "iife", entryFileNames: "sw.js" },
            },
          },
        });
        const size = statSync(join(directory, "sw.js")).size;
        this.info(
          `sw.js is ${(size / 1000).toFixed(2)} kB and keeps ${manifest.files.length} files`,
        );
      },
    },
  };
}

/**
 * What Cloudflare reads in the directory of the assets and serves the
 * files by: the headers of each, the content security policy of the app
 * shell among them, and where it redirects. It does not serve them.
 */
const rules = new Set(["_headers", "_redirects"]);

/**
 * What Cloudflare does not serve. The service worker itself is not a file
 * that it keeps, either.
 */
const notServed = new Set([...rules, "sw.js"]);

/**
 * The files of the build in `directory`, and the version they make.
 *
 * The version is a digest of the files and of the rules that they are
 * served by. The service worker keeps the app shell with the headers that
 * it was answered with, its content security policy among them, and a
 * browser installs a new service worker only when `sw.js` has changed:
 * without the rules, a release that changes only the policy would be the
 * same version, and a device would go on with the policy that it has.
 */
function filesOf(directory: string): Pick<Build, "version" | "files"> {
  const hash = createHash("sha256");
  const found = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
  const files = found.filter(
    // Files whose names begin with a dot are not served: Cloudflare's Vite
    // plugin writes `.assetsignore` here.
    (file) => !file.startsWith(".") && !notServed.has(file),
  );
  for (const file of [...files, ...found.filter((file) => rules.has(file))]) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(directory, file)));
  }
  // The server has every other page under an address without ".html", and
  // redirects to it. The service worker would not know what to keep.
  const pages = files.filter(
    (file) => file.endsWith(".html") && file !== "index.html",
  );
  if (pages.length > 0) {
    throw new Error(
      `The service worker keeps one page, index.html. The build also has ${pages.join(", ")}`,
    );
  }
  if (!files.includes("index.html")) {
    throw new Error(`${directory} has no index.html`);
  }
  return {
    version: hash.digest("hex").slice(0, 16),
    // The server has index.html at "/", and redirects to there.
    files: files.map((file) => (file === "index.html" ? "/" : `/${file}`)),
  };
}
