import { describe, expect, it } from "vitest";
import { builtFile, builtFileHeaders, setup } from "./helpers.ts";

// The stand-in for Cloudflare's files in these tests, `ASSETS` of
// helpers.ts, has one file. It answers every other path with the app
// shell, the status 200 and the headers of the path, as Cloudflare does.

describe("a path under /assets/", () => {
  it("is passed on as Cloudflare answers it when it is a file", async () => {
    const response = await setup().browser().fetch(builtFile);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {};");
    // The headers of `_headers`, the lifetime of a year among them, and
    // nothing of the Worker's in their place or next to them.
    expect(Object.fromEntries(response.headers)).toEqual(
      Object.fromEntries(new Headers(builtFileHeaders)),
    );
  });

  it("is a 404 that nothing keeps when there is no file", async () => {
    // The file of another build. Cloudflare has the app shell for it, with
    // a year to keep it: a browser would hold a page under the name of a
    // script.
    const response = await setup().browser().fetch("/assets/index-old.js");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "NotFoundError",
      message: "Not found",
    });
  });

  it("is not for anything but reading", async () => {
    const response = await setup()
      .browser()
      .fetch(builtFile, { method: "POST" });

    // No route takes it, so nothing is asked of the files.
    expect(response.status).toBe(404);
  });
});
