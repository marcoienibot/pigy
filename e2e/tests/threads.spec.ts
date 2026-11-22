import {
  backToList,
  channelChoice,
  connectSimulated,
  connectSimulatedBluesky,
  counterOf,
  deliveryTo,
  draftRow,
  draftRows,
  editor,
  expectSync,
  feedOf,
  grace,
  graceOnBluesky,
  openScreen,
  overflowOf,
  partField,
  partTexts,
  publishPanel,
  sentPost,
  writeDraft,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

// The editor of a thread: the parts of a draft, how long each is for the
// accounts that get it, and the text that one account gets in place of the
// post's. Each test is somebody of its own, in a sandbox of their own:
// `ownPage`.

/** The notices of the app, which the notice library lists. */
function notice(page: Page, text: string) {
  return page.getByRole("listitem").filter({ hasText: text });
}

/** The editor of the draft that is open. */
function draftEditor(page: Page) {
  return page.getByRole("region", { name: "Draft" });
}

/** Opens a new draft and writes a thread into it, one part per text. */
async function writeThread(page: Page, ...texts: string[]): Promise<void> {
  const [first = "", ...more] = texts;
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(first);
  for (const [index, text] of more.entries()) {
    // After the last part, which is the one before this one.
    await draftEditor(page)
      .getByRole("button", {
        name: index === 0 ? "Add a part" : `Add a part after part ${index + 1}`,
      })
      .click();
    await partField(page, index + 2).fill(text);
  }
}

test("a thread is written part by part, with the keys and the buttons, reordered, and listed as a thread", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("One");

  // The button under the text adds a part below and takes the keyboard
  // there.
  await draftEditor(page).getByRole("button", { name: "Add a part" }).click();
  await expect(partField(page, 2)).toBeFocused();
  await page.keyboard.type("Three");
  // And so do the keys, from the text of a part.
  await partField(page, 2).press("ControlOrMeta+Shift+Enter");
  await expect(partField(page, 3)).toBeFocused();
  await page.keyboard.type("Two");
  expect(await partTexts(page)).toEqual(["One", "Three", "Two"]);
  await expect(draftEditor(page)).toContainText("Thread of 3 parts");

  // The keys that add a part do not publish, which the same keys without
  // Shift do: the draft is still open, and nothing says that it went out.
  await expect(notice(page, "Publishing")).toHaveCount(0);

  // A part moves up, past the one before it.
  await draftEditor(page)
    .getByRole("button", { name: "Move part 3 up" })
    .click();
  expect(await partTexts(page)).toEqual(["One", "Two", "Three"]);
  // And down again, to the end, where its button has nothing left to do:
  // the keyboard is in the text of the part that moved.
  await draftEditor(page)
    .getByRole("button", { name: "Move part 2 down" })
    .click();
  expect(await partTexts(page)).toEqual(["One", "Three", "Two"]);
  await expect(partField(page, 3)).toBeFocused();
  await draftEditor(page)
    .getByRole("button", { name: "Move part 2 down" })
    .click();
  expect(await partTexts(page)).toEqual(["One", "Two", "Three"]);

  // ↑ at the very beginning of a part goes to the end of the part before,
  // and ↓ at the very end to the beginning of the next.
  await partField(page, 2).focus();
  await partField(page, 2).press("ControlOrMeta+Home");
  await partField(page, 2).press("ArrowUp");
  await expect(partField(page, 1)).toBeFocused();
  // Typing shows where the caret is: at the end.
  await page.keyboard.type("!");
  await expect(partField(page, 1)).toHaveValue("One!");
  await partField(page, 1).press("ArrowDown");
  await expect(partField(page, 2)).toBeFocused();
  await page.keyboard.type(">");
  await expect(partField(page, 2)).toHaveValue(">Two");

  // ⌫ in a part that is empty removes the part, and the keyboard is at the
  // end of the part before.
  await partField(page, 3).press("ControlOrMeta+Shift+Enter");
  await expect(partField(page, 4)).toBeFocused();
  await partField(page, 4).press("Backspace");
  await expect(partField(page, 4)).toHaveCount(0);
  await expect(partField(page, 3)).toBeFocused();
  expect(await partTexts(page)).toEqual(["One!", ">Two", "Three"]);
  // No page is wider than its window, with the buttons of three parts.
  expect(await overflowOf(page)).toBe(0);

  // A part that has text is removed with its button, and can be brought
  // back, to where it was.
  await draftEditor(page)
    .getByRole("button", { name: "Remove part 2" })
    .click();
  expect(await partTexts(page)).toEqual(["One!", "Three"]);
  await notice(page, "Part removed")
    .getByRole("button", { name: "Undo" })
    .click();
  expect(await partTexts(page)).toEqual(["One!", ">Two", "Three"]);

  // The list shows the draft as a thread.
  await backToList(page, isMobile);
  await expect(draftRow(page, "One!")).toContainText("3 parts");

  // All of it was saved as it was done: the thread is there, in its
  // order, after the page was loaded again.
  await expectSync(page, "Synced");
  await page.reload();
  await draftRow(page, "One!").click();
  await expect(partField(page, 3)).toHaveValue("Three");
  expect(await partTexts(page)).toEqual(["One!", ">Two", "Three"]);
});

