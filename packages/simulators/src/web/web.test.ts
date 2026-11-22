import { chunksOf, sandboxImage, scanImage } from "@pigy/core";
import { describe, expect, it } from "vitest";
import { createWebSimulator, webImages, webPageAt } from "./index.ts";

const web = createWebSimulator();

describe("the simulated web", () => {
  it("hands out a page with what it says of itself in its head", async () => {
    const response = await web.fetch("https://blog.example.test/first-post");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<title>The first post | Example blog</title>");
    expect(html).toContain(
      '<meta property="og:title" content="The first post">',
    );
  });

  it("writes markup that a page says of itself as the text of an attribute", async () => {
    // The page is there to show that a card shows such a title as text.
    // The page itself must be one that a browser could show: the markup
    // is the value of an attribute, escaped, and no element of the page.
    const html = await (await web.fetch("https://example.test/markup")).text();
    expect(html).toContain(
      'content="&lt;b&gt;Bold&lt;/b&gt; claims &amp; &lt;script&gt;alert(&quot;card&quot;)&lt;/script&gt;"',
    );
    expect(html).not.toContain("<script>");
  });

  it("sends whoever asks for a page that has moved on to where it is", async () => {
    const response = await web.fetch("https://example.test/moved");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "https://blog.example.test/first-post",
    );
    // A simulated network that reads the page follows that.
    expect(webPageAt("https://example.test/moved")?.ogTitle).toBe(
      "The first post",
    );
  });

  it("has files that are no pages, and no page at most addresses", async () => {
    const file = await web.fetch("https://example.test/file.pdf");
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect((await web.fetch("https://example.test/nothing")).status).toBe(404);
    expect(webPageAt("https://example.test/nothing")).toBeUndefined();
    expect(webPageAt("not an address")).toBeUndefined();
  });

  it("has images, among them ones whose answers say another type than their bytes", async () => {
    const bytesOf = async (url: string) => {
      const response = await web.fetch(url);
      expect(response.status).toBe(200);
      return {
        type: response.headers.get("Content-Type"),
        body: response.body as ReadableStream<Uint8Array>,
      };
    };
    // A picture that pigy takes, as it reads a file, at the address that
    // pigy names for a sandbox to try.
    expect(webImages.image).toBe(sandboxImage);
    const image = await bytesOf(webImages.image);
    expect(image.type).toBe("image/png");
    expect(await scanImage(chunksOf(image.body))).toMatchObject({
      type: "image/png",
      width: 120,
      height: 80,
    });
    // The same picture, said to be text, and a page said to be a picture.
    const mislabelled = await bytesOf(webImages.mislabelled);
    expect(mislabelled.type).toBe("text/plain");
    expect(await scanImage(chunksOf(mislabelled.body))).toMatchObject({
      type: "image/png",
    });
    const page = await bytesOf(webImages.notAnImage);
    expect(page.type).toBe("image/png");
    await expect(scanImage(chunksOf(page.body))).rejects.toThrow();
    // And an address that sends the request on to the picture.
    const moved = await web.fetch(webImages.moved);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe(webImages.image);
  });

  it("finds a page whatever its address says after the path", () => {
    expect(webPageAt("https://example.test/?utm=x#top")?.ogTitle).toBe(
      "The example page",
    );
  });

  it("only hands out, and changes nothing", async () => {
    const response = await web.fetch("https://example.test/", {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });

  it("fails like a host out of reach for every host but its own, and without HTTPS", async () => {
    expect(web.owns("example.test")).toBe(true);
    expect(web.owns("example.com")).toBe(false);
    await expect(web.fetch("https://example.com/")).rejects.toThrow(TypeError);
    await expect(web.fetch("http://example.test/")).rejects.toThrow(TypeError);
  });
});
