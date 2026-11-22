import { limitsSchema, type MutatorName, maxImagesPerPart } from "@pigy/core";
import { jpegFile, pngFile } from "@pigy/core/test-images";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachFiles,
  contentImage,
  fetchedBytes,
  fetchedUrl,
  imageNotes,
  imagesOf,
  readFile,
  selectPartImages,
  selectUploading,
} from "@/lib/media";
import { compose } from "@/lib/publish";
import {
  blueskyLimits,
  channel,
  media,
  part,
  partMedia,
  post,
  tablesOf,
} from "@/lib/rows.test-support";
import { memoryFiles } from "@/lib/upload-files";
import { Uploads } from "@/lib/uploads";

const mastodonLimits = {
  network: "mastodon",
  maxCharacters: 500,
  charactersPerUrl: 23,
} as const;

describe("selectPartImages", () => {
  it("has the images of each part in their order, each with its row", () => {
    const draft = post();
    const text = part(draft.id);
    const [one, two] = [media(), media({ status: "uploading" })];
    const second = partMedia(text.id, two.id, { position: 1, alt: "Two" });
    const first = partMedia(text.id, one.id, { position: 0, alt: "One" });
    const images = selectPartImages(
      tablesOf({
        post: [draft],
        post_part: [text],
        media: [one, two],
        part_media: [second, first],
      }),
    );
    expect(imagesOf(images, text.id)).toEqual([
      { id: first.id, alt: "One", media: one },
      { id: second.id, alt: "Two", media: two },
    ]);
    expect(imagesOf(images, "another part")).toEqual([]);
  });

  it("hands out the list that it made before for a part whose images have not changed", () => {
    const draft = post();
    const [typed, other] = [part(draft.id), part(draft.id, { position: 1 })];
    const image = media();
    const attached = partMedia(other.id, image.id);
    const before = selectPartImages(
      tablesOf({
        post: [draft],
        post_part: [typed, other],
        media: [image],
        part_media: [attached],
      }),
    );
    // A key in the other part: its row is a new object, the rest are the
    // objects that they were.
    const after = selectPartImages(
      tablesOf({
        post: [draft],
        post_part: [{ ...typed, text: "Hello!" }, other],
        media: [image],
        part_media: [attached],
      }),
    );
    expect(imagesOf(after, other.id)).toBe(imagesOf(before, other.id));
    // A description that changed makes the list new.
    const described = selectPartImages(
      tablesOf({
        post: [draft],
        post_part: [typed, other],
        media: [image],
        part_media: [{ ...attached, alt: "A harbour" }],
      }),
    );
    expect(imagesOf(described, other.id)).not.toBe(imagesOf(before, other.id));
  });
});

it("lists the images that are on their way, as a text that changes only when they do", () => {
  const [a, b] = [
    media({ status: "uploading" }),
    media({ status: "uploading" }),
  ];
  const listed = selectUploading(
    tablesOf({ media: [b, media(), a, media({ status: "failed" })] }),
  );
  expect(listed).toBe([a.id, b.id].sort().join(" "));
  expect(selectUploading(tablesOf({ media: [media()] }))).toBe("");
});

