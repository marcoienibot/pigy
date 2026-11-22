import { expect, it } from "vitest";
import { namedScreen } from "./palette.ts";

const screens = [{ label: "Drafts" }, { label: "Queue" }, { label: "Sent" }];

it("finds the screen whose name is typed in full, in whatever case", () => {
  expect(namedScreen("queue", screens)).toBe(screens[1]);
  expect(namedScreen(" Queue ", screens)).toBe(screens[1]);
  expect(namedScreen("SENT", screens)).toBe(screens[2]);
});

it("finds none for a part of a name, for more than a name and for nothing", () => {
  expect(namedScreen("que", screens)).toBeUndefined();
  // What a command is called, which has the name of a screen in it.
  expect(namedScreen("pause the queue", screens)).toBeUndefined();
  expect(namedScreen("", screens)).toBeUndefined();
  expect(namedScreen("  ", screens)).toBeUndefined();
});

it("finds no screen that the workspace does not have", () => {
  // The list that it is given is of the screens of the workspace: the
  // live one has no Simulator.
  expect(namedScreen("simulator", screens)).toBeUndefined();
});