test("each part is counted the way the network of each chosen account counts, and says so near the limit and over it", async ({
  ownPage: page,
}) => {
  // Two accounts are connected first, each through its consent page,
  // which is most of the time that other tests have for all they do.
  test.setTimeout(90_000);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await connectSimulatedBluesky(page, graceOnBluesky);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  // A link, which Mastodon counts as 23 characters however long it is,
  // and Bluesky as what it is.
  const link = `https://example.com/${"x".repeat(40)}`;
  await editor(page).fill(`See ${link}`);

  // With no account chosen there is no network to count for: the count is
  // a person's.
  await expect(draftEditor(page)).toContainText("64 characters");
  await expect(draftEditor(page).locator("[data-tone]")).toHaveCount(0);

  await channelChoice(page, grace).click();
  await channelChoice(page, graceOnBluesky).click();
  await expect(counterOf(editor(page), "Mastodon")).toHaveText(
    /^Mastodon 27\/500/,
  );
  await expect(counterOf(editor(page), "Bluesky")).toHaveText(
    /^Bluesky 64\/300/,
  );
  await expect(counterOf(editor(page), "Mastodon")).toHaveAttribute(
    "data-tone",
    "ok",
  );
  await expect(draftEditor(page)).not.toContainText("64 characters");

  // Near the limit of Bluesky, and far from Mastodon's.
  await editor(page).fill("a".repeat(280));
  await expect(counterOf(editor(page), "Bluesky")).toHaveAttribute(
    "data-tone",
    "near",
  );
  await expect(counterOf(editor(page), "Mastodon")).toHaveAttribute(
    "data-tone",
    "ok",
  );

  // A second part, which is counted by itself: over the limit of Bluesky,
  // which the editor says for that part and that account, and which keeps
  // the post back.
  await draftEditor(page).getByRole("button", { name: "Add a part" }).click();
  await partField(page, 2).fill("b".repeat(301));
  await expect(counterOf(partField(page, 2), "Bluesky")).toHaveText(
    /^Bluesky 301\/300/,
  );
  await expect(counterOf(partField(page, 2), "Bluesky")).toHaveAttribute(
    "data-tone",
    "over",
  );
  await expect(counterOf(partField(page, 1), "Bluesky")).toHaveAttribute(
    "data-tone",
    "near",
  );
  await expect(publishPanel(page)).toContainText(
    `Bluesky would refuse this for ${graceOnBluesky}: Part 2 is 301 characters long. The limit is 300.`,
  );
  const publish = publishPanel(page).getByRole("button", {
    name: "Publish now",
  });
  await expect(publish).toBeDisabled();

  // A part that is empty keeps the post back too, and is named.
  await partField(page, 2).fill("");
  await expect(publishPanel(page).getByRole("status")).toHaveText(
    "Part 2 is empty: write something in it, or remove it.",
  );
  await expect(publish).toBeDisabled();
  await partField(page, 2).fill("Short");
  await expect(publish).toBeEnabled();
  expect(await overflowOf(page)).toBe(0);
});

