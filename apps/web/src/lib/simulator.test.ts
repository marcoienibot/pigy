import type { SandboxPost } from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  channel,
  post,
  result,
  tablesOf,
  target,
} from "@/lib/rows.test-support";
import {
  chainOf,
  faultKind,
  firstNetwork,
  offeredOperations,
  selectDeliveries,
  selectSending,
} from "@/lib/simulator";

function feedPost(id: string, replies: SandboxPost[] = []): SandboxPost {
  return { id, text: id, createdAt: 1, replies };
}

describe("chainOf", () => {
  it("reads a thread as one chain, the way it was written", () => {
    const thread = feedPost("1", [feedPost("2", [feedPost("3")])]);
    const chain = chainOf(thread);
    expect(chain.posts.map(({ id }) => id)).toEqual(["1", "2", "3"]);
    expect(chain.branches).toEqual([]);
  });

  it("goes on in a chain of its own for each reply to a post that has several", () => {
    const thread = feedPost("1", [
      feedPost("2", [feedPost("2a"), feedPost("2b", [feedPost("2b1")])]),
    ]);
    const chain = chainOf(thread);
    expect(chain.posts.map(({ id }) => id)).toEqual(["1", "2"]);
    expect(
      chain.branches.map((branch) => branch.posts.map(({ id }) => id)),
    ).toEqual([["2a"], ["2b", "2b1"]]);
  });
});

describe("the failure panel", () => {
  it("offers posting first, which is what it is there for", () => {
    expect(
      offeredOperations(["instance", "account", "publish", "read"]),
    ).toEqual(["publish", "instance", "account", "read"]);
  });

  it("starts with a network that the sandbox has an account of", () => {
    expect(firstNetwork(["mastodon", "bluesky"], ["bluesky"])).toBe("bluesky");
    expect(firstNetwork(["mastodon", "bluesky"], [])).toBe("mastodon");
  });

  it("shows a kind of fault that it has no words for by its name", () => {
    expect(faultKind("slow-media")).toEqual({
      label: "slow-media",
      description: "",
    });
  });
});

describe("selectDeliveries", () => {
  it("changes when a delivery moves on, and not when a draft chooses a channel", () => {
    const ada = channel();
    const draft = post();
    const published = post({ status: "sending" });
    const queued = target(published.id, ada.id, { status: "queued" });
    const before = selectDeliveries(
      tablesOf({ post: [draft, published], post_target: [queued] }),
    );

    // A channel chosen for a draft has done nothing in the world.
    expect(
      selectDeliveries(
        tablesOf({
          post: [draft, published],
          post_target: [queued, target(draft.id, ada.id)],
        }),
      ),
    ).toBe(before);

    const sending = { ...queued, status: "sending" as const, attempt: 1 };
    const started = selectDeliveries(
      tablesOf({ post: [draft, published], post_target: [sending] }),
    );
    expect(started).not.toBe(before);
    // A part that is published while the target goes on sending.
    expect(
      selectDeliveries(
        tablesOf({
          post: [draft, published],
          post_target: [sending],
          target_part_result: [result(sending.id, "part")],
        }),
      ),
    ).not.toBe(started);
  });
});

describe("selectSending", () => {
  it("says that a delivery is under way only while one is being sent: not for one that waits its turn, has ended or was never asked for", () => {
    const ada = channel();
    const published = post({ status: "sending" });
    const sending = (...statuses: Parameters<typeof target>[2][]) =>
      selectSending(
        tablesOf({
          post: [published],
          post_target: statuses.map((with_) =>
            target(published.id, ada.id, with_),
          ),
        }),
      );
    expect(sending()).toBe(false);
    // Nothing has been asked of a network for any of these, or will be
    // without a change of the workspace.
    expect(
      sending(
        { status: "pending" },
        { status: "queued" },
        { status: "sent" },
        { status: "error" },
      ),
    ).toBe(false);
    expect(sending({ status: "sent" }, { status: "sending" })).toBe(true);
  });
});
