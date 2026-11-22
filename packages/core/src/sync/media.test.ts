import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { maxImagePixels } from "../media/image.ts";
import { replaces } from "./client/copy.ts";
import { MutationRejected, type RejectionCode } from "./mutators.ts";
import { maxImagesPerPart, maxUploading } from "./tables.ts";

const id = (number: number) =>
  `01932c07-0000-7000-8000-${String(number).padStart(12, "0")}`;

const postId = id(1);
const partId = id(2);
const channelId = id(3);
const mediaId = id(10);

/** The code that `run` is rejected with. Fails if it is not rejected. */
function rejectionOf(run: () => void): RejectionCode {
  try {
    run();
  } catch (error) {
    if (error instanceof MutationRejected) return error.code;
    throw error;
  }
  throw new Error("The mutation was not rejected");
}

const photo = {
  name: "photo.jpg",
  type: "image/jpeg",
  size: 2_000_000,
  width: 4000,
  height: 3000,
  animated: false,
} as const;

/** A workspace with a draft of one part and an image that is on its way. */
function withDraft() {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);
  workspace.mutate("media.create", { id: mediaId, ...photo }, 1000);
  return workspace;
}

/** The IDs of the images of a part, in the order they are shown in. */
function shown(workspace: ReturnType<typeof memoryWorkspace>, part = partId) {
  return workspace
    .rows("part_media")
    .filter((row) => row.partId === part)
    .sort((a, b) => a.position - b.position)
    .map((row) => row.id);
}

it("makes the row of an image as one that is on its way, with what the device says", () => {
  const workspace = withDraft();
  expect(workspace.rows("media")).toEqual([
    {
      id: mediaId,
      kind: "image",
      status: "uploading",
      ...photo,
      createdAt: 1000,
      error: null,
      originalGoneAt: null,
    },
  ]);
});

it("refuses the row of an image that pigy does not take", () => {
  const workspace = memoryWorkspace();
  const create = (changed: object) =>
    rejectionOf(() =>
      workspace.mutate("media.create", { id: mediaId, ...photo, ...changed }),
    );
  expect(create({ type: "image/svg+xml" })).toBe("invalid_arguments");
  expect(create({ size: 21 * 1024 * 1024 })).toBe("invalid_arguments");
  expect(create({ width: maxImagePixels, height: 2 })).toBe(
    "invalid_arguments",
  );
  expect(workspace.rows("media")).toEqual([]);
});

it("lets a workspace have only so many images on their way", () => {
  const workspace = memoryWorkspace();
  for (let number = 0; number < maxUploading; number++) {
    workspace.mutate("media.create", { id: id(100 + number), ...photo });
  }
  expect(
    rejectionOf(() =>
      workspace.mutate("media.create", { id: id(99), ...photo }),
    ),
  ).toBe("too_many_uploads");
  // One that has arrived makes room for the next.
  const { name: _, ...found } = photo;
  workspace.mutate("media.ready", { id: id(100), ...found }, 0, "server");
  workspace.mutate("media.create", { id: id(99), ...photo });
});

it("only lets the server say that an image has arrived, and what it is", () => {
  const workspace = withDraft();
  const found = {
    id: mediaId,
    type: "image/png",
    size: 1_500_000,
    width: 3000,
    height: 4000,
    animated: false,
  };
  expect(rejectionOf(() => workspace.mutate("media.ready", found))).toBe(
    "not_allowed",
  );
  workspace.mutate("media.ready", found, 2000, "server");
  // What the server read replaces what the device said.
  expect(workspace.rows("media")[0]).toMatchObject({
    ...found,
    status: "ready",
    name: "photo.jpg",
  });
  // An image arrives once: a second word about it is late.
  expect(
    rejectionOf(() => workspace.mutate("media.ready", found, 3000, "server")),
  ).toBe("not_current");
  expect(
    rejectionOf(() =>
      workspace.mutate(
        "media.fail",
        { id: mediaId, error: "Too late" },
        3000,
        "server",
      ),
    ),
  ).toBe("not_current");
});

it("marks an image that the server did not take, with the reason", () => {
  const workspace = withDraft();
  workspace.mutate(
    "media.fail",
    { id: mediaId, error: "The file is not an image." },
    2000,
    "server",
  );
  expect(workspace.rows("media")[0]).toMatchObject({
    status: "failed",
    error: "The file is not an image.",
  });
});

it("puts images into a part in the order they are attached, and counts the draft as changed", () => {
  const workspace = withDraft();
  workspace.mutate(
    "media.attach",
    { id: id(20), partId, mediaId, alt: "" },
    2000,
  );
  workspace.mutate(
    "media.attach",
    { id: id(21), partId, mediaId, alt: "A harbour" },
    3000,
  );
  expect(shown(workspace)).toEqual([id(20), id(21)]);
  expect(workspace.rows("part_media")[1]).toMatchObject({
    mediaId,
    alt: "A harbour",
  });
  expect(workspace.rows("post")[0]?.updatedAt).toBe(3000);
});

it("refuses a fifth image in a part", () => {
  const workspace = withDraft();
  for (let number = 0; number < maxImagesPerPart; number++) {
    workspace.mutate("media.attach", {
      id: id(20 + number),
      partId,
      mediaId,
      alt: "",
    });
  }
  expect(
    rejectionOf(() =>
      workspace.mutate("media.attach", {
        id: id(30),
        partId,
        mediaId,
        alt: "",
      }),
    ),
  ).toBe("too_many_media");
});

