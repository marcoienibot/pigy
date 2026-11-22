import type { Build } from "./build.ts";
import { workerPaths } from "./worker-paths.ts";

/** What the service worker takes from its browser: `caches` and `fetch`. */
export type Platform = {
  caches: {
    open(name: string): Promise<{
      match(path: string): Promise<Response | undefined>;
      put(path: string, response: Response): Promise<void>;
    }>;
    /** In any of the caches. */
    match(path: string): Promise<Response | undefined>;
    keys(): Promise<string[]>;
    delete(name: string): Promise<boolean>;
  };
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  /** The origin of the app. */
  origin: string;
};

/**
 * Every cache of the app has a name that begins with this.
 *
 * A contract between the versions of the app, which must not change: a
 * service worker that takes over deletes the caches of the versions
 * before it, and it knows them by this prefix. Under another one it would
 * leave them on the device for good, and a page that asks whether the
 * worker keeps its build, with `keeps`, would be told of a build that
 * nothing answers from.
 */
const prefix = "pigy-app-";

const shell = "/";

/**
 * Where Vite puts the files that it names after their content. Such a file
 * never changes under its name, so a copy from any build is as good as the
 * server's. `public/_headers` gives the same paths a long life in the
 * caches of browsers.
 */
const named = "/assets/";

/**
 * Why `response` must not be kept as the file at `path`, or undefined if
 * it may be.
 *
 * The server answers every path that it has no file for with the app shell
 * and the status 200, so "200" does not say that a file is there. And a
 * service worker can be installing while the next version is deployed: it
 * then asks for the files of a build that the server no longer has. What
 * it keeps is what it later answers with, without a network to fall back
 * on, so it has to be the files of one build, all of them.
 */
export async function refusal(
  path: string,
  response: Response,
  files: ReadonlySet<string>,
): Promise<string | undefined> {
  if (!response.ok) return `the server answered ${response.status}`;
  // A file that the server has is not redirected, and a browser refuses a
  // redirected answer to a navigation.
  if (response.redirected) return "the server redirected";
  const html =
    response.headers.get("Content-Type")?.startsWith("text/html") ?? false;
  if (path !== shell) {
    return html ? "the server does not have the file" : undefined;
  }
  // The one file without a name of its own. It is this build's if all that
  // it loads is: its exact bytes are not asked for, because Cloudflare can
  // be set up to change a page on its way, and adds to it then.
  const loads = (await response.clone().text()).match(/\/assets\/[\w.-]+/g);
  if (!html || !loads) return "the server did not answer with the app shell";
  const missing = loads.find((file) => !files.has(file));
  return missing && `the app shell is of another version: it loads ${missing}`;
}

/**
 * Whether the service worker that answers for a page keeps the file at
 * `url`. That is how a page finds out whether the worker is of its own
 * build, with the script that it was started from: see
 * src/lib/service-worker.ts. `caches` are those of the page. They hold one
 * build of the app once a worker has taken over, because `activate` below
 * has deleted the others by then.
 */
export async function keeps(
  caches: Pick<Platform["caches"], "match">,
  url: string,
): Promise<boolean> {
  // By its path, which is what `install` keeps a file under.
  return (await caches.match(new URL(url).pathname)) !== undefined;
}

/**
 * The app shell and the files of one build, kept on the device so that the
 * app starts without a connection. They are in a cache of their own, named
 * after the build, and nothing else is kept: no answer of the API and no
 * synced data.
 */
export function precache(build: Build, { caches, fetch, origin }: Platform) {
  const name = `${prefix}${build.version}`;
  const files = new Set(build.files);
  const toWorker = workerPaths(build.workerFirst);

  /**
   * The path of the file that answers `request`, or undefined if the
   * request is not for the service worker to answer.
   */
  const fileFor = (request: Request): string | undefined => {
    if (request.method !== "GET") return undefined;
    const url = new URL(request.url);
    if (url.origin !== origin) return undefined;
    // Before the paths of the Worker: the Worker stands before the files
    // under /assets/ too, to say that one is not there, and passes on the
    // ones that are. A file of this build is this build's wherever it is.
    if (files.has(url.pathname)) return url.pathname;
    if (toWorker(url.pathname)) return undefined;
    // Every other address is a screen of the app, which the shell shows.
    // That goes for a navigation only: a script that asks for a file that
    // is not there must not be handed a page.
    return request.mode === "navigate" ? shell : undefined;
  };

  return {
    /**
     * Fills the cache of this build, or fails: a service worker that has
     * not got every file must not be installed. One that fails leaves
     * nothing behind, or the files of every release that could not be
     * installed would stay on the device until a later one takes over.
     */
    async install(): Promise<void> {
      // The worker that is active can be of this build and answer from
      // this cache: a build is named after the files of the app, and a
      // release that changes only the service worker has the same ones.
      const existed = (await caches.keys()).includes(name);
      const cache = await caches.open(name);
      // Every file is seen to its end, also once one of them has failed,
      // so that nothing is written after the cache has been deleted.
      const written = await Promise.allSettled(
        build.files.map(async (path) => {
          // What a build before this one has kept under the same name
          // spares the download, so an update costs what has changed.
          const kept = path.startsWith(named) && (await caches.match(path));
          if (kept) return cache.put(path, kept);
          // "no-cache" has the browser ask the server whether what it holds
          // is still right. It may hold the app shell in place of a file,
          // which `refusal` is about, and for as long as `_headers` says.
          const response = await fetch(path, { cache: "no-cache" });
          const reason = await refusal(path, response, files);
          if (reason) throw new Error(`Cannot keep ${path}: ${reason}`);
          return cache.put(path, response);
        }),
      );
      const failed = written.find((file) => file.status === "rejected");
      if (!failed) return;
      // A cache that was there before is not this install's to delete: the
      // app may be running from it.
      if (!existed) await caches.delete(name);
      throw failed.reason;
    },

    /** Deletes what the builds before this one have kept. */
    async activate(): Promise<void> {
      for (const other of await caches.keys()) {
        if (other.startsWith(prefix) && other !== name) {
          await caches.delete(other);
        }
      }
    },

    /**
     * The answer to `request` from the cache, or undefined if the request
     * goes to the network as if there were no service worker: everything
     * that is not a file of the app, and above all the paths of the Worker.
     */
    answer(request: Request): Promise<Response> | undefined {
      const path = fileFor(request);
      if (path === undefined) return undefined;
      return (
        caches
          .open(name)
          .then((cache) => cache.match(path))
          // The browser, or the person, has emptied the cache.
          .then((kept) => kept ?? fetch(request))
      );
    },
  };
}