test("one account gets a text of its own while the other gets the post's, and the Sent screen and the feeds show which", async ({
  ownPage: page,
}) => {
  // Two accounts are connected first, each through its consent page,
  // which is most of the time that other tests have for all they do.
  test.setTimeout(90_000);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await connectSimulatedBluesky(page, graceOnBluesky);
  await openScreen(page, "Drafts");
  await writeThread(page, "For everyone, one", "For everyone, two");
  await channelChoice(page, grace).click();
  await channelChoice(page, graceOnBluesky).click();

  // The text for one account begins as the post's, thread and all.
  const customizeBluesky = draftEditor(page).getByRole("button", {
    name: `Customize for ${graceOnBluesky}`,
  });
  await customizeBluesky.click();
  const forBluesky = (number: number) =>
    page.getByRole("textbox", {
      name: `Part ${number} for ${graceOnBluesky}`,
    });
  await expect(forBluesky(1)).toHaveValue("For everyone, one");
  await expect(forBluesky(2)).toHaveValue("For everyone, two");
  await expect(draftEditor(page)).toContainText(
    `Only ${graceOnBluesky} gets this text.`,
  );
  // It is that account's alone, so it is counted for that account alone.
  await expect(counterOf(forBluesky(1), "Bluesky")).toBeVisible();
  await expect(counterOf(forBluesky(1), "Mastodon")).toHaveCount(0);

  // It becomes one post, where the post's own text stays a thread.
  await draftEditor(page)
    .getByRole("button", { name: "Remove part 2" })
    .click();
  const ownText = page.getByRole("textbox", {
    name: `Text for ${graceOnBluesky}`,
  });
  await ownText.fill("Only for Bluesky");

  // The post's own text is as it was, and is counted for the account
  // that still gets it.
  const texts = draftEditor(page).getByRole("group", { name: "Text to edit" });
  await texts.getByRole("button", { name: "Post text" }).click();
  expect(await partTexts(page)).toEqual([
    "For everyone, one",
    "For everyone, two",
  ]);
  await expect(counterOf(partField(page, 1), "Mastodon")).toBeVisible();
  await expect(counterOf(partField(page, 1), "Bluesky")).toHaveCount(0);

  // A text of its own can be dropped again: the account then gets the
  // post's, and can be given another.
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  await expect(
    page.getByRole("textbox", { name: `Part 1 for ${grace}` }),
  ).toBeVisible();
  await draftEditor(page)
    .getByRole("button", { name: "Use the post's text" })
    .click();
  await expect(
    draftEditor(page).getByRole("button", { name: `Customize for ${grace}` }),
  ).toBeVisible();
  await expect(partField(page, 1)).toHaveValue("For everyone, one");
  expect(await overflowOf(page)).toBe(0);

  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  await expect(editor(page)).toHaveCount(0);

  // The Sent screen has the post by its own text, and says for the
  // account that got another what went there.
  await openScreen(page, "Sent");
  const post = sentPost(page, "For everyone, one");
  const toBluesky = deliveryTo(post, graceOnBluesky);
  const toMastodon = deliveryTo(post, grace);
  await expect(toBluesky).toContainText("Sent");
  await expect(toMastodon).toContainText("Sent");
  await expect(toBluesky).toContainText("Got a text of its own");
  await expect(
    toBluesky.getByRole("list", { name: `Text for ${graceOnBluesky}` }),
  ).toHaveText("Only for Bluesky");
  await expect(toMastodon).not.toContainText("a text of its own");
  expect(await overflowOf(page)).toBe(0);

  // And the simulated networks have what each was sent: the thread on
  // Mastodon, the one post on Bluesky.
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace).getByRole("article")).toHaveText([
    /For everyone, one/,
    /For everyone, two/,
  ]);
  await expect(feedOf(page, graceOnBluesky).getByRole("article")).toHaveText([
    /Only for Bluesky/,
  ]);
});

