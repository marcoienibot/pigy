// Makes the icons of the web app from assets/icon.svg, into
// apps/web/public. Run it with `pnpm icons` after the icon has changed, and
// commit what it writes.
//
// The icon is drawn by the Chromium that the end-to-end tests run in, which
// is why this script lives here: no other package has a browser. Nothing
// is fetched.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = new URL("../../", import.meta.url);
const source = fileURLToPath(new URL("assets/icon.svg", root));
const publicDirectory = new URL("apps/web/public/", root);

// The icon names the font of the system for its letter, and that differs
// from one machine to the next: on the one that runs this script it may be
// a font that no phone has. The letter is drawn in the font of the app
// instead, so that the script writes the same files everywhere.
const font = createRequire(new URL("apps/web/package.json", root)).resolve(
  "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
);

/**
 * `bleed`: without the rounded corners, as a square that is filled to its
 * edges. A phone cuts such an icon to the shape it likes, and would show
 * corners that are transparent in black or white.
 */
const icons = [
  // What the manifest names: Chrome asks for these two sizes.
  { file: "icons/icon-192.png", size: 192, bleed: false },
  { file: "icons/icon-512.png", size: 512, bleed: false },
  // For Android, which cuts its own shape out of it. The letter is well
  // inside the circle in the middle that every shape keeps, 80% of the
  // width.
  { file: "icons/icon-maskable-512.png", size: 512, bleed: true },
  // For the Home Screen of iOS, which rounds the corners itself and takes
  // no transparency.
  { file: "icons/apple-touch-icon.png", size: 180, bleed: true },
];

const svg = readFileSync(source, "utf8");
const fontData = readFileSync(font).toString("base64");
mkdirSync(new URL("icons/", publicDirectory), { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size, bleed } of icons) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html>
      <style>
        @font-face {
          font-family: "Icon";
          font-weight: 100 900;
          src: url("data:font/woff2;base64,${fontData}");
        }
        html, body { margin: 0; }
        svg { display: block; width: ${size}px; height: ${size}px; }
        svg text { font-family: "Icon"; }
        ${bleed ? "svg rect { rx: 0; }" : ""}
      </style>
      ${svg}`);
    // The letter is drawn in a fallback font until its own has loaded.
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].every((face) => face.status === "loaded");
    });
    if (!loaded) throw new Error("The font of the icon did not load");
    await page.screenshot({
      path: fileURLToPath(new URL(file, publicDirectory)),
      omitBackground: true,
    });
    console.log(`apps/web/public/${file}`);
  }
} finally {
  await browser.close();
}

// The icon itself, for browser tabs and for the app's own pages.
copyFileSync(source, new URL("icon.svg", publicDirectory));
console.log("apps/web/public/icon.svg");
