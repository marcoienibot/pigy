import {
  backToList,
  draftRow,
  draftRows,
  editor,
  expectSync,
  writeDraft,
} from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("drafts are listed with a title, a snippet and the newest edit first", async ({
  ownPage: page,
  isMobile,
}) => {
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();

  await writeDraft(page, isMobile, "First draft\n\nWith a second paragraph");
  await writeDraft(page, isMobile, "Second draft");

  await expect(draftRows(page)).toHaveCount(2);
  // The first line is the title, what follows is the snippet.
  await expect(draftRow(page, "First draft")).toContainText(
    "With a second paragraph",
  );
  await expect(draftRows(page).first()).toContainText("Second draft");

  // An edit moves a draft to the top.
  await draftRow(page, "First draft").click();
  await editor(page).fill("First draft, edited");
  await backToList(page, isMobile);
  await expect(draftRows(page).first()).toContainText("First draft, edited");
  await expect(draftRows(page)).toHaveCount(2);
});

test("a draft is saved as it is typed and is there after a reload", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  // The field has the focus: the keys go to the text.
  await page.keyboard.type("Typed, not saved by hand");
  await expect(page.getByText("24 characters")).toBeVisible();
  await expectSync(page, "Synced");

  await page.reload();

  // The address names the draft, so it is open again.
  await expect(editor(page)).toHaveValue("Typed, not saved by hand");
  await backToList(page, isMobile);
  await expect(draftRow(page, "Typed, not saved by hand")).toBeVisible();
});

test("the character count counts what a person sees", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();

  await expect(page.getByText("0 characters")).toBeVisible();
  // A family of four is seven code points and eleven UTF-16 units.
  await editor(page).fill("👨‍👩‍👧‍👦");
  await expect(page.getByText("1 character", { exact: true })).toBeVisible();
});

test("a deleted draft can be brought back", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Keep me");
  await writeDraft(page, isMobile, "Delete me");

  await draftRow(page, "Delete me").click();
  await page.getByRole("button", { name: "Delete draft" }).click();

  await expect(draftRow(page, "Delete me")).toHaveCount(0);
  const notice = page
    .getByRole("listitem")
    .filter({ hasText: "Draft deleted" });
  await notice.getByRole("button", { name: "Undo" }).click();

  await expect(notice).toHaveCount(0);
  // It is open again, with its text.
  await expect(editor(page)).toHaveValue("Delete me");
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(2);
});

test("the keyboard creates, edits, leaves, moves and deletes", async ({
  ownPage: page,
  isMobile,
}) => {
  // On a phone the list and the editor are not side by side, and there is
  // no keyboard for shortcuts: the test after this one is about phones.
  test.skip(isMobile, "Shortcuts are for a keyboard next to the list");

  // The shortcut for a new draft works on every screen.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Queue" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");
  await page.keyboard.press("c");
  await expect(editor(page)).toBeFocused();
  // Letters that are shortcuts are text while the field has the focus.
  await page.keyboard.type("jack");
  await expect(editor(page)).toHaveValue("jack");
  await expect(draftRows(page)).toHaveCount(1);

  // Out of the text, and a second draft.
  await page.keyboard.press("Escape");
  await expect(draftRow(page, "jack")).toBeFocused();
  await page.keyboard.press("c");
  await page.keyboard.type("Second");
  await page.keyboard.press("Escape");
  await expect(draftRows(page)).toHaveCount(2);

  // Down the list to the older draft, which opens next to it.
  await page.keyboard.press("j");
  await expect(editor(page)).toHaveValue("jack");
  await expect(draftRow(page, "jack")).toHaveAttribute("aria-current", "page");
  // Enter goes into the text, at its end.
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and jill");
  await expect(editor(page)).toHaveValue("jack and jill");

  // The edit has moved the draft to the top, so the other one is below
  // it now. Down with the arrow, and delete what is open.
  await page.keyboard.press("Escape");
  await expect(draftRows(page).first()).toContainText("jack and jill");
  await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toHaveValue("Second");
  await page.keyboard.press("Backspace");
  await expect(draftRow(page, "Second")).toHaveCount(0);
  // The editor moves on to the draft that is left.
  await expect(editor(page)).toHaveValue("jack and jill");

  // Undo brings it back, and Escape closes the draft.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor(page)).toHaveValue("Second");
  await expect(draftRows(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL("/");
});

test("on a phone the editor takes the screen and leads back to the list", async ({
  ownPage: page,
  isMobile,
}) => {
  test.skip(!isMobile, "The desktop shows the list and the editor together");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The page has no viewport");

  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Written on a phone");

  // The whole screen, navigation included: there is no room to spare
  // next to a keyboard.
  const box = await page.getByRole("region", { name: "Draft" }).boundingBox();
  expect(box).toEqual({ x: 0, y: 0, ...viewport });
  await expect(draftRows(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Back to drafts" }).click();
  await expect(draftRow(page, "Written on a phone")).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  // The list must not scroll sideways, whatever the length of a row.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // The back button of the browser does the same.
  await draftRow(page, "Written on a phone").click();
  await expect(editor(page)).toHaveValue("Written on a phone");
  await page.goBack();
  await expect(editor(page)).toHaveCount(0);

  // Deleting leads back to the list.
  await draftRow(page, "Written on a phone").click();
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
});

test("the command palette creates a draft, changes the theme and goes to a screen", async ({
  ownPage: page,
}) => {
  const palette = page.getByRole("dialog", { name: "Commands" });
  const html = page.locator("html");
  await page.emulateMedia({ colorScheme: "light" });

  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("dark");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(html).toContainClass("dark");

  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("queue");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");

  // From another screen: the draft opens on the drafts screen.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("new draft");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  // The palette opens while typing too, and the key is not text then.
  await page.keyboard.type("k");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveValue("k");
});