describe("what keeps a draft with images from being published", () => {
  const draft = post();
  const text = part(draft.id, { text: "A harbour" });
  const mastodon = channel({ limits: mastodonLimits });
  const composed = (image: ReturnType<typeof media> | undefined, alt = "") => {
    const attached = partMedia(text.id, image?.id ?? "gone", { alt });
    return compose(
      [text],
      [mastodon],
      new Set([mastodon.id]),
      undefined,
      new Map([
        [text.id, [contentImage({ id: attached.id, alt, media: image })]],
      ]),
    );
  };

  it("is nothing for an image that the server has", () => {
    expect(composed(media()).blocked).toBeNull();
  });

  it.each([
    [media({ status: "uploading" }), "is still being uploaded"],
    [media({ status: "failed", error: "No" }), "was not uploaded"],
    [media({ originalGoneAt: 5 }), "is no longer kept"],
    [undefined, "is no longer kept"],
  ])("is an image that is not there to publish", (image, words) => {
    const { blocked, choices } = composed(image);
    expect(blocked).toBe("refused");
    expect(choices[0]?.refuses.join(" ")).toContain(words);
  });

  it("lets a part that is only an image go out, and counts a fifth image against Bluesky", () => {
    const image = media();
    const images = (count: number) =>
      new Map([
        [
          text.id,
          Array.from({ length: count }, () =>
            contentImage({ id: "x", alt: "", media: image }),
          ),
        ],
      ]);
    const bluesky = channel({ network: "bluesky", limits: blueskyLimits });
    const only = compose(
      [{ ...text, text: "" }],
      [bluesky],
      new Set([bluesky.id]),
      undefined,
      images(1),
    );
    expect(only).toMatchObject({ blocked: null, emptyParts: [] });
    const five = compose(
      [text],
      [bluesky],
      new Set([bluesky.id]),
      undefined,
      images(5),
    );
    expect(five.choices[0]?.refuses).toEqual([
      "The post has 5 images. Bluesky takes 4 at most.",
    ]);
  });
});

describe("imageNotes", () => {
  const image = (fields = {}, alt = "A harbour") => ({
    id: "x",
    alt,
    media: media(fields),
  });

  it("says nothing of images that are described and go out as they are", () => {
    expect(imageNotes([image()], [mastodonLimits], false)).toEqual([]);
    expect(imageNotes([], [mastodonLimits], true)).toEqual([]);
  });

  it("reminds of the images that have no description, and keeps nothing back", () => {
    expect(imageNotes([image({}, " ")], [mastodonLimits], false)).toEqual([
      "The image has no description. People who use a screen reader hear nothing of it.",
    ]);
    expect(
      imageNotes([image(), image({}, ""), image({}, "")], [], false),
    ).toEqual([
      "2 images have no description. People who use a screen reader hear nothing of them.",
    ]);
  });

  it("says where the card of a link gives way to the images", () => {
    expect(
      imageNotes([image()], [blueskyLimits, mastodonLimits], true),
    ).toEqual([
      "Bluesky shows the images and no card for the link: a post has one or the other there.",
    ]);
    // Without a link there is no card to speak of.
    expect(imageNotes([image()], [blueskyLimits], false)).toEqual([]);
  });

  it("says of LinkedIn, which makes one post of a thread, that it gets the images of every part, and no card of a link in any of them", () => {
    const linkedin = limitsSchema.parse({
      network: "linkedin",
      maxCharacters: 3000,
    });
    expect(imageNotes([image()], [linkedin, mastodonLimits], false)).toEqual(
      [],
    );
    expect(
      imageNotes([image()], [linkedin, mastodonLimits], false, {
        parts: 3,
        joinedCard: true,
      }),
    ).toEqual([
      "LinkedIn gets the parts as one post, with these images and those of the other parts together.",
      // The link is in another part, and LinkedIn shows one card of it.
      "LinkedIn shows the images and no card for the link: a post has one or the other there.",
    ]);
    // Bluesky goes by the part alone: each part is a post there.
    expect(
      imageNotes([image()], [blueskyLimits], false, {
        parts: 3,
        joinedCard: true,
      }),
    ).toEqual([]);
  });

  it("says where a smaller image is made, and where one that moves is still", () => {
    // Over Bluesky's million bytes, and fine for Mastodon.
    expect(
      imageNotes(
        [image({ size: 3_000_000 })],
        [blueskyLimits, mastodonLimits],
        false,
      ),
    ).toEqual([
      "pigy makes a smaller image for Bluesky, which takes less than this one has.",
    ]);
    expect(
      imageNotes(
        [image({ type: "image/gif", animated: true })],
        [blueskyLimits, mastodonLimits],
        false,
      ),
    ).toEqual(["An image that moves is a still picture on Bluesky."]);
  });
});

