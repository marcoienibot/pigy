import { describe, expect, it } from "vitest";
import {
  defaultMediaLimits,
  type Limits,
  limitsSchema,
  maxContentLength,
  validateContent,
  variantFor,
  variantName,
} from "./limits.ts";

const limits: Limits = {
  network: "mastodon",
  maxCharacters: 20,
  charactersPerUrl: 23,
};

describe("validateContent", () => {
  it("finds nothing wrong with text up to the limit", () => {
    expect(
      validateContent(limits, { parts: [{ text: "a".repeat(20) }] }),
    ).toEqual([]);
  });

  it("reports a part that is over the limit, with both numbers", () => {
    expect(
      validateContent(limits, {
        parts: [{ text: "fine" }, { text: "a".repeat(21) }],
      }),
    ).toEqual([
      {
        part: 1,
        code: "too_long",
        characters: 21,
        maxCharacters: 20,
        message: "Part 2 is 21 characters long. The limit is 20.",
      },
    ]);
  });

  it("counts the way the network does, not the way String.length does", () => {
    // 20 emoji are 40 UTF-16 code units and 20 characters to Mastodon.
    expect(
      validateContent(limits, { parts: [{ text: "😀".repeat(20) }] }),
    ).toEqual([]);
    // A link of 30 characters counts as 23, which is over 20.
    expect(
      validateContent(limits, {
        parts: [{ text: "https://example.com/0123456789" }],
      }),
    ).toMatchObject([{ code: "too_long", characters: 23 }]);
  });

  it("reports a part without text", () => {
    expect(
      validateContent(limits, { parts: [{ text: "one" }, { text: " \n " }] }),
    ).toEqual([{ part: 1, code: "empty", message: "Part 2 has no text." }]);
  });

  it("calls a post of one part a post", () => {
    expect(validateContent(limits, { parts: [{ text: "" }] })).toEqual([
      { part: 0, code: "empty", message: "The post has no text." },
    ]);
  });

  it("reports every part that has something wrong", () => {
    const issues = validateContent(limits, {
      parts: [{ text: "" }, { text: "fine" }, { text: "a".repeat(30) }],
    });
    expect(issues.map(({ part, code }) => [part, code])).toEqual([
      [0, "empty"],
      [2, "too_long"],
    ]);
  });

  it("reports a text that is longer than pigy publishes to one account, whatever its network takes", () => {
    // A server that takes posts of any length: each part passes by
    // itself, and only the whole is too much.
    const roomy: Limits = { ...limits, maxCharacters: 1_000_000 };
    const parts = (length: number) => ({
      parts: [{ text: "a".repeat(length - 10) }, { text: "b".repeat(10) }],
    });

    expect(validateContent(roomy, parts(maxContentLength))).toEqual([]);
    expect(validateContent(roomy, parts(maxContentLength + 1))).toEqual([
      {
        part: null,
        code: "too_much_text",
        length: maxContentLength + 1,
        maxLength: maxContentLength,
        message: `The text is ${maxContentLength + 1} characters long, all its parts together. pigy publishes at most ${maxContentLength} to one account.`,
      },
    ]);
  });
});

describe("limitsSchema", () => {
  it("accepts the limits of a Mastodon instance", () => {
    expect(limitsSchema.parse(limits)).toEqual(limits);
  });

  it("accepts the limits of Bluesky, and not those of one network under the name of another", () => {
    const bluesky = { network: "bluesky", maxCharacters: 300, maxBytes: 3000 };
    expect(limitsSchema.parse(bluesky)).toEqual(bluesky);
    // The network decides how a text is counted, so limits that name one
    // network and hold the fields of another are nobody's.
    expect(
      limitsSchema.safeParse({ ...limits, network: "bluesky" }).success,
    ).toBe(false);
  });

  it("refuses limits that name no network, or carry something unknown", () => {
    const { network: _, ...withoutNetwork } = limits;
    expect(limitsSchema.safeParse(withoutNetwork).success).toBe(false);
    expect(limitsSchema.safeParse({ ...limits, extra: 1 }).success).toBe(false);
    expect(
      limitsSchema.safeParse({ ...limits, maxCharacters: 0 }).success,
    ).toBe(false);
  });
});

