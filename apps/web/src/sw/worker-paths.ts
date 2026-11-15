/**
 * Which paths belong to the Worker, by the patterns of
 * `assets.run_worker_first` in apps/worker/wrangler.jsonc. The build reads
 * them from that file, so the service worker and Cloudflare go by one list.
 *
 * A request for such a path is never answered here: it is the Worker that
 * knows who is signed in, and a navigation to one of them, such as the
 * callback of a sign-in, must reach it and not get the app shell.
 *
 * The patterns mean what they mean to Cloudflare, whose matcher this
 * follows (`generateStaticRoutingRuleMatcher` in workers-sdk): a pattern is
 * matched against the whole path, `*` stands for any text, slashes
 * included, and a pattern that begins with `!` takes paths out again that
 * another pattern covers.
 */
export function workerPaths(
  patterns: readonly string[],
): (pathname: string) => boolean {
  const expression = (pattern: string) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((text) => text.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&"))
        .join(".*")}$`,
    );
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => expression(pattern.slice(1)));
  const included = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(expression);

  return (pathname) =>
    !excluded.some((pattern) => pattern.test(pathname)) &&
    included.some((pattern) => pattern.test(pathname));
}
