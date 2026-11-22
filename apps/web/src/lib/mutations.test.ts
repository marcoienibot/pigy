import { expect, it } from "vitest";
import { lostTexts } from "./mutations.ts";

const id = "01932c07-0000-7000-8000-000000000001";

it("has the text of a refused edit", () => {
  expect(
    lostTexts({ name: "part.setText", args: { id, text: "  Written  " } }),
  ).toEqual(["  Written  "]);
});

it("has the text of a part that was refused with its text, as one that an Undo brings back", () => {
  expect(
    lostTexts({
      name: "part.add",
      args: {
        id,
        postId: id,
        channelId: id,
        afterId: null,
        text: "Brought back",
      },
    }),
  ).toEqual(["Brought back"]);
});

it("has the text of a refused text for an account, part after part", () => {
  expect(
    lostTexts({
      name: "target.customize",
      args: {
        postId: id,
        channelId: id,
        // An empty part between two is a part of the thread all the same.
        parts: [
          { id, text: "One" },
          { id, text: "" },
          { id, text: "Three" },
        ],
      },
    }),
  ).toEqual(["One", "", "Three"]);
});

it.each([
  // A part that is added with the keys is empty: nothing to keep.
  ["part.add", { id, postId: id, channelId: null, afterId: null, text: "" }],
  ["part.setText", { id, text: " \n " }],
  [
    "target.customize",
    { postId: id, channelId: id, parts: [{ id, text: "" }] },
  ],
  // A change that carries no text.
  ["target.add", { id, postId: id, channelId: id }],
  // What a copy holds is not checked against this version's mutators.
  ["part.add", null],
  ["part.add", { text: 5 }],
  ["target.customize", { parts: "One" }],
])("has nothing to keep of a refused %s with %j", (name, args) => {
  expect(lostTexts({ name, args })).toEqual([]);
});
