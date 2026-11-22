import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { serviceWorker } from "./service-worker-plugin.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * A build of the web app as Vite leaves it before the service worker is
 * built: the app shell, a file that it loads, and `_headers` with the
 * rules that Cloudflare serves them by.
 */
function builtApp(headers: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pigy-sw-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "assets"));
  writeFileSync(
    join(directory, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-a1.js"></script>',
  );
  writeFileSync(join(directory, "assets/index-a1.js"), "export {};");
  writeFileSync(join(directory, "_headers"), headers);
  return directory;
}

/** The `sw.js` that the plugin builds for the app in `directory`. */
async function serviceWorkerOf(directory: string): Promise<string> {
  const { writeBundle } = serviceWorker({ workerFirst: ["/api/*"] });
  const { handler } = writeBundle as unknown as {
    handler: (this: unknown) => Promise<void>;
  };
  // What the plugin reads of the build that it follows, as Vite hands it.
  await handler.call({
    environment: {
      config: {
        root,
        mode: "production",
        build: { outDir: relative(root, directory) },
      },
    },
    info: () => {},
  });
  return readFileSync(join(directory, "sw.js"), "utf8");
}

const policy = (images: string) =>
  `/*\n  Content-Security-Policy: default-src 'none'; img-src ${images}\n`;

describe("the version of a build", () => {
  it("is a new one when the policy of `_headers` is all that has changed", async () => {
    const before = await serviceWorkerOf(builtApp(policy("'self' https:")));

    // The same build made again is the same version: what follows is not
    // a difference that every build has.
    expect(await serviceWorkerOf(builtApp(policy("'self' https:")))).toBe(
      before,
    );
    // The files of the app are the same, byte for byte, and the app shell
    // goes with another policy. The service worker keeps the app shell
    // with the headers that it was answered with, and a browser installs
    // a new one only where `sw.js` has changed: a device would go on with
    // the policy that it has.
    expect(await serviceWorkerOf(builtApp(policy("'self'")))).not.toBe(before);
  });

  it("does not keep `_headers`, which Cloudflare does not serve", async () => {
    const worker = await serviceWorkerOf(builtApp(policy("'self'")));

    expect(worker).toContain("/assets/index-a1.js");
    expect(worker).not.toContain("_headers");
  });
});
