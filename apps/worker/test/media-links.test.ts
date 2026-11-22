import { env } from "cloudflare:workers";
import { pngFile } from "@pigy/core/test-images";
import { expect, test } from "vitest";
import { contentImageId, mediaKeys } from "../src/media/keys.ts";
import {
  mediaLinkLifetimeMs,
  mediaLinkPath,
  mediaLinks,
} from "../src/media/links.ts";
import { credentialKey, credentialKeys, setup } from "./helpers.ts";
import { newId } from "./sync-client.ts";

const origin = "https://pigy.example";
const workspaceId = "0f4ad6c1-3a0e-4c42-9d2b-6b1a2f0e9c11";

/** An image in the bucket, as an upload leaves one, and a link to it. */
async function linked(now = new Date("2026-03-01T12:00:00Z")) {
  const mediaId = newId();
  const file = await pngFile(8, 8);
  await env.MEDIA.put(mediaKeys(workspaceId, mediaId).original, file, {
    httpMetadata: { contentType: "image/png" },
  });
  const links = mediaLinks(credentialKeys);
  const image = contentImageId(mediaId, "original");
  const link = await links.sign(origin, workspaceId, image, now);
  return { mediaId, file, links, image, link: new URL(link), now };
}

const later = (time: Date, milliseconds: number) =>
  new Date(time.getTime() + milliseconds);

test("a link leads to the image that it was signed for, until it expires", async () => {
  const { mediaId, links, link, now } = await linked();
  const key = mediaKeys(workspaceId, mediaId).original;
  expect(link.pathname.startsWith(`${mediaLinkPath}/`)).toBe(true);
  expect(await links.check(link, now)).toBe(key);
  expect(await links.check(link, later(now, mediaLinkLifetimeMs - 1))).toBe(
    key,
  );
  // At its time and after it, the link is nothing.
  expect(
    await links.check(link, later(now, mediaLinkLifetimeMs)),
  ).toBeUndefined();
});

test("a link that was changed leads nowhere", async () => {
  const { links, link, now, image } = await linked();
  const other = await linked();
  const changed = (change: (url: URL) => void) => {
    const url = new URL(link);
    change(url);
    return links.check(url, now);
  };
  // A later end, under the signature of the earlier one.
  expect(
    await changed((url) => {
      url.searchParams.set(
        "expires",
        String(Number(url.searchParams.get("expires")) + 1),
      );
    }),
  ).toBeUndefined();
  // The image of another post, another workspace, another file of the
  // same image: each is another link, which this signature is not for.
  expect(
    await changed((url) => {
      url.pathname = other.link.pathname;
    }),
  ).toBeUndefined();
  expect(
    await changed((url) => {
      url.pathname = `${mediaLinkPath}/${newId()}/${image}`;
    }),
  ).toBeUndefined();
  expect(
    await changed((url) => {
      url.pathname = url.pathname.replace(/original$/, "thumbnail");
    }),
  ).toBeUndefined();
  // A signature that is one bit off, one that is cut short, and none.
  const signature = link.searchParams.get("signature") ?? "";
  for (const forged of [
    `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
    signature.slice(0, 10),
    "",
    "not base64url!",
  ]) {
    expect(
      await changed((url) => {
        url.searchParams.set("signature", forged);
      }),
    ).toBeUndefined();
  }
  // And unchanged, it still leads to its image: the checks above did
  // not fail for something else.
  expect(await changed(() => {})).toBeDefined();
});

test("a link that another deployment signed leads nowhere", async () => {
  const { link, now } = await linked();
  const others = mediaLinks(`1:${credentialKey(7)}`);
  expect(await others.check(link, now)).toBeUndefined();
});

test("a signature does not make a link to what is not published", async () => {
  // Signed by this pigy for a name that is no file of an image: the
  // check of the name stands behind the signature.
  const links = mediaLinks(credentialKeys);
  const now = new Date();
  for (const image of [
    `${newId()}/thumbnail`,
    `${newId()}/upload`,
    `${newId()}/variants/../original`,
    "../other/original",
  ]) {
    const link = await links.sign(origin, workspaceId, image, now);
    expect(await links.check(new URL(link), now)).toBeUndefined();
  }
});

test("the app serves an image at its link without a session, and nothing at a link that is wrong", async () => {
  const app = setup();
  const { file, link } = await linked(app.clock.time);
  const stranger = app.browser();
  const path = (url: URL) => `${url.pathname}${url.search}`;

  const response = await stranger.fetch(path(link));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(file);

  // The same answer whatever is wrong: no signature, a wrong one, an
  // image that is not there, a listing.
  const unsigned = new URL(link);
  unsigned.search = "";
  const forged = new URL(link);
  forged.searchParams.set("signature", "AAAA");
  for (const wrong of [
    path(unsigned),
    path(forged),
    `${mediaLinkPath}/${workspaceId}/`,
    mediaLinkPath,
  ]) {
    const refused = await stranger.fetch(wrong);
    expect(refused.status).toBe(404);
  }

  app.advance(mediaLinkLifetimeMs);
  expect((await stranger.fetch(path(link))).status).toBe(404);
});
