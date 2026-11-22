import { describe, expect, it } from "vitest";
import { selectDrafts, threadLabel } from "@/lib/drafts";
import {
  media,
  part,
  partMedia,
  post,
  tablesOf,
  target,
} from "@/lib/rows.test-support";

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
    const toAccount = target(draft.id, "01900000-0000-7000-8000-00000000cccc");
    // Made first, so that its ID is the lower one: `inReadingOrder` puts
    // it before the post's own part, which has the same position.
    const account = part(draft.id, {
      targetId: toAccount.id,
      text: "For one account",
    });
    const own = part(draft.id, { text: "The post" });
    const [item] = selectDrafts(
      tablesOf({
        post: [draft],
        post_target: [toAccount],
        // The account's part is the first of the two rows, and has the
        // same position as the post's own. A draft that took its parts in
        // the order of the table, or by position alone, would begin with
        // it.
        post_part: [account, own],
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

  it("is not empty, and has a title, when only the texts of its accounts have something in them", () => {
    const draft = post();
    const toAda = target(draft.id, "01900000-0000-7000-8000-00000000aaaa");
    const toGrace = target(draft.id, "01900000-0000-7000-8000-00000000bbbb");
    const [item] = selectDrafts(
      tablesOf({
        post: [draft],
        post_target: [toAda, toGrace],
        post_part: [
          // The post's own text is empty: every account has its own.
          part(draft.id, { text: "" }),
          part(draft.id, { targetId: toAda.id, text: "  " }),
          part(draft.id, {
            targetId: toGrace.id,
            position: 1,
            text: "second line",
          }),
          part(draft.id, { targetId: toGrace.id, text: "For Grace" }),
        ],
      }),
    );
    expect(item).toMatchObject({
      empty: false,
      untouched: false,
      // The first text of an account that has something in it, in its
      // order, and not a mix of the texts.
      title: "For Grace",
      snippet: "second line",
    });
  });

  it("does not take a draft with an image and no text for an empty one", () => {
    const draft = post();
    const text = part(draft.id, { text: "" });
    const image = media();
    const rows = { post: [draft], post_part: [text], media: [image] };
    const [without] = selectDrafts(tablesOf(rows));
    expect(without).toMatchObject({ empty: true, untouched: true, title: "" });
    // The same rows with the image in the part: the draft is somebody's
    // work, which "New draft" must not take up and a deletion must offer
    // to bring back.
    const [withImage] = selectDrafts(
      tablesOf({ ...rows, part_media: [partMedia(text.id, image.id)] }),
    );
    expect(withImage).toMatchObject({
      empty: false,
      untouched: false,
      title: "An image",
    });
  });

  it("calls a draft untouched only when it has no text and goes nowhere", () => {
    const blank = post();
    const chosen = post();
    const customized = post();
    const toChosen = target(chosen.id, "01900000-0000-7000-8000-00000000aaaa");
    const toCustomized = target(
      customized.id,
      "01900000-0000-7000-8000-00000000aaaa",
    );
    const drafts = selectDrafts(
      tablesOf({
        post: [blank, chosen, customized],
        post_target: [toChosen, toCustomized],
        post_part: [
          part(blank.id, { text: "" }),
          // Empty, and somebody has chosen where it goes.
          part(chosen.id, { text: "" }),
          // Empty of its own, with a text for its account.
          part(customized.id, { text: "" }),
          part(customized.id, { targetId: toCustomized.id, text: "Written" }),
        ],
      }),
    );
    // "New draft" takes up the first again, and neither of the others.
    expect(
      Object.fromEntries(drafts.map((draft) => [draft.id, draft.untouched])),
    ).toEqual({ [blank.id]: true, [chosen.id]: false, [customized.id]: false });
  });

  it("hands out another draft when its account went with its text, which leaves the row of the post as it was", () => {
    const draft = post();
    const own = part(draft.id, { text: "" });
    const toAccount = target(draft.id, "01900000-0000-7000-8000-00000000aaaa");
    const account = part(draft.id, { targetId: toAccount.id, text: "Written" });
    const [before] = selectDrafts(
      tablesOf({
        post: [draft],
        post_target: [toAccount],
        post_part: [own, account],
      }),
    );
    // What a disconnect of the channel does: no mutator touches the post.
    const [after] = selectDrafts(tablesOf({ post: [draft], post_part: [own] }));
    expect(before).toMatchObject({ title: "Written", untouched: false });
    expect(after).toMatchObject({ title: "", empty: true, untouched: true });
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
