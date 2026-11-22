import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hashSource,
  injectedStyles,
  inlineScripts,
  inlineScriptsOf,
  sonnerStyles,
  withHashes,
} from "./security-headers-plugin.ts";

const here = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8");

const headers = `/*\n  Content-Security-Policy: script-src 'self' ${inlineScripts}; style-src 'self' ${injectedStyles}\n`;
const page = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;
const theme = "\n  document.documentElement.classList.add('dark');\n";

describe("the hashes of the content security policy", () => {
  it("allows a script by the digest of its exact text", () => {
    // The example of the specification, CSP level 3, section 8.3: a browser
    // compares with this value, so the form has to be this one.
    expect(hashSource("alert('Hello, world.');")).toBe(
      "'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='",
    );
  });

  it("writes the hash of the script of the page and of the styles into the headers", () => {
    const written = withHashes(
      headers,
      page(
        `<script>${theme}</script><script type="module" src="/assets/index.js"></script>`,
      ),
      ["a{color:red}"],
    );

    const digest = (text: string) =>
      createHash("sha256").update(text).digest("base64");
    // The text between the tags with its line breaks, which a browser
    // hashes too. The script with a `src` is a file, and has no hash.
    expect(written).toBe(
      `/*\n  Content-Security-Policy: script-src 'self' 'sha256-${digest(theme)}'; style-src 'self' 'sha256-${digest("a{color:red}")}'\n`,
    );
  });

  it("follows a script that changes", () => {
    const before = withHashes(headers, page(`<script>${theme}</script>`), []);
    const after = withHashes(headers, page(`<script>${theme} </script>`), []);

    // One space more is another script to a browser.
    expect(after).not.toBe(before);
  });

  it("fails the build for a second inline script, and for none", () => {
    expect(() =>
      withHashes(
        headers,
        page(`<script>${theme}</script><script>track()</script>`),
        [],
      ),
    ).toThrow("index.html has 2 inline scripts");
    // The policy would then allow a hash of nothing, and somebody has
    // moved the theme without looking here.
    expect(() =>
      withHashes(headers, page('<script src="/a.js"></script>'), []),
    ).toThrow("index.html has 0 inline scripts");
  });

  it("fails the build for what the policy cannot allow by a hash", () => {
    const script = `<script>${theme}</script>`;
    expect(() =>
      withHashes(headers, page(`${script}<style>a{}</style>`), []),
    ).toThrow("a <style> element");
    expect(() =>
      withHashes(
        headers,
        page(script).replace("<body>", '<body style="x">'),
        [],
      ),
    ).toThrow("a style attribute");
    expect(() =>
      withHashes(
        headers,
        page(script).replace("<body>", '<body onload="go()">'),
        [],
      ),
    ).toThrow("an inline event handler");
  });

  it("fails the build when the headers have no place for the hashes", () => {
    const script = page(`<script>${theme}</script>`);
    // Somebody wrote a hash by hand: it would stay when the script changes.
    expect(() =>
      withHashes(headers.replace(inlineScripts, "'sha256-abc='"), script, []),
    ).toThrow(inlineScripts);
    expect(() =>
      withHashes(headers.replace(injectedStyles, ""), script, []),
    ).toThrow(injectedStyles);
  });

  it("reads the styles of the notice library as the script holds them", () => {
    // An escape of the code is one character of the style sheet.
    expect(
      sonnerStyles('x();__insertCSS("a{content:\\"\\\\2014\\"}");y()'),
    ).toBe('a{content:"\\2014"}');
    // Another version of the library, which adds its styles another way:
    // the policy would allow a text that is no longer added.
    expect(() => sonnerStyles("inject(`a{}`)")).toThrow("in 0 places");
  });
});

describe("the files of the app", () => {
  it("have one inline script and a place for its hash", () => {
    // What the build does with the two files as they are: it throws here
    // before it does in a build.
    const written = withHashes(here("public/_headers"), here("index.html"), [
      "a{}",
    ]);

    const [script] = inlineScriptsOf(here("index.html"));
    expect(script).toContain("pigy-theme");
    const policy = written
      .split("\n")
      .find((line) => line.includes("Content-Security-Policy:"));
    expect(policy).toContain(`script-src 'self' ${hashSource(script ?? "")};`);
    expect(policy).not.toContain("{{");
    // Nothing is allowed wholesale: no 'unsafe-inline', no 'unsafe-eval'.
    expect(policy).not.toContain("unsafe");
  });
});
