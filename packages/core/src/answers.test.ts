import { describe, expect, it } from "vitest";
import { uploadCompleteSchema, uploadStateSchema } from "./media/upload.ts";
import { linkCardResponseSchema, mentionsResponseSchema } from "./preview.ts";
import { sandboxFaultsSchema, sandboxFeedSchema } from "./sandbox.ts";

describe("the schemas of answers that a client fetches", () => {
  // A device runs the app that it has until it is next started, so the
  // client of one release reads the answers of the next. A field that
  // the next release adds must not make it refuse the whole answer, as
  // the feed of a sandbox did when its posts got marks and a card.
  it("leave out a field that they do not know, at every depth, and refuse nothing for it", () => {
    const post = {
      id: "1",
      text: "A post",
      createdAt: 0,
      entities: [{ kind: "link", start: 0, end: 1, later: true }],
      card: {
        url: "https://example.test/",
        title: "T",
        description: "",
        later: 1,
      },
      images: [{ id: "blob1", alt: "", width: 4, height: 3, later: 1 }],
      replies: [],
      later: "a field of a later release",
    };
    const feed = sandboxFeedSchema.parse({
      accounts: [
        {
          network: "mastodon",
          id: "a",
          handle: "@a",
          name: "A",
          posts: [{ ...post, replies: [post] }],
          later: 1,
        },
      ],
      later: 1,
    });
    expect(JSON.stringify(feed)).not.toContain("later");
    expect(feed.accounts[0]?.posts[0]?.replies[0]?.card?.title).toBe("T");

    expect(feed.accounts[0]?.posts[0]?.images).toEqual([
      { id: "blob1", alt: "", width: 4, height: 3 },
    ]);
    // A feed of a server from before posts had images is read too.
    const { images: _, ...older } = post;
    expect(
      sandboxFeedSchema.parse({
        accounts: [
          {
            network: "mastodon",
            id: "a",
            handle: "@a",
            name: "A",
            posts: [older],
          },
        ],
      }).accounts[0]?.posts[0]?.images,
    ).toBeUndefined();

    expect(
      uploadStateSchema.parse({ chunkBytes: 5, received: [1], later: 1 }),
    ).toEqual({ chunkBytes: 5, received: [1] });
    expect(uploadCompleteSchema.parse({ status: "ready", later: 1 })).toEqual({
      status: "ready",
    });

    expect(
      sandboxFaultsSchema.parse({
        networks: [
          {
            network: "mastodon",
            kinds: [],
            operations: [],
            armed: [{ kind: "rate-limit", operation: null, later: 1 }],
            later: 1,
          },
        ],
        later: 1,
      }).networks[0]?.armed,
    ).toEqual([{ kind: "rate-limit", operation: null }]);

    expect(
      linkCardResponseSchema.parse({
        card: {
          url: "https://example.test/",
          title: "T",
          description: "",
          image: "of a later release",
        },
        later: 1,
      }),
    ).toEqual({
      card: { url: "https://example.test/", title: "T", description: "" },
    });
    expect(mentionsResponseSchema.parse({ known: ["a"], later: 1 })).toEqual({
      known: ["a"],
    });
  });
});
