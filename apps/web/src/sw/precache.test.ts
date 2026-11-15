import { describe, expect, it } from "vitest";
import type { Build } from "./build.ts";
import { type Platform, precache, refusal } from "./precache.ts";

const origin = "https://pigy.example";

/** The page that loads `assets`, as the build writes index.html. */
function shellOf(...assets: string[]): string {
  return `<!doctype html><html><head>${assets
    .map((asset) =>
      asset.endsWith(".css")
        ? `<link rel="stylesheet" href="${asset}">`
        : `<script type="module" src="${asset}"></script>`,
    )
    .join("")}</head><body><div id="root"></div></body></html>`;
}

const types: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};

/**
 * A server that has `files`, by path and with the app shell at "/". It
 * answers as Cloudflare does for pigy: a path without a file gets the app
 * shell and the status 200.
 */
function server(files: Record<string, string>) {
  const requests: { path: string; cache: RequestCache | undefined }[] = [];
  const fetch: Platform["fetch"] = async (input, init) => {
    const path =
      typeof input === "string" ? input : new URL(input.url).pathname;
    requests.push({ path, cache: init?.cache });
    const body = files[path];
    return body === undefined || path === "/"
      ? new Response(files["/"], {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      : new Response(body, {
          headers: {
            "Content-Type": types[path.split(".").at(-1) ?? ""] ?? "",
          },
        });
  };
  return { fetch, requests };
}

/** The caches of a browser, in memory. */
function browserCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const caches: Platform["caches"] = {
    async open(name) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (path) => store.get(path)?.clone(),
        put: async (path, response) => {
          store.set(path, response);
        },
      };
    },
    async match(path) {
      for (const store of stores.values()) {
        const kept = store.get(path);
        if (kept) return kept.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };

  return {
    caches,
    names: () => [...stores.keys()],
    /** What the cache `name` holds, by path. */
    async contents(name: string): Promise<Record<string, string>> {
      const contents: Record<string, string> = {};
      for (const [path, response] of stores.get(name) ?? []) {
        contents[path] = await response.clone().text();
      }
      return contents;
    },
    /** Puts `files` into the cache `name`, as a build before has. */
    keep(name: string, files: Record<string, string>): void {
      stores.set(
        name,
        new Map(
          Object.entries(files).map(([path, body]) => [
            path,
            new Response(body),
          ]),
        ),
      );
    },
  };
}

/**
 * A request as a service worker is handed it. `new Request()` cannot make
 * one for a navigation: that mode is the browser's to set.
 */
function request(
  address: string,
  { mode = "navigate", method = "GET" } = {},
): Request {
  return { url: new URL(address, origin).href, mode, method } as Request;
}

const files = {
  "/": shellOf("/assets/index-222.js", "/assets/index-222.css"),
  "/assets/index-222.js": "console.log('app 2')",
  "/assets/index-222.css": "body { color: teal }",
  "/assets/queue-222.js": "console.log('queue 2')",
  "/icon.svg": "<svg>2</svg>",
};

const build: Build = {
  version: "2",
  files: Object.keys(files),
  workerFirst: ["/api/*", "/sim/*", "/sync/*"],
};

describe("installing", () => {
  it("keeps every file of the build in a cache of its own", async () => {
    const { fetch, requests } = server(files);
    const browser = browserCaches();

    await precache(build, { caches: browser.caches, fetch, origin }).install();

    expect(await browser.contents("pigy-app-2")).toEqual(files);
    // Each file was asked of the server, whatever the browser's own cache
    // holds: under a path of /assets/ that can be the app shell, kept for
    // a year, from a moment at which the server did not have the file.
    expect(requests.map(({ path }) => path).sort()).toEqual(
      Object.keys(files).sort(),
    );
    expect(new Set(requests.map(({ cache }) => cache))).toEqual(
      new Set(["no-cache"]),
    );
  });

  it("fails when the server does not have a file of the build", async () => {
    // The next version was deployed while this one was installing, and its
    // lazy chunk has another name.
    const { "/assets/queue-222.js": _gone, ...left } = files;
    const { fetch } = server({ ...left, "/assets/queue-333.js": "queue 3" });
    const browser = browserCaches();

    // The server answers 200 for the missing file, with the app shell. Kept
    // as the file, that would be what the app gets for its script offline.
    await expect(
      precache(build, { caches: browser.caches, fetch, origin }).install(),
    ).rejects.toThrow(
      "Cannot keep /assets/queue-222.js: the server does not have the file",
    );
  });

  it("fails when the app shell of the server is that of another build", async () => {
    const { fetch } = server({
      ...files,
      // The files of this build are all still there, as they are when the
      // next build has changed only the styles.
      "/": shellOf("/assets/index-222.js", "/assets/index-333.css"),
      "/assets/index-333.css": "body { color: red }",
    });
    const browser = browserCaches();

    // Kept, this shell would load a stylesheet that the cache does not
    // have: the app would start without its styles when offline.
    await expect(
      precache(build, { caches: browser.caches, fetch, origin }).install(),
    ).rejects.toThrow(
      "Cannot keep /: the app shell is of another version: it loads /assets/index-333.css",
    );
  });

  it("takes an app shell that was changed on its way, if it loads this build", async () => {
    // Cloudflare can be set up to add to the pages that pass through it,
    // its analytics for example. The shell is still this build's.
    const shell = files["/"].replace(
      "</body>",
      '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></body>',
    );
    const { fetch } = server({ ...files, "/": shell });
    const browser = browserCaches();

    await precache(build, { caches: browser.caches, fetch, origin }).install();

    expect((await browser.contents("pigy-app-2"))["/"]).toBe(shell);
  });

  it("copies what a build before it has kept under a name that says its content", async () => {
    const next = {
      ...files,
      // The same name as in the build before, so the same file.
      "/assets/vendor-111.js": "console.log('vendor')",
    };
    const { fetch, requests } = server(next);
    const browser = browserCaches();
    browser.keep("pigy-app-1", {
      "/": shellOf("/assets/index-111.js"),
      "/assets/vendor-111.js": "console.log('vendor')",
      "/icon.svg": "<svg>1</svg>",
    });

    await precache(
      { ...build, files: Object.keys(next) },
      { caches: browser.caches, fetch, origin },
    ).install();

    expect(await browser.contents("pigy-app-2")).toEqual(next);
    const asked = requests.map(({ path }) => path);
    expect(asked).not.toContain("/assets/vendor-111.js");
    // The shell and the icon have the same name in every build, and what
    // the build before kept of them is that build's: they are fetched.
    expect(asked).toContain("/");
    expect(asked).toContain("/icon.svg");
    // The build before is still in use, by the pages that it loaded.
    expect((await browser.contents("pigy-app-1"))["/icon.svg"]).toBe(
      "<svg>1</svg>",
    );
  });
});

describe("what may be kept", () => {
  const names = new Set(build.files);
  const script = (init?: ResponseInit) =>
    new Response("console.log('app')", {
      headers: { "Content-Type": "text/javascript" },
      ...init,
    });

  it("is not an answer that says that something went wrong", async () => {
    expect(
      await refusal("/assets/index-222.js", script({ status: 503 }), names),
    ).toBe("the server answered 503");
  });

  it("is not a redirected answer", async () => {
    // What a proxy in front of the server makes of a request when it wants
    // the person to sign in first, for example. The page that it leads to
    // answers 200, and is not the file.
    const response = script();
    Object.defineProperty(response, "redirected", { value: true });

    expect(await refusal("/assets/index-222.js", response, names)).toBe(
      "the server redirected",
    );
  });

  it("is not a page without a file of the app in it, as the app shell", async () => {
    const page = new Response(
      "<html><body>Sign in to the Wi-Fi</body></html>",
      {
        headers: { "Content-Type": "text/html" },
      },
    );

    expect(await refusal("/", page, names)).toBe(
      "the server did not answer with the app shell",
    );
  });

  it("is a file that the server has", async () => {
    expect(await refusal("/assets/index-222.js", script(), names)).toBe(
      undefined,
    );
  });
});

describe("taking over", () => {
  it("deletes the caches of the builds before it, and no others", async () => {
    const { fetch } = server(files);
    const browser = browserCaches();
    browser.keep("pigy-app-1", { "/": shellOf("/assets/index-111.js") });
    // Not a cache of the app shell: phase 9 may keep things of its own.
    browser.keep("shared-files", { "/shared/1": "a photo" });
    const app = precache(build, { caches: browser.caches, fetch, origin });
    await app.install();

    await app.activate();

    expect(browser.names().sort()).toEqual(["pigy-app-2", "shared-files"]);
  });
});

describe("answering", () => {
  async function installed() {
    const { fetch, requests } = server(files);
    const browser = browserCaches();
    const app = precache(build, { caches: browser.caches, fetch, origin });
    await app.install();
    requests.length = 0;
    return { app, browser, requests };
  }

  it.each([
    ["the address of a screen", "/queue"],
    ["the start of the app", "/"],
    [
      "an address with a search",
      "/?draft=0192f0e6-7a55-7000-8000-000000000001",
    ],
    ["an address that no screen has", "/no/such/page"],
    // Cloudflare redirects this one to "/".
    ["the file of the app shell", "/index.html"],
  ])(
    "answers a navigation to %s with the app shell",
    async (_name, address) => {
      const { app, requests } = await installed();

      const answer = await app.answer(request(address));

      expect(await answer?.text()).toBe(files["/"]);
      // From the device, without asking the server.
      expect(requests).toEqual([]);
    },
  );

  it.each([
    ["a script asks for it", "/assets/queue-222.js", "cors"],
    ["a stylesheet is loaded", "/assets/index-222.css", "no-cors"],
    ["it has a search", "/assets/queue-222.js?import", "cors"],
    // The file itself, not the app around a "not found".
    ["it is opened in a tab", "/icon.svg", "navigate"],
  ])(
    "answers with a file of the build when %s",
    async (_name, address, mode) => {
      const { app, requests } = await installed();

      const answer = await app.answer(request(address, { mode }));

      expect(await answer?.text()).toBe(
        files[new URL(address, origin).pathname as keyof typeof files],
      );
      expect(requests).toEqual([]);
    },
  );

  it.each([
    // The callback of a sign-in is a navigation, and so is every page of
    // the simulated Google. The app shell in their place would leave the
    // person signed out, on a "not found".
    ["a navigation to the API", "/api/auth/google/callback?code=1", "navigate"],
    [
      "a navigation to a simulated service",
      "/sim/google/authorize",
      "navigate",
    ],
    ["a navigation to the sync endpoint", "/sync/0192f0e6", "navigate"],
    ["a request to the API", "/api/me", "cors"],
    // A script that is handed a page fails in a way that says nothing. The
    // file of a build before this one is not this build's to answer for.
    [
      "a request for a file that the build does not have",
      "/assets/queue-111.js",
      "cors",
    ],
    ["a request for a path that is no file", "/queue", "cors"],
    [
      "a navigation to another site",
      "https://accounts.google.example/",
      "navigate",
    ],
    ["a request to another site", "https://fonts.example/inter.woff2", "cors"],
  ])("leaves %s to the network", async (_name, address, mode) => {
    const { app } = await installed();

    expect(app.answer(request(address, { mode }))).toBe(undefined);
  });

  it("leaves what is not a GET to the network", async () => {
    const { app } = await installed();

    // A form that is posted to a screen of the app, as the share target of
    // phase 9 will be: it has a body that the app shell would drop.
    expect(app.answer(request("/", { method: "POST" }))).toBe(undefined);
  });

  it("asks the server when the cache is gone", async () => {
    const { app, browser, requests } = await installed();
    // The person has cleared it, or the browser has to make room.
    await browser.caches.delete("pigy-app-2");
    const navigation = request("/queue");

    const answer = await app.answer(navigation);

    expect(await answer?.text()).toBe(files["/"]);
    expect(requests).toEqual([{ path: "/queue", cache: undefined }]);
  });
});