it("refuses an image for a part that is gone, for an image that is gone, and for a post that is no draft", () => {
  const workspace = withDraft();
  const attach = (args: object) =>
    rejectionOf(() =>
      workspace.mutate("media.attach", {
        id: id(20),
        partId,
        mediaId,
        alt: "",
        ...args,
      }),
    );
  expect(attach({ partId: id(77) })).toBe("not_found");
  expect(attach({ mediaId: id(78) })).toBe("not_found");
  workspace.put("post", {
    ...workspace.rows("post")[0],
    status: "sent",
  } as never);
  expect(attach({})).toBe("not_a_draft");
});

it("describes an image, and moves it within its part", () => {
  const workspace = withDraft();
  for (const number of [20, 21, 22]) {
    workspace.mutate("media.attach", {
      id: id(number),
      partId,
      mediaId,
      alt: "",
    });
  }
  workspace.mutate("media.setAlt", { id: id(21), alt: "A harbour at dusk" });
  expect(
    workspace.rows("part_media").find((row) => row.id === id(21))?.alt,
  ).toBe("A harbour at dusk");

  workspace.mutate("media.move", { id: id(22), afterId: null });
  expect(shown(workspace)).toEqual([id(22), id(20), id(21)]);
  workspace.mutate("media.move", { id: id(22), afterId: id(21) });
  expect(shown(workspace)).toEqual([id(20), id(21), id(22)]);
  // After an image that is not in the part: it stays where it is.
  workspace.mutate("media.move", { id: id(20), afterId: id(99) });
  expect(shown(workspace)).toEqual([id(20), id(21), id(22)]);
});

it("takes an image out of a part and keeps the image itself, so that an Undo can put it back", () => {
  const workspace = withDraft();
  workspace.mutate("media.attach", {
    id: id(20),
    partId,
    mediaId,
    alt: "A harbour",
  });
  workspace.mutate("media.detach", { id: id(20) });
  // A second device that takes it out too is not told of an error.
  workspace.mutate("media.detach", { id: id(20) });
  expect(workspace.rows("part_media")).toEqual([]);
  expect(workspace.rows("media")).toHaveLength(1);
  workspace.mutate("media.attach", {
    id: id(21),
    partId,
    mediaId,
    alt: "A harbour",
  });
  expect(shown(workspace)).toEqual([id(21)]);
});

it("removes what says which images a part has with the part, the text of an account and the post", () => {
  const workspace = withDraft();
  const second = id(4);
  workspace.mutate("part.add", {
    id: second,
    postId,
    channelId: null,
    afterId: partId,
    text: "More",
  });
  workspace.mutate("media.attach", { id: id(20), partId, mediaId, alt: "" });
  workspace.mutate("media.attach", {
    id: id(21),
    partId: second,
    mediaId,
    alt: "",
  });
  workspace.mutate("part.remove", { id: second });
  expect(workspace.rows("part_media").map((row) => row.id)).toEqual([id(20)]);

  // The text of an account has images of its own, which go with it.
  workspace.put("channel", {
    id: channelId,
    network: "mastodon",
    accountId: "1",
    handle: "@ada@example.test",
    name: "Ada",
    avatarUrl: null,
    profileUrl: null,
    status: "connected",
    connectedAt: 0,
    expiresAt: null,
    limits: null,
    limitsCheckedAt: null,
  });
  workspace.mutate("target.add", { id: id(5), postId, channelId });
  const ownPart = id(6);
  workspace.mutate("target.customize", {
    postId,
    channelId,
    parts: [{ id: ownPart, text: "For Mastodon" }],
  });
  workspace.mutate("media.attach", {
    id: id(22),
    partId: ownPart,
    mediaId,
    alt: "",
  });
  workspace.mutate("target.followPost", { postId, channelId });
  expect(workspace.rows("part_media").map((row) => row.id)).toEqual([id(20)]);

  workspace.mutate("post.delete", { id: postId });
  expect(workspace.rows("part_media")).toEqual([]);
  // The image is the server's to delete, when its day is over.
  expect(workspace.rows("media")).toHaveLength(1);
});

it("lets the server remove an image that is in no part, and not one that is in a part again", () => {
  const workspace = withDraft();
  const other = id(11);
  workspace.mutate("media.create", { id: other, ...photo });
  workspace.mutate("media.attach", { id: id(20), partId, mediaId, alt: "" });
  expect(
    rejectionOf(() => workspace.mutate("media.delete", { ids: [other] })),
  ).toBe("not_allowed");
  workspace.mutate("media.delete", { ids: [mediaId, other] }, 0, "server");
  expect(workspace.rows("media").map((row) => row.id)).toEqual([mediaId]);
});

it("marks images that the server has let go of, and puts none of them into a part afterwards", () => {
  const workspace = withDraft();
  workspace.mutate("media.expire", { ids: [mediaId, id(99)] }, 5000, "server");
  expect(workspace.rows("media")[0]?.originalGoneAt).toBe(5000);
  // A second time changes nothing: the time is when it went.
  workspace.mutate("media.expire", { ids: [mediaId] }, 6000, "server");
  expect(workspace.rows("media")[0]?.originalGoneAt).toBe(5000);
  expect(
    rejectionOf(() =>
      workspace.mutate("media.attach", {
        id: id(20),
        partId,
        mediaId,
        alt: "",
      }),
    ),
  ).toBe("not_found");
});

it("keeps the last of the descriptions that are typed for one image", () => {
  const typed = (image: number, alt: string) => ({
    name: "media.setAlt",
    args: { id: id(image), alt },
    at: 0,
  });
  expect(replaces(typed(20, "A har"), typed(20, "A ha"))).toBe(true);
  // Not across images: both are changes.
  expect(replaces(typed(21, "A har"), typed(20, "A ha"))).toBe(false);
});