test("a thread that is deleted comes back with all its parts in their order, and with the text of the account that had its own", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await writeThread(page, "First", "Second", "Third");
  await channelChoice(page, grace).click();
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  await page
    .getByRole("textbox", { name: `Part 2 for ${grace}` })
    .fill("Second, for Grace");

  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(draftRow(page, "First")).toHaveCount(0);
  await notice(page, "Draft deleted")
    .getByRole("button", { name: "Undo" })
    .click();

  // A new draft, with every part where it was.
  await expect(partField(page, 3)).toHaveValue("Third");
  expect(await partTexts(page)).toEqual(["First", "Second", "Third"]);
  // It goes where the deleted one went, with the text that was written
  // for that account.
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await draftEditor(page)
    .getByRole("group", { name: "Text to edit" })
    .getByRole("button", { name: grace })
    .click();
  expect(await partTexts(page)).toEqual([
    "First",
    "Second, for Grace",
    "Third",
  ]);

  // The server has taken all of it: nothing was refused, and the copy of
  // this device is the server's.
  await expectSync(page, "Synced");
  await expect(notice(page, "was not")).toHaveCount(0);
  await backToList(page, isMobile);
  await expect(draftRow(page, "First")).toHaveCount(1);
  await expect(draftRow(page, "First")).toContainText("3 parts");
});

test("a draft with nothing of its own and a text for an account is no empty draft: New draft makes another, and the list calls it by that text", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("To begin with");
  await channelChoice(page, grace).click();
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  await page
    .getByRole("textbox", { name: `Text for ${grace}` })
    .fill("Written for Grace");
  // The post's own text is emptied: the one account has its own.
  await draftEditor(page)
    .getByRole("group", { name: "Text to edit" })
    .getByRole("button", { name: "Post text" })
    .click();
  await editor(page).fill("");

  // The list has the draft by what is written in it.
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
  await expect(draftRow(page, "Written for Grace")).toBeVisible();
  await expect(draftRows(page)).not.toContainText(["Empty draft"]);

  // "New draft" does not take it for a draft that nobody has begun.
  await page.getByRole("button", { name: "New draft" }).click();
  await expect(editor(page)).toBeFocused();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(2);
});

test("a text for an account that has grown longer than one step carries comes back whole, with the account that was left out and with the draft that was deleted", async ({
  ownPage: page,
}) => {
  // Five long parts are typed in.
  test.setTimeout(90_000);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await writeThread(page, "1", "2", "3", "4", "5");
  await channelChoice(page, grace).click();
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  // The text begins within what `target.customize` carries, and grows
  // past it by ordinary edits: 45,000 characters, where 40,000 is the
  // most that one mutation gives an account.
  const long = Array.from({ length: 5 }, (_, index) =>
    `Part ${index + 1} `.padEnd(9000, "x"),
  );
  const forGrace = (number: number) =>
    page.getByRole("textbox", { name: `Part ${number} for ${grace}` });
  for (const [index, text] of long.entries()) {
    await forGrace(index + 1).fill(text);
  }
  await expectSync(page, "Synced");

  // The account is left out, and its text goes with it.
  await channelChoice(page, grace).click();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await notice(page, `${grace} left out, and its own text with it`)
    .getByRole("button", { name: "Undo" })
    .click();
  // It is back, with all of its text, part by part.
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const texts = draftEditor(page).getByRole("group", { name: "Text to edit" });
  await texts.getByRole("button", { name: grace }).click();
  await expect(forGrace(5)).toHaveValue(long[4] ?? "");
  expect(await partTexts(page)).toEqual(long);
  // And the server has taken it: nothing was refused, and nothing waits
  // in front of what comes after.
  await expectSync(page, "Synced");
  await expect(notice(page, "was not")).toHaveCount(0);

  // The same for the draft as a whole.
  await page.getByRole("button", { name: "Delete draft" }).click();
  await notice(page, "Draft deleted")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(partField(page, 5)).toHaveValue("5");
  await draftEditor(page)
    .getByRole("group", { name: "Text to edit" })
    .getByRole("button", { name: grace })
    .click();
  await expect(forGrace(5)).toHaveValue(long[4] ?? "");
  expect(await partTexts(page)).toEqual(long);
  await expectSync(page, "Synced");
  await expect(notice(page, "was not")).toHaveCount(0);
});