describe("attaching files", () => {
  const uploads = () =>
    new Uploads({
      // Never answered: these tests are about what is asked of the copy.
      api: () => new Promise(() => {}),
      files: memoryFiles(),
      schedule: () => () => {},
    });
  const file = (bytes: Uint8Array, name: string) =>
    new File([bytes as Uint8Array<ArrayBuffer>], name);

  it("reads what a file is from its bytes", async () => {
    expect(
      await readFile(new Blob([(await pngFile(40, 30)) as never])),
    ).toEqual({
      facts: expect.objectContaining({
        type: "image/png",
        width: 40,
        height: 30,
      }),
    });
    expect(await readFile(new Blob(["<svg/>"]))).toEqual({
      refused: "is not a JPEG, PNG, WebP or GIF image",
    });
  });

  it("makes the row of each image with what the device read, puts it into the part, and says which files it did not take", async () => {
    const made: [MutatorName, Record<string, unknown>][] = [];
    const refusals = await attachFiles(
      [
        // Named a PNG, and a JPEG by its bytes.
        file(jpegFile(50, 20), "harbour.png"),
        file(new TextEncoder().encode("#!/bin/sh"), "script.jpg"),
        file(await pngFile(4, 4), "icon.png"),
      ],
      "part",
      0,
      "workspace",
      (name, args) => made.push([name, args as Record<string, unknown>]),
      uploads(),
    );
    expect(refusals).toEqual([
      "script.jpg is not a JPEG, PNG, WebP or GIF image.",
    ]);
    expect(made.map(([name]) => name)).toEqual([
      "media.create",
      "media.attach",
      "media.create",
      "media.attach",
    ]);
    expect(made[0]?.[1]).toMatchObject({
      name: "harbour.png",
      type: "image/jpeg",
      width: 50,
      height: 20,
      animated: false,
    });
    // The image goes into the part under the ID of its row.
    expect(made[1]?.[1]).toMatchObject({
      partId: "part",
      mediaId: made[0]?.[1].id,
      alt: "",
    });
  });

  it("goes on with the other files when one cannot be read", async () => {
    // A file that the browser fails to read, as one that was changed on
    // the disk since it was chosen: the files after it are still taken.
    const unreadable = new File([], "moved.png");
    Object.defineProperty(unreadable, "stream", {
      value: () =>
        new ReadableStream({
          pull(controller) {
            controller.error(new DOMException("Gone", "NotReadableError"));
          },
        }),
    });
    const made: MutatorName[] = [];
    const refusals = await attachFiles(
      [unreadable, file(await pngFile(4, 4), "icon.png")],
      "part",
      0,
      "workspace",
      (name) => made.push(name),
      uploads(),
    );
    expect(refusals).toEqual(["moved.png could not be read."]);
    expect(made).toEqual(["media.create", "media.attach"]);
  });

  it("takes no more files than the part has room for", async () => {
    const made: MutatorName[] = [];
    const png = await pngFile(4, 4);
    const refusals = await attachFiles(
      [file(png, "a.png"), file(png, "b.png"), file(png, "c.png")],
      "part",
      maxImagesPerPart - 2,
      "workspace",
      (name) => made.push(name),
      uploads(),
    );
    expect(made.filter((name) => name === "media.attach")).toHaveLength(2);
    expect(refusals).toEqual([
      "c.png was not added: a part has 4 images at most.",
    ]);
  });
});

describe("fetched pictures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("are kept up to so many bytes, and the ones asked for longest ago go first, with their addresses", async () => {
    // Pictures of a quarter of what a tab keeps: four of them fit.
    const size = fetchedBytes / 4;
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return new Response(new Uint8Array(size));
    });
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    const path = (index: number) => `/api/sandbox/images/picture-${index}`;
    const urls: string[] = [];
    for (let index = 0; index < 4; index++) {
      urls.push(await fetchedUrl(path(index)));
    }
    // The first is asked for again, and is the last to go now.
    expect(await fetchedUrl(path(0))).toBe(urls[0]);
    expect(revoked).toEqual([]);
    // Before, every picture stayed for as long as the page.
    await fetchedUrl(path(4));
    expect(revoked).toEqual([urls[1]]);
    expect(fetches).toBe(5);
    // A picture that went is fetched again when it is drawn anew.
    expect(await fetchedUrl(path(1))).not.toBe(urls[1]);
    expect(fetches).toBe(6);
  });
});