describe("LinkedIn", () => {
  const linkedin: Limits = { network: "linkedin", maxCharacters: 20 };

  it("accepts its limits", () => {
    expect(limitsSchema.parse(linkedin)).toEqual(linkedin);
  });

  it("counts UTF-16 code units: an emoji outside the basic plane is two", () => {
    // 10 emoji are 20 code units, which is the limit, and 10 to Mastodon.
    expect(
      validateContent(linkedin, { parts: [{ text: "😀".repeat(10) }] }),
    ).toEqual([]);
    expect(
      validateContent(linkedin, { parts: [{ text: `${"😀".repeat(10)}a` }] }),
    ).toMatchObject([{ code: "too_long", characters: 21 }]);
    // A link counts as it is written, where Mastodon counts 23 for any.
    expect(
      validateContent(linkedin, {
        parts: [{ text: "https://example.com/0123456789" }],
      }),
    ).toMatchObject([{ code: "too_long", characters: 30 }]);
  });

  it("takes the parts of a thread as one post, with an empty line between them", () => {
    // 9 + 2 + 9 is the limit.
    expect(
      validateContent(linkedin, {
        parts: [{ text: "a".repeat(9) }, { text: "b".repeat(9) }],
      }),
    ).toEqual([]);
    // Each part fits by itself. The third is the one with which the post
    // no longer does: 5 + 2 + 5 + 2 + 7.
    expect(
      validateContent(linkedin, {
        parts: [
          { text: "a".repeat(5) },
          { text: "b".repeat(5) },
          { text: "c".repeat(7) },
        ],
      }),
    ).toEqual([
      {
        part: 2,
        code: "too_long_together",
        characters: 21,
        maxCharacters: 20,
        message:
          "The parts are 21 characters long together. LinkedIn takes them as one post, with an empty line between them, and its limit is 20.",
      },
    ]);
  });

  it("says of a part that is too long by itself that it is, and not that the parts together are", () => {
    expect(
      validateContent(linkedin, {
        parts: [{ text: "fine" }, { text: "a".repeat(21) }],
      }).map(({ part, code }) => [part, code]),
    ).toEqual([[1, "too_long"]]);
  });
});

describe("Threads", () => {
  const threads: Limits = { network: "threads", maxCharacters: 20 };

  it("accepts its limits", () => {
    expect(limitsSchema.parse(threads)).toEqual(threads);
  });

  it("counts a letter as one, whatever bytes it takes, and a link as it is written", () => {
    // 20 letters with accents are 40 bytes, and 20 characters to Threads.
    expect(
      validateContent(threads, { parts: [{ text: "é".repeat(20) }] }),
    ).toEqual([]);
    expect(
      validateContent(threads, { parts: [{ text: "https://example.com/a" }] }),
    ).toMatchObject([{ code: "too_long", characters: 21 }]);
  });

  it("counts an emoji as the bytes that it takes", () => {
    // Five emoji of four bytes each are the limit.
    expect(
      validateContent(threads, { parts: [{ text: "😀".repeat(5) }] }),
    ).toEqual([]);
    expect(
      validateContent(threads, { parts: [{ text: `${"😀".repeat(5)}a` }] }),
    ).toMatchObject([{ code: "too_long", characters: 21 }]);
    // An emoji made of several code points counts every one of them: two
    // pictographs of four bytes and the joiner of three between them.
    expect(
      validateContent(threads, {
        parts: [{ text: `\u{1F469}\u200D\u{1F680}${"a".repeat(10)}` }],
      }),
    ).toMatchObject([{ code: "too_long", characters: 21 }]);
  });

  it("checks every part of a thread by itself: a thread is a chain of posts there", () => {
    expect(
      validateContent(threads, {
        parts: [{ text: "a".repeat(20) }, { text: "b".repeat(20) }],
      }),
    ).toEqual([]);
  });
});