test("the keys of a part are left to an input method while it composes a character", async ({
  ownPage: page,
}) => {
  await writeThread(page, "One", "", "Three");
  /**
   * Presses `key` in the part `number` as a browser reports it while an
   * input method composes: with `isComposing`, or with `keyCode` 229,
   * which is what Safari says for the key that ends a composition.
   * Returns whether the app took the key for its own.
   */
  const composing = (
    number: number,
    key: string,
    init: Record<string, boolean | number> = { isComposing: true },
  ): Promise<boolean> =>
    partField(page, number).evaluate(
      (field, { key: pressed, init: extra }) =>
        !field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: pressed,
            bubbles: true,
            cancelable: true,
            ...extra,
          }),
        ),
      { key, init },
    );

  // ↓ at the end of a part goes through the candidates of the input
  // method: the keyboard stays in the part.
  await partField(page, 1).focus();
  await partField(page, 1).press("ControlOrMeta+End");
  expect(await composing(1, "ArrowDown")).toBe(false);
  await expect(partField(page, 1)).toBeFocused();
  // ↑ at the beginning of a part.
  await partField(page, 3).focus();
  await partField(page, 3).press("ControlOrMeta+Home");
  expect(await composing(3, "ArrowUp")).toBe(false);
  await expect(partField(page, 3)).toBeFocused();
  // ⌫ in an empty part takes back what is being composed, and the part
  // stays. So it does when the browser says 229 and nothing else.
  await partField(page, 2).focus();
  expect(await composing(2, "Backspace")).toBe(false);
  expect(await composing(2, "Backspace", { keyCode: 229 })).toBe(false);
  // The keys that add a part, and Escape, which closes the candidates and
  // not the text.
  expect(
    await composing(2, "Enter", {
      isComposing: true,
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    }),
  ).toBe(false);
  expect(await composing(2, "Escape")).toBe(false);
  await expect(partField(page, 2)).toBeFocused();
  expect(await partTexts(page)).toEqual(["One", "", "Three"]);

  // The same keys without a composition are the thread's: the test would
  // pass for a page that takes no key at all otherwise.
  expect(await composing(2, "Backspace", {})).toBe(true);
  expect(await partTexts(page)).toEqual(["One", "Three"]);
});

test("the keyboard stays in the draft when what was pressed leaves the page: a text of its own, the post's text again, and what a notice brings back", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  // A draft next to the one of the test: where the list is on screen, its
  // row gets the keyboard when the other is deleted, and a notice hands
  // the keyboard back to where it was.
  await writeDraft(page, isMobile, "A neighbour");
  await writeThread(page, "First", "Second");
  await channelChoice(page, grace).click();
  const forGrace = (number: number) =>
    page.getByRole("textbox", { name: `Part ${number} for ${grace}` });

  // "Customize" is gone once the account has its text. The keyboard is in
  // the first part of that text, and not on the page, where the next key
  // would open another draft or delete this one.
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  await expect(forGrace(1)).toBeFocused();
  // Typing shows it: at the end of the part.
  await page.keyboard.type("!");
  await expect(forGrace(1)).toHaveValue("First!");

  // "Use the post's text" goes with the text that it drops.
  await draftEditor(page)
    .getByRole("button", { name: "Use the post's text" })
    .click();
  await expect(partField(page, 1)).toBeFocused();

  // The notice of an account that was left out goes when its "Undo" is
  // pressed: the keyboard is on the choice that is back.
  await draftEditor(page)
    .getByRole("button", { name: `Customize for ${grace}` })
    .click();
  await expect(forGrace(1)).toBeFocused();
  await channelChoice(page, grace).click();
  await notice(page, `${grace} left out, and its own text with it`)
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(channelChoice(page, grace)).toBeFocused();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // A part that is brought back has the keyboard. The editor shows the
  // text of the account again, which is what it showed when the account
  // was left out.
  await expect(forGrace(2)).toHaveValue("Second");
  await draftEditor(page)
    .getByRole("button", { name: "Remove part 2" })
    .click();
  await notice(page, "Part removed")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(forGrace(2)).toBeFocused();
  await expect(forGrace(2)).toHaveValue("Second");

  // And so has the text of a draft that is brought back: ⌫ then deletes
  // a character, and not the draft a second time.
  await page.getByRole("button", { name: "Delete draft" }).click();
  await notice(page, "Draft deleted")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(partField(page, 1)).toBeFocused();
  await page.keyboard.press("Backspace");
  expect(await partTexts(page)).toEqual(["Firs", "Second"]);
  await backToList(page, isMobile);
  await expect(draftRow(page, "A neighbour")).toBeVisible();
});
