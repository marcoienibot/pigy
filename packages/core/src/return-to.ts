// Any origin works here. It only gives relative addresses something to be
// resolved against, and ".invalid" can never be a real host.
const base = "https://pigy.invalid";

/**
 * The address to send someone to after sign-in: `returnTo` if it is a path
 * within pigy, the home page otherwise. Sign-in must not become a way to
 * send people to another site.
 */
export function safeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo?.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(returnTo, base);
  } catch {
    return "/";
  }
  // Parsed the way a browser would, so that everything a browser reads as
  // another host is caught: "//host", "/\host", and the same with a tab or a
  // newline in between, which browsers drop.
  if (url.origin !== base) return "/";
  // The parsed form is returned, so that what was checked is what is used.
  const path = url.pathname + url.search + url.hash;
  // Parsing removes "." and ".." segments, which turns "/.//host" into
  // "//host": a path here, but another host once a browser resolves it.
  if (path.startsWith("//")) return "/";
  return path;
}
