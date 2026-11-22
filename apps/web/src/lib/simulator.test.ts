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
  faultOperation,
  firstNetwork,
  makesWait,
  offeredOperations,
  selectDeliveries,
  selectSending,
} from "@/lib/simulator";

function feedPost(id: string, replies: SandboxPost[] = []): SandboxPost {
  return { id, text: id, createdAt: 1, entities: [], card: null, replies };
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

  it("has words for the fault and the requests that only Threads has", () => {
    expect(faultKind("slow-processing", "threads")).toEqual({
      label: "Slow to prepare",
      description: expect.stringContaining("half a minute"),
    });
    for (const operation of ["container", "exchange", "refresh"]) {
      // Words, and not the name that the server has for the request.
      expect(faultOperation(operation)).not.toBe(operation);
    }
  });

  it("says of a fault on LinkedIn what pigy does there, where it cannot look for a post", () => {
    // On Mastodon pigy waits and tries again, and finds a post whose
    // answer was lost. On LinkedIn it does neither.
    expect(faultKind("lost-response", "mastodon").description).toContain(
      "finds the post there",
    );
    for (const kind of ["lost-response", "server-error"]) {
      expect(faultKind(kind, "linkedin").description).toContain(
        "does not try again, and asks you to look",
      );
      expect(makesWait(kind, "linkedin")).toBe(false);
      expect(makesWait(kind, "mastodon")).toBe(true);
    }
    // A limit of LinkedIn's is for the day: the adapter names midnight
    // UTC, and the workflow waits for a time that is an hour away at
    // most. So the panel promises neither a failure nor a wait, and says
    // nothing of a post alone: the fault can be armed for connecting.
    const limited = faultKind("rate-limit", "linkedin").description;
    expect(limited).toContain("only when that is less than an hour away");
    expect(limited).not.toContain("The post fails");
    // The same kind under the same name on both.
    expect(faultKind("lost-response", "linkedin").label).toBe(
      faultKind("lost-response", "mastodon").label,
    );
    // A fault that ends a delivery at once makes nobody wait anywhere.
    expect(makesWait("token-revoked", "mastodon")).toBe(false);
    expect(faultKind("token-revoked", "linkedin")).toEqual(
      faultKind("token-revoked", "mastodon"),
    );
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
