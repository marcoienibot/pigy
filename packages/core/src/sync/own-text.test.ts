import { expect, it } from "vitest";
import { memoryWorkspace } from "../../test/memory-transaction.ts";
import { mutators } from "./mutators.ts";
import { ownTextMutations } from "./own-text.ts";
import { syncLimits } from "./protocol.ts";
import {
  inReadingOrder,
  maxOwnTextLength,
  maxParts,
  maxPartTextLength,
} from "./tables.ts";

const postId = "01932c07-0000-7000-8000-000000000001";
const partId = "01932c07-0000-7000-8000-000000000002";
const channelId = "01932c07-0000-7000-8000-000000000006";
const targetId = "01932c07-0000-7000-8000-000000000008";

/** IDs of the form of a row's, each one later than the one before. */
function ids() {
  let next = 0;
  return () => {
    next += 1;
    return `01932c07-0000-7000-8000-1${next.toString(16).padStart(11, "0")}`;
  };
}

/** A draft that goes to one account, and has no text for it. */
function withTarget() {
  const workspace = memoryWorkspace();
  workspace.mutate(
    "channel.connect",
    {
      id: channelId,
      network: "mastodon",
      accountId: "1@mastodon.example",
      handle: "@ada@mastodon.example",
      name: "Ada",
      avatarUrl: null,
      profileUrl: null,
      expiresAt: null,
      limits: null,
    },
    0,
    "server",
  );
  workspace.mutate("post.create", { id: postId, partId, text: "The post" });
  workspace.mutate("target.add", { id: targetId, postId, channelId });
  return workspace;
}

/** The text that is written for the account, part after part. */
const ownText = (workspace: ReturnType<typeof memoryWorkspace>) =>
  inReadingOrder(
    workspace.rows("post_part").filter((part) => part.targetId === targetId),
  ).map(({ text }) => text);

/** The length of a `mutate` message that carries `mutation` alone. */
const messageLength = (mutation: { name: string; args: unknown }) =>
  JSON.stringify({
    type: "mutate",
    // The ID of a mutation is a number, which is never longer than this.
    mutations: [{ id: Number.MAX_SAFE_INTEGER, ...mutation }],
  }).length;

it("brings a text back in one mutation when that carries it", () => {
  const mutations = ownTextMutations(postId, channelId, ["One", "Two"], ids());

  expect(mutations.map(({ name }) => name)).toEqual(["target.customize"]);
  const workspace = withTarget();
  for (const { name, args } of mutations) workspace.mutate(name, args);
  expect(ownText(workspace)).toEqual(["One", "Two"]);
});

it("brings back all of a text that is longer than one mutation carries, in its order", () => {
  // What an account can have after ordinary edits: a text that began
  // within the limit of `target.customize` and grew part by part.
  const texts = Array.from({ length: 30 }, (_, index) =>
    `${index} `.padEnd(9000, "x"),
  );
  expect(texts.join("").length).toBeGreaterThan(maxOwnTextLength);

  const mutations = ownTextMutations(postId, channelId, texts, ids());

  // The server takes every one of them: none is refused, and the text is
  // whole, each part where it was.
  const workspace = withTarget();
  for (const { name, args } of mutations) workspace.mutate(name, args);
  expect(ownText(workspace)).toEqual(texts);
  // The post's own text is not where any of it went.
  expect(workspace.rows("post_part")).toHaveLength(texts.length + 1);
});

it("makes no mutation that is longer than a message may be, for the longest text that an account can have", () => {
  // The worst case for the length of a message: as many parts as a text
  // has, each as long as a part can be, of a character that JSON writes
  // as six.
  const texts = Array.from({ length: maxParts }, () =>
    "\u0000".repeat(maxPartTextLength),
  );

  const mutations = ownTextMutations(postId, channelId, texts, ids());

  expect(mutations.length).toBeGreaterThan(1);
  for (const mutation of mutations) {
    expect(messageLength(mutation)).toBeLessThanOrEqual(
      syncLimits.clientMessageLength,
    );
    // And each is what its mutator takes.
    expect(
      mutators[mutation.name].schema.safeParse(mutation.args).success,
    ).toBe(true);
  }
  const workspace = withTarget();
  for (const { name, args } of mutations) workspace.mutate(name, args);
  expect(ownText(workspace)).toEqual(texts);
});

it("makes no mutation for a text without parts", () => {
  expect(ownTextMutations(postId, channelId, [], ids())).toEqual([]);
});

it.each([
  [
    "target.customize",
    {
      postId,
      channelId,
      // As much text as the mutator takes, in as many parts as it takes,
      // of a character that JSON writes as six.
      parts: Array.from({ length: maxParts }, (_, index) => ({
        id: `01932c07-0000-7000-8000-2${index.toString(16).padStart(11, "0")}`,
        text: "\u0000".repeat(maxOwnTextLength / maxParts),
      })),
    },
  ],
  [
    "part.add",
    {
      id: partId,
      postId,
      channelId,
      afterId: partId,
      text: "\u0000".repeat(maxPartTextLength),
    },
  ],
  ["part.setText", { id: partId, text: "\u0000".repeat(maxPartTextLength) }],
  [
    "post.create",
    { id: postId, partId, text: "\u0000".repeat(maxPartTextLength) },
  ],
] as const)(
  "fits the longest %s that the mutator takes into one message",
  (name, args) => {
    // The schemas of the arguments are what keeps a mutation within a
    // message: this is the longest that each lets through.
    expect(mutators[name].schema.safeParse(args).success).toBe(true);
    expect(messageLength({ name, args })).toBeLessThanOrEqual(
      syncLimits.clientMessageLength,
    );
  },
);
