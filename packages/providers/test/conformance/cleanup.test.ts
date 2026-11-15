import { describe, expect, it } from "vitest";
import { type Leftover, removeAll } from "./cleanup.ts";

describe("removeAll", () => {
  /** Three posts, of which the network refuses to delete those in `refused`. */
  function posts(refused: string[]) {
    const removed: string[] = [];
    const list: Leftover[] = ["1", "2", "3"].map((id) => ({
      id,
      url: id === "3" ? null : `https://mastodon.example/@ada/${id}`,
      remove: async () => {
        if (refused.includes(id))
          throw new Error(`No more deletions for ${id}`);
        removed.push(id);
      },
    }));
    return { list, removed };
  }

  it("deletes every post", async () => {
    const { list, removed } = posts([]);
    await removeAll(list);
    expect(removed).toEqual(["1", "2", "3"]);
  });

  it("goes on after a deletion that failed, and names what is left", async () => {
    const { list, removed } = posts(["1", "3"]);
    const error = await removeAll(list).catch((thrown: unknown) => thrown);
    // The post after the first failure is deleted all the same.
    expect(removed).toEqual(["2"]);
    expect(error).toBeInstanceOf(Error);
    // By its address where there is one, so that a person can find it.
    expect((error as Error).message).toBe(
      [
        "2 of 3 posts could not be deleted and are still on the network. Delete them by hand:",
        "https://mastodon.example/@ada/1: No more deletions for 1",
        "3: No more deletions for 3",
      ].join("\n"),
    );
  });
});
