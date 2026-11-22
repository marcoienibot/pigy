import type { MiddlewareHandler } from "hono";
import { isLocal } from "./auth/config.ts";
import type { AppEnv } from "./env.ts";
import { reportingEndpoints, reportTo } from "./policy-reports.ts";

/**
 * The headers that say what a browser may do with an answer of the
 * Worker's. The files of the web app, the app shell among them, are not
 * answered here: apps/web/public/_headers has theirs.
 *
 * Every answer gets a content security policy, also one that no browser
 * shows as a page, so that a page which is added later starts from a
 * policy that allows nothing and not from none. The policy is the header
 * and nothing else: no tag is written into a page, which would hold only
 * where the page has a head to write it into, and only from there on.
 */

const always = {
  "X-Content-Type-Options": "nosniff",
  // Where a browser with the Reporting API sends what a policy refused:
  // `report-to` of the policies names this endpoint.
  "Reporting-Endpoints": reportingEndpoints,
  // As for the app shell: a full address within pigy, nothing to anybody
  // else. The Worker reads the origin of a form that a page of a simulated
  // network sends, which "no-referrer" would take away.
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), autoplay=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()",
};

// What every policy of the Worker ends with: nothing in a frame, no other
// base for the addresses of a page, and where to report what it refused.
const never = `base-uri 'none'; frame-ancestors 'none'; ${reportTo}`;

/**
 * For what is no page: JSON, a redirect, an error. Nothing in it is to be
 * run, loaded or shown in a frame, whatever a browser takes it for.
 */
export const dataPolicy = `default-src 'none'; form-action 'none'; ${never}`;

/**
 * For the bytes of an image, which a page of pigy shows as a picture and
 * a browser that is sent to their address saves: what is no page, and a
 * sandbox besides, so that a browser that shows them as a document of
 * their own gives that document no origin and runs nothing in it. A
 * route of an image sets it itself, and the middleware leaves it so.
 */
export const imagePolicy = `${dataPolicy}; sandbox`;

async function hashSource(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/**
 * The policy of a page that the Worker answers with and that says none of
 * its own. Such a page is what the pages of the simulations are: HTML with
 * a style sheet in its head and a form, and no script.
 *
 * - No script at all, inline or from a file.
 * - The style sheets that the page has in its head, each by its hash, and
 *   no other: not a `style` attribute, and not a `<style>` further down,
 *   where a page shows what others have written. The hashes are made of
 *   the page as it is answered, so they need no keeping. A page whose head
 *   has no end, `</head>`, gets none: nothing says where its own markup
 *   ends.
 * - A form is sent to pigy alone. A browser asks this of where the answer
 *   to a form redirects to as well: a simulated consent page sends the
 *   browser back to a callback of this pigy.
 * - Nothing else: no picture, no font, no request.
 *
 * A page that needs more says so itself, with a `Content-Security-Policy`
 * of its own, which is left as it is.
 */
export async function pagePolicy(html: string): Promise<string> {
  const end = html.search(/<\/head>/i);
  const head = end === -1 ? "" : html.slice(0, end);
  const sheets = [...head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  const hashes = await Promise.all(
    sheets.map(([, text = ""]) => hashSource(text)),
  );
  const styles = hashes.length > 0 ? `; style-src ${hashes.join(" ")}` : "";
  return `default-src 'none'${styles}; form-action 'self'; ${never}`;
}

/**
 * Adds the headers to every answer that has not got them: a route that
 * sets one of them has decided. A file of the web app that is passed on
 * comes with the ones of `_headers`, and is left as it is.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const answer = c.res;
    // The answer to the handshake of a WebSocket carries the socket, and
    // is no answer that a browser reads headers of.
    if (answer.status === 101 || c.get("passedOn")) return;

    const headers = new Headers(answer.headers);
    // An answer without a body is no page, whatever its type says: there
    // is nothing to read, and nothing to make one of for a status that
    // has none, such as 204 and 304.
    const page =
      headers.get("Content-Type")?.startsWith("text/html") === true &&
      !headers.has("Content-Security-Policy") &&
      answer.body !== null;
    // A page is read whole, for the hashes of its style sheets. It is
    // small: the Worker answers with no page that is not.
    const html = page ? await answer.text() : undefined;
    const defaults = {
      ...always,
      "Content-Security-Policy":
        html === undefined ? dataPolicy : await pagePolicy(html),
      // Over HTTPS at a deployed address alone: a browser is not to
      // remember anything about `localhost`.
      ...(c.req.url.startsWith("https:") &&
        !isLocal(new URL(c.req.url).origin) && {
          "Strict-Transport-Security": "max-age=31536000",
        }),
    };
    const missing = Object.entries(defaults).filter(
      ([name]) => !headers.has(name),
    );
    if (missing.length === 0) return;
    for (const [name, value] of missing) headers.set(name, value);
    c.res = undefined;
    c.res = new Response(html ?? answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    });
  };
}
