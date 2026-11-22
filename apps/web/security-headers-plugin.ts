import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/**
 * Where `public/_headers` names what the content security policy allows by
 * its hash: the build writes the hashes there. Nobody keeps one by hand,
 * so a script that changes cannot leave its hash behind.
 */
export const inlineScripts = "{{inline-scripts}}";
export const injectedStyles = "{{injected-styles}}";

/** A source of a content security policy that allows exactly `text`. */
export function hashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

/**
 * The scripts that `html` has written into it, which a policy allows only
 * by their hash: the text between the tags, byte for byte.
 */
export function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes = ""]) => !/\bsrc\s*=/i.test(attributes))
    .map(([, , text = ""]) => text);
}

/**
 * `headers`, the `_headers` of the web app, with the hashes in the place of
 * its two placeholders: those of the scripts that are written into `html`,
 * the app shell, and those of `styles`, the style sheets that a library
 * of the app adds to the page as it runs.
 *
 * It throws where the policy could not hold for the page: the build fails
 * then. That is for whoever changes index.html: what a page has inline
 * is decided there and here together.
 */
export function withHashes(
  headers: string,
  html: string,
  styles: readonly string[],
): string {
  const scripts = inlineScriptsOf(html);
  // The theme, before the first paint: AGENTS.md, "Rules". A second one
  // would be allowed by its hash as well, so it has to be meant.
  if (scripts.length !== 1) {
    throw new Error(
      `index.html has ${scripts.length} inline scripts. The content security policy allows one, the script that sets the theme, by its hash: load any other from a file, or change security-headers-plugin.ts.`,
    );
  }
  // None of these can be allowed by a hash that is worth anything: the
  // policy has no 'unsafe-inline', and the browser would drop them.
  const refused = [
    [/<style\b/i, "a <style> element"],
    [/<[^>]*\sstyle\s*=/i, "a style attribute"],
    [/<[^>]*\son[a-z]+\s*=/i, "an inline event handler"],
  ] as const;
  for (const [pattern, what] of refused) {
    if (pattern.test(html)) {
      throw new Error(
        `index.html has ${what}, which the content security policy of public/_headers does not allow.`,
      );
    }
  }
  for (const placeholder of [inlineScripts, injectedStyles]) {
    // Without the placeholder the policy would name no hash, or one that
    // somebody wrote by hand, and the page would lose what it has inline.
    if (headers.split(placeholder).length !== 2) {
      throw new Error(
        `public/_headers must have ${placeholder} exactly once, in its Content-Security-Policy: the build writes the hashes there.`,
      );
    }
  }
  return headers
    .replace(inlineScripts, scripts.map(hashSource).join(" "))
    .replace(injectedStyles, styles.map(hashSource).join(" "));
}

/**
 * The style sheet that the notice library, sonner, adds to the page when
 * it is loaded: one `<style>` element, whose text is a string of its code.
 * The policy allows that text by its hash, which is why it is read here,
 * from the file that the app is built from.
 */
export function sonnerStyles(code: string): string {
  const found = [...code.matchAll(/__insertCSS\("((?:[^"\\]|\\.)*)"\)/g)];
  const [only] = found;
  if (found.length !== 1 || !only) {
    throw new Error(
      `sonner adds its styles to the page in ${found.length} places, where security-headers-plugin.ts knows one. Read how the installed version does it and bring the plugin up to it.`,
    );
  }
  // The text as the script has it once it runs: a string of JavaScript,
  // which is read as one of JSON. That holds while it has no escape that
  // only JavaScript has, and `JSON.parse` throws where it does not.
  return JSON.parse(`"${only[1]}"`);
}

function installedSonnerStyles(root: string): string {
  const entry = createRequire(join(root, "package.json")).resolve("sonner");
  // The module that Vite bundles, next to the one that Node resolves to.
  return sonnerStyles(readFileSync(join(dirname(entry), "index.mjs"), "utf8"));
}

/**
 * Writes into `_headers` of a build the hashes that its content security
 * policy allows inline code by: see `withHashes`. Not in `pnpm dev`, which
 * has no `_headers` and no policy: the dev server adds scripts of its own
 * to the page.
 */
export function securityHeaders(): Plugin {
  return {
    name: "pigy:security-headers",
    apply: "build",
    // The Worker is built by the same command, as another environment.
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle: {
      // After Vite has written index.html and copied `public`.
      order: "post",
      sequential: true,
      handler() {
        const { root, build } = this.environment.config;
        const directory = join(root, build.outDir);
        const file = join(directory, "_headers");
        writeFileSync(
          file,
          withHashes(
            readFileSync(file, "utf8"),
            readFileSync(join(directory, "index.html"), "utf8"),
            // The library adds its `<style>` element to the page empty
            // and then gives it its text, and the browser asks about
            // both: an empty style sheet, and the one of the library.
            ["", installedSonnerStyles(root)],
          ),
        );
      },
    },
  };
}
