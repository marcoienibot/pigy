import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { MutationRejected, type RejectionCode } from "./mutators.ts";
import { maxPartTextLength, postStatuses } from "./tables.ts";

const postId = "01932c07-0000-7000-8000-000000000001";
const partId = "01932c07-0000-7000-8000-000000000002";
const otherPostId = "01932c07-0000-7000-8000-000000000003";
const otherPartId = "01932c07-0000-7000-8000-000000000004";

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

it("creates a post as a draft with one part", () => {
  const workspace = memoryWorkspace();

  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);

  expect(workspace.rows("post")).toEqual([
    { id: postId, status: "draft", createdAt: 1000, updatedAt: 1000 },
  ]);
  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, position: 0, text: "Hello" },
  ]);
});

it("creates a post with no text yet", () => {
  const workspace = memoryWorkspace();

  // A draft exists from the moment the composer opens, before anything is
  // typed, and a draft whose text was cleared must stay valid.
  workspace.mutate("post.create", { id: postId, partId, text: "" });

  expect(workspace.rows("post_part")[0]?.text).toBe("");
});

it.each([
  ["the post", { id: postId, partId: otherPartId }],
  ["the part", { id: otherPostId, partId }],
])("refuses to create a post when %s exists already", (_name, ids) => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "First" });

  // The same IDs under a new mutation ID: an ID is made up by a client, and
  // a second create must not replace what the first one made.
  const code = rejectionOf(() =>
    workspace.mutate("post.create", { ...ids, text: "Second" }),
  );

  expect(code).toBe("already_exists");
  expect(workspace.rows("post")).toHaveLength(1);
  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, position: 0, text: "First" },
  ]);
});

it("replaces the text of a part and notes when the post changed", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Hello" }, 1000);

  workspace.mutate("part.setText", { id: partId, text: "Hello, world" }, 5000);

  expect(workspace.rows("post_part")).toEqual([
    { id: partId, postId, position: 0, text: "Hello, world" },
  ]);
  // Lists of posts are sorted by the last change, which a change of the
  // text of a part is.
  expect(workspace.rows("post")).toEqual([
    { id: postId, status: "draft", createdAt: 1000, updatedAt: 5000 },
  ]);
});

it("refuses to change the text of a part that does not exist", () => {
  const workspace = memoryWorkspace();

  // What a client that was offline sends after another device deleted the
  // post.
  const code = rejectionOf(() =>
    workspace.mutate("part.setText", { id: partId, text: "Too late" }),
  );

  expect(code).toBe("not_found");
  expect(workspace.rows("post_part")).toEqual([]);
});

it.each(postStatuses.filter((status) => status !== "draft"))(
  "refuses to change the text of a post that is %s",
  (status) => {
    const workspace = memoryWorkspace();
    // No mutator moves a post out of the draft status yet, so the rows are
    // stored directly.
    workspace.put("post", { id: postId, status, createdAt: 0, updatedAt: 0 });
    workspace.put("post_part", {
      id: partId,
      postId,
      position: 0,
      text: "Sent",
    });

    const code = rejectionOf(() =>
      workspace.mutate("part.setText", { id: partId, text: "Edited" }, 5000),
    );

    expect(code).toBe("not_a_draft");
    expect(workspace.rows("post_part")[0]?.text).toBe("Sent");
    expect(workspace.rows("post")[0]?.updatedAt).toBe(0);
  },
);

it("deletes a post with all its parts and nothing else", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Goes" });
  // A second part, as a thread has. No mutator adds one yet.
  workspace.put("post_part", {
    id: "01932c07-0000-7000-8000-000000000005",
    postId,
    position: 1,
    text: "Goes too",
  });
  workspace.mutate("post.create", {
    id: otherPostId,
    partId: otherPartId,
    text: "Stays",
  });

  workspace.mutate("post.delete", { id: postId });

  expect(workspace.rows("post").map((post) => post.id)).toEqual([otherPostId]);
  expect(workspace.rows("post_part").map((part) => part.id)).toEqual([
    otherPartId,
  ]);
});

it("accepts the deletion of a post that does not exist", () => {
  const workspace = memoryWorkspace();
  workspace.mutate("post.create", { id: postId, partId, text: "Stays" });

  // Two devices can delete the same post. The second deletion has nothing
  // left to do, which is not worth an error on that device.
  workspace.mutate("post.delete", { id: otherPostId });

  expect(workspace.rows("post")).toHaveLength(1);
});

it.each([
  "post.publish",
  // Properties that every object has. They are not mutators.
  "constructor",
  "toString",
  "__proto__",
])("refuses the unknown mutation %s", (name) => {
  const workspace = memoryWorkspace();

  expect(rejectionOf(() => workspace.mutate(name, { id: postId }))).toBe(
    "unknown_mutation",
  );
});

it.each([
  ["no arguments", undefined],
  ["a missing argument", { id: postId, partId }],
  ["an argument too many", { id: postId, partId, text: "", status: "sent" }],
  ["an ID that is not a UUIDv7", { id: "1", partId, text: "" }],
  ["a text of another type", { id: postId, partId, text: 5 }],
  [
    "a text that is too long",
    { id: postId, partId, text: "a".repeat(maxPartTextLength + 1) },
  ],
])("refuses to create a post with %s", (_name, args) => {
  const workspace = memoryWorkspace();

  expect(rejectionOf(() => workspace.mutate("post.create", args))).toBe(
    "invalid_arguments",
  );
  expect(workspace.rows("post")).toEqual([]);
});

it("accepts a text of the greatest length", () => {
  const workspace = memoryWorkspace();
  const text = "a".repeat(maxPartTextLength);

  workspace.mutate("post.create", { id: postId, partId, text });

  expect(workspace.rows("post_part")[0]?.text).toBe(text);
});

it("says which argument is wrong", () => {
  const workspace = memoryWorkspace();

  // The message ends up in front of whoever debugs a client.
  expect(() =>
    workspace.mutate("part.setText", { id: partId, text: null }),
  ).toThrow(/^text: /);
});
