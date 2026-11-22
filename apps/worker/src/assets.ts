import { Hono } from "hono";
import type { AppEnv } from "./env.ts";
import { handleNotFound } from "./errors.ts";

/**
 * Under `/assets`: the files that Vite names after their content, which
 * `_headers` lets a browser keep for a year. The Worker stands before them
 * for one reason. Cloudflare answers a path that it has no file for with
 * the app shell and the status 200, which is right for the address of a
 * screen and wrong here: a browser that asked for a script in the moment
 * in which a deploy replaced it would keep a page under the name of the
 * script, for a year. So a path without a file is answered with a 404
 * that nothing keeps, and a file is passed on as Cloudflare answers it,
 * with the headers of `_headers`.
 *
 * Nothing under `/assets` is a page, in any build: Vite puts no HTML
 * there, and service-worker-plugin.ts fails a build that has a second
 * page. So an answer that is HTML is the app shell.
 *
 * One answer is passed on that could be the app shell: a 304 to a browser
 * that asks whether what it holds under a path is still right. Only a
 * browser that holds the app shell under that path can get it, which is
 * one that kept it from before this route, and that one does not ask for
 * a year.
 */
export function assetRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/*", async (c) => {
    const answer = await c.env.ASSETS.fetch(c.req.raw);
    if (answer.headers.get("Content-Type")?.startsWith("text/html")) {
      // Not read, and not left open.
      await answer.body?.cancel();
      const missing = await handleNotFound(c);
      missing.headers.set("Cache-Control", "no-store");
      return missing;
    }
    c.set("passedOn", true);
    return answer;
  });

  return app;
}