describe("validateContent with images", () => {
  const image = {
    id: "image-1",
    type: "image/jpeg",
    size: 500_000,
    width: 1600,
    height: 1200,
    alt: "A harbour",
  } as const;
  const bluesky = limitsSchema.parse({
    network: "bluesky",
    maxCharacters: 300,
    maxBytes: 3000,
  });
  const threads = limitsSchema.parse({
    network: "threads",
    maxCharacters: 500,
  });
  const linkedin = limitsSchema.parse({
    network: "linkedin",
    maxCharacters: 3000,
  });
  const onThreads = (content: Parameters<typeof validateContent>[1]) =>
    validateContent(threads, content);
  const codes = (found: ReturnType<typeof validateContent>) =>
    found.map(({ code }) => code);

  it("takes a part that is only an image, and none that is nothing", () => {
    expect(
      validateContent(limits, { parts: [{ text: "", media: [image] }] }),
    ).toEqual([]);
    expect(
      codes(validateContent(limits, { parts: [{ text: " ", media: [] }] })),
    ).toEqual(["empty"]);
  });

  it("counts the images of a part against what the network takes in a post", () => {
    const five = Array.from({ length: 5 }, () => image);
    expect(
      validateContent(bluesky, { parts: [{ text: "a", media: five }] }),
    ).toEqual([
      {
        part: 0,
        code: "too_many_images",
        images: 5,
        maxImages: 4,
        message: "The post has 5 images. Bluesky takes 4 at most.",
      },
    ]);
    // Four in each of two parts are two posts of four.
    const four = five.slice(1);
    expect(
      validateContent(bluesky, {
        parts: [
          { text: "a", media: four },
          { text: "b", media: four },
        ],
      }),
    ).toEqual([]);
  });

  it("goes by what an instance says where its limits say it", () => {
    const strict = limitsSchema.parse({
      ...limits,
      media: {
        maxImages: 1,
        maxImageBytes: 1000,
        maxImagePixels: null,
        imageTypes: ["image/jpeg"],
        animated: false,
        maxAltLength: 5,
        maxAspectRatio: null,
      },
    });
    expect(
      codes(
        validateContent(strict, {
          parts: [{ text: "a", media: [image, image] }],
        }),
      ),
      // The description of each, "A harbour", is nine characters.
    ).toEqual(["too_many_images", "alt_too_long", "alt_too_long"]);
  });

  it("takes images for every network, each of a thread's parts with its own", () => {
    const parts = [
      { text: "a", media: [image, image] },
      { text: "b", media: [image] },
    ];
    for (const network of [limits, bluesky, linkedin, threads]) {
      expect(validateContent(network, { parts })).toEqual([]);
    }
  });

  it("counts the images of all parts together where a thread is one post", () => {
    const parts = Array.from({ length: 6 }, () => ({
      text: "a",
      media: [image, image, image, image],
    }));
    expect(validateContent(linkedin, { parts })).toEqual([
      {
        part: null,
        code: "too_many_images",
        images: 24,
        maxImages: 20,
        message:
          "The parts have 24 images together. LinkedIn takes them as one post, with 20 images at most.",
      },
    ]);
  });

  it("counts a description in characters, and names the image", () => {
    // 1001 emoji are 2002 UTF-16 code units and 1001 characters.
    const alt = "😀".repeat(1001);
    expect(
      onThreads({
        parts: [{ text: "a", media: [image, { ...image, alt }] }],
      }),
    ).toEqual([
      {
        part: 0,
        code: "alt_too_long",
        image: 1,
        characters: 1001,
        maxCharacters: 1000,
        message:
          "Image 2 of the post has a description of 1001 characters. Threads takes 1000.",
      },
    ]);
    expect(
      onThreads({
        parts: [{ text: "a", media: [{ ...image, alt: "😀".repeat(1000) }] }],
      }),
    ).toEqual([]);
  });

  it("refuses a shape that a network refuses, whichever way it is long", () => {
    for (const [width, height] of [
      [3001, 300],
      [300, 3001],
    ] as const) {
      expect(
        codes(
          onThreads({
            parts: [{ text: "a", media: [{ ...image, width, height }] }],
          }),
        ),
      ).toEqual(["image_shape"]);
    }
    // Ten to one is taken, and Bluesky has no such limit.
    const panorama = { ...image, width: 3000, height: 300 };
    expect(onThreads({ parts: [{ text: "a", media: [panorama] }] })).toEqual(
      [],
    );
    expect(
      validateContent(bluesky, {
        parts: [{ text: "a", media: [{ ...panorama, width: 30_000 }] }],
      }),
    ).toEqual([]);
  });

  it.each([
    ["uploading", "is still being uploaded"],
    ["failed", "was not uploaded"],
    ["gone", "is no longer kept"],
  ] as const)("does not publish an image that is %s", (missing, words) => {
    const [issue, ...more] = validateContent(limits, {
      parts: [{ text: "a" }, { text: "b", media: [{ ...image, missing }] }],
    });
    expect(more).toEqual([]);
    expect(issue).toMatchObject({ part: 1, code: "image_missing", missing });
    expect(issue?.message).toContain(`The image of part 2 ${words}`);
  });
});

