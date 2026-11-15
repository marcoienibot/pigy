import { expect, it } from "vitest";
import { workerPaths } from "./worker-paths.ts";

// What apps/worker/wrangler.jsonc has.
const pigy = workerPaths(["/api/*", "/connect/*", "/sim/*", "/sync/*"]);

it.each([
  "/api/me",
  // `*` goes across slashes.
  "/api/auth/google/callback",
  "/connect/mastodon/callback",
  "/sim/google/authorize",
  "/sync/0192f0e6-7a55-7000-8000-000000000001",
  // Nothing after the slash is still something that the pattern covers.
  "/api/",
])("%s is the Worker's", (pathname) => {
  expect(pigy(pathname)).toBe(true);
});

it.each([
  "/",
  "/queue",
  "/assets/index-abc.js",
  // The pattern is "/api/*", and Cloudflare gives a path without the slash
  // to the app like any other.
  "/api",
  // A pattern covers the whole path: it is not looked for inside one, and
  // not at the start of a longer name.
  "/apis/me",
  "/settings/api/keys",
])("%s is the app's", (pathname) => {
  expect(pigy(pathname)).toBe(false);
});

it("takes out what a pattern with ! names", () => {
  const paths = workerPaths(["/api/*", "!/api/docs/*"]);

  expect(paths("/api/docs/posts")).toBe(false);
  expect(paths("/api/posts")).toBe(true);
  // Whatever the order of the patterns, as for Cloudflare.
  expect(workerPaths(["!/api/docs/*", "/api/*"])("/api/docs/posts")).toBe(
    false,
  );
});

it("reads everything but * as it is written", () => {
  // In a regular expression, the dot would stand for any character and the
  // parentheses for nothing.
  const paths = workerPaths(["/v1.0/(beta)/*"]);

  expect(paths("/v1.0/(beta)/posts")).toBe(true);
  expect(paths("/v1x0/(beta)/posts")).toBe(false);
  expect(paths("/v1.0/beta/posts")).toBe(false);
});

it("takes a pattern without * for one path", () => {
  const paths = workerPaths(["/healthz"]);

  expect(paths("/healthz")).toBe(true);
  expect(paths("/healthz/now")).toBe(false);
});

it("gives the Worker nothing when there are no patterns", () => {
  expect(workerPaths([])("/api/me")).toBe(false);
});
