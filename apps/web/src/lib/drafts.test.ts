import { describe, expect, it } from "vitest";
import { selectDrafts, threadLabel } from "@/lib/drafts";
import { part, post, tablesOf, target } from "@/lib/rows.test-support";

describe("selectDrafts", () => {
  it("has the parts of a thread in the order they are read in", () => {
    const draft = post();
    const third = part(draft.id, { position: 2, text: "Three" });
    const first = part(draft.id, { position: 0, text: "One\nmore" });
    const second = part(draft.id, { position: 1, text: "Two" });
    const [item] = selectDrafts(
      tablesOf({ post: [draft], post_part: [third, first, second] }),
    );
    expect(item?.parts).toEqual([first, second, third]);
    // The list shows the first line, then what follows, of every part.
    expect(item).toMatchObject({ title: "One", snippet: "more Two Three" });
    expect(item && threadLabel(item)).toBe("3 parts");
  });

  it("says nothing of the length of a post of one part", () => {
    const draft = post();
    const [item] = selectDrafts(
      tablesOf({ post: [draft], post_part: [part(draft.id)] }),
    );
    expect(item && threadLabel(item)).toBeNull();
  });

  it("leaves the text that is written for one account out of the draft", () => {
    const draft = post();
    const own = part(draft.id, { text: "The post" });
    const toAccount = target(draft.id, "01900000-0000-7000-8000-00000000cccc");
    const [item] = selectDrafts(
      tablesOf({
        post: [draft],
        post_target: [toAccount],
        post_part: [
          own,
          // Before the post's own part by its position, to show that it
          // is not taken for the first part of the draft.
          part(draft.id, { targetId: toAccount.id, text: "For one account" }),
        ],
      }),
    );
    expect(item?.parts).toEqual([own]);
    expect(item?.title).toBe("The post");
  });

  it("calls a draft empty only when none of its parts has text", () => {
    const empty = post();
    const started = post();
    const drafts = selectDrafts(
      tablesOf({
        post: [empty, started],
        post_part: [
          part(empty.id, { text: "" }),
          part(empty.id, { position: 1, text: "" }),
          part(started.id, { text: "" }),
          part(started.id, { position: 1, text: "Later part" }),
        ],
      }),
    );
    expect(
      Object.fromEntries(drafts.map((draft) => [draft.id, draft.empty])),
    ).toEqual({ [empty.id]: true, [started.id]: false });
    // The title is the first line that has something in it.
    expect(drafts.find(({ id }) => id === started.id)?.title).toBe(
      "Later part",
    );
  });

  it("hands out the same draft for the same rows, and another when a part has changed", () => {
    const typedIn = post();
    const other = post();
    const one = part(typedIn.id, { position: 0, text: "One" });
    const two = part(typedIn.id, { position: 1, text: "Two" });
    const untouched = part(other.id);
    const before = selectDrafts(
      tablesOf({ post: [typedIn, other], post_part: [one, two, untouched] }),
    );
    // Typing puts another row in the place of the part and of its post.
    const after = selectDrafts(
      tablesOf({
        post: [{ ...typedIn, updatedAt: 2 }, other],
        post_part: [one, { ...two, text: "Two!" }, untouched],
      }),
    );
    const of = (drafts: typeof before, id: string) =>
      drafts.find((draft) => draft.id === id);
    // The list goes by this to render one row and not all of them.
    expect(of(after, other.id)).toBe(of(before, other.id));
    expect(of(after, typedIn.id)).not.toBe(of(before, typedIn.id));
    // And the editor of a thread to render one field: the part that was
    // not typed into is the object it was.
    expect(of(after, typedIn.id)?.parts[0]).toBe(
      of(before, typedIn.id)?.parts[0],
    );
  });
});