describe("variantFor", () => {
  const photo = {
    type: "image/jpeg",
    size: 900_000,
    width: 2000,
    height: 1500,
  } as const;
  const { bluesky, threads, mastodon, linkedin } = defaultMediaLimits;

  it("leaves an image alone that the network takes as it is", () => {
    for (const taken of [bluesky, threads, mastodon, linkedin]) {
      expect(variantFor(taken, photo)).toBeNull();
    }
    // Exactly at the limit.
    expect(variantFor(bluesky, { ...photo, size: 1_000_000 })).toBeNull();
  });

  it("makes a smaller one of an image with more bytes or pixels than the network takes", () => {
    expect(variantFor(bluesky, { ...photo, size: 1_000_001 })).toEqual({
      type: "image/jpeg",
      maxBytes: 1_000_000,
      maxPixels: null,
    });
    expect(
      variantFor(mastodon, { ...photo, width: 8000, height: 6000 }),
    ).toEqual({
      type: "image/jpeg",
      maxBytes: 16 * 1024 * 1024,
      maxPixels: 33_177_600,
    });
  });

  it("keeps a drawing a PNG and makes a JPEG of a type that the network has not", () => {
    const drawing = { ...photo, type: "image/png", size: 3_000_000 } as const;
    expect(variantFor(bluesky, drawing)?.type).toBe("image/png");
    const webp = { ...photo, type: "image/webp" } as const;
    expect(variantFor(bluesky, webp)).toBeNull();
    expect(variantFor(threads, webp)?.type).toBe("image/jpeg");
    expect(variantFor(linkedin, webp)?.type).toBe("image/jpeg");
  });

  it("makes a still picture of one that moves where nothing moves", () => {
    const gif = { ...photo, type: "image/gif", animated: true } as const;
    expect(variantFor(mastodon, gif)).toBeNull();
    expect(variantFor(linkedin, gif)).toBeNull();
    expect(variantFor(bluesky, gif)?.type).toBe("image/png");
    expect(variantFor(threads, gif)?.type).toBe("image/png");
  });

  it("names a variant by what it is made within", () => {
    const small = variantFor(bluesky, { ...photo, size: 2_000_000 });
    const png = variantFor(bluesky, {
      ...photo,
      type: "image/png",
      size: 2_000_000,
    });
    if (!small || !png) throw new Error("No variant");
    expect(variantName(small)).toBe("jpeg-1000000-0");
    expect(variantName(png)).not.toBe(variantName(small));
  });
});
