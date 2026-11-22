import {
  channelChoice,
  connectSimulated,
  connectSimulatedBluesky,
  connectSimulatedLinkedIn,
  connectSimulatedThreads,
  editor,
  expectSync,
  feedOf,
  grace,
  graceOnBluesky,
  graceOnLinkedIn,
  graceOnThreads,
  linkPreview,
  markNotes,
  marksIn,
  openScreen,
  overflowOf,
  partField,
  publishPanel,
  sentPost,
} from "../app.ts";
import { expect, type Locator, type Page, test } from "../fixtures.ts";

// What a text has besides its words: the editor marks its links, mentions
// and hashtags as the accounts that get it will take them, previews the
// card of its first link, and the feeds of the sandbox show what each
// simulated network made of the post. Each test is somebody of its own,
// in a sandbox of their own: `ownPage`.
//
// A sandbox reaches a simulated web and nothing else, whose pages are
// under `.test`. The page of a link is read by the Worker and never by
// the browser: the guard of fixtures.ts fails a test whose page asks
// another host for anything, which is what keeps that true.

/** A page of the simulated web, with a card to show. */
const link = "https://example.test/";

/** Chooses the channel of `handle` for the open draft. */
async function choose(page: Page, handle: string): Promise<void> {
  await channelChoice(page, handle).click();
  await expect(channelChoice(page, handle)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/**
 * What decides where the letters of a field stand, and of the layer
 * behind it, which has to have the same of each: or a tint is somewhere
 * else than the word that it is for.
 */
function lettersOf(field: Locator) {
  return field.evaluate((element) => {
    const layer = element.parentElement?.querySelector("[data-marks]");
    if (!layer) throw new Error("The field has no layer behind it");
    const of = (box: Element) => {
      const style = getComputedStyle(box);
      const { width, height, top, left } = box.getBoundingClientRect();
      return {
        font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        padding: style.padding,
        wraps: `${style.whiteSpace} ${style.overflowWrap}`,
        box: [left, top, width, height].map(Math.round).join(" "),
      };
    };
    return { field: of(element), layer: of(layer) };
  });
}

/** Where a mark of the layer behind `field` stands, by its text. */
function markBox(field: Locator, text: string) {
  return field
    .locator("xpath=..")
    .locator("[data-marks] [data-mark]")
    .filter({ hasText: text })
    .first()
    .boundingBox();
}

test("the editor marks the links, mentions and hashtags of a text as it is typed, for nobody in particular", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).pressSequentially("Hi @ada, see ");
  expect(await marksIn(editor(page))).toEqual(["mention @ada"]);
  // Typed letter by letter, as a person does: the marks follow.
  await editor(page).pressSequentially(`${link} and example.com #tag #1`);
  expect(await marksIn(editor(page))).toEqual([
    "mention @ada",
    `link ${link}`,
    "link example.com",
    "hashtag #tag",
  ]);
  // The field is a plain field still: what is in it is what was typed,
  // and the keyboard is where it was.
  await expect(editor(page)).toHaveValue(
    `Hi @ada, see ${link} and example.com #tag #1`,
  );
  await expect(editor(page)).toBeFocused();
  // Nothing is said of a network: the text goes nowhere yet.
  await expect(markNotes(editor(page))).toHaveCount(0);
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("the tints stand behind the words that they are for, also in a text of several lines that wraps", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("First");
  // A thread: the field of a part of one is as high as its text, where
  // the one part of a post takes the room that there is.
  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Add a part" })
    .click();
  // Longer than a line of a phone and of a desktop, with a tag at its
  // end, then an empty line and a link: a layer that wrapped another way
  // than the field would have the link on another line.
  const long = `${"word ".repeat(60)}#wrapped\n\nNext ${link}`;
  const field = partField(page, 1);
  await field.fill(long);
  const letters = await lettersOf(field);
  expect(letters.layer).toEqual(letters.field);

  // The link is on the last line of the text, so its tint is at the
  // bottom of the field, just above the room under the text. A layer
  // that wrapped the long line into fewer lines than the field would
  // have it higher, by a line or more.
  const [box, tint] = await Promise.all([
    field.boundingBox(),
    markBox(field, link),
  ]);
  if (!box || !tint) throw new Error("The field or the tint is not there");
  const roomUnder = await field.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingBottom),
  );
  const lineHeight = Number.parseFloat(letters.field.lineHeight);
  const under = box.y + box.height - roomUnder - (tint.y + tint.height);
  expect(under).toBeGreaterThanOrEqual(-1);
  expect(under).toBeLessThan(lineHeight / 2);
  // And it begins after "Next ", not at the edge of the field.
  expect(tint.x).toBeGreaterThan(box.x + 30);
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("a selection, an edit in the middle and an undo are the field's own, under the marks", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).pressSequentially("One #two three");
  // Into the middle of the tag, with the keys.
  for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");
  await expect(editor(page)).toHaveValue("One #tXwo three");
  expect(await marksIn(editor(page))).toEqual(["hashtag #tXwo"]);
  // The caret stays where the letter went in.
  expect(
    await editor(page).evaluate((field: HTMLTextAreaElement) => [
      field.selectionStart,
      field.selectionEnd,
    ]),
  ).toEqual([7, 7]);
  // Selected with the keys, and typed over.
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("#");
  await expect(editor(page)).toHaveValue("One ##wo three");
  // The undo of the browser takes that back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor(page)).toHaveValue("One #tXwo three");
  expect(await marksIn(editor(page))).toEqual(["hashtag #tXwo"]);
});

test("the marks are those of the accounts that get the text, and the editor says what one of them takes for text", async ({
  ownPage: page,
}) => {
  // Three accounts are connected first, each through its consent page.
  test.slow();
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await connectSimulatedLinkedIn(page, graceOnLinkedIn);
  await connectSimulatedThreads(page, graceOnThreads);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Thanks @ada: example.com #one #two");

  // LinkedIn alone: its hashtags, and no mention, which the editor says.
  await choose(page, graceOnLinkedIn);
  expect(await marksIn(editor(page))).toEqual(["hashtag #one", "hashtag #two"]);
  await expect(markNotes(editor(page)).getByRole("listitem")).toHaveText([
    "example.com is text on LinkedIn. Write an address with https:// for it to be a link there.",
    "@ada is text on LinkedIn. LinkedIn gives pigy no way to mention a member.",
  ]);

  // With Mastodon and Threads: the mention is one for two of the three,
  // and the second tag for two of them, which the marks show.
  await choose(page, grace);
  await choose(page, graceOnThreads);
  expect(await marksIn(editor(page))).toEqual([
    "mention @ada (not everywhere)",
    "hashtag #one",
    "hashtag #two (not everywhere)",
  ]);
  await expect(markNotes(editor(page))).toContainText(
    "#two is text on Threads. Threads takes one tag per post: the first.",
  );
  // The field names its notes, for whoever does not see them.
  await expect(editor(page)).toHaveAccessibleDescription(/is text on LinkedIn/);
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("a mention on Bluesky is marked for an account that there is, and said to be text for one that there is not", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulatedBluesky(page, graceOnBluesky);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await choose(page, graceOnBluesky);
  await editor(page).fill("Hi @ada.bsky.test and @nobody.bsky.test and @ada");

  // The server is asked which handles are accounts, as a post would
  // find them, a moment after the last key.
  await expect(markNotes(editor(page)).getByRole("listitem")).toHaveText([
    "Bluesky has no account @nobody.bsky.test: it stays text there.",
    "@ada is text on Bluesky. A mention on Bluesky is the handle of an account, such as @name.bsky.social.",
  ]);
  expect(await marksIn(editor(page))).toEqual(["mention @ada.bsky.test"]);
});

test("the first link of a part is previewed with what its page says of itself, as text", async ({
  ownPage: page,
}) => {
  // Two accounts are connected first, and four pages are asked for.
  test.slow();
  await openScreen(page, "Channels");
  await connectSimulatedBluesky(page, graceOnBluesky);
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await choose(page, graceOnBluesky);
  await choose(page, grace);
  await editor(page).fill(`Read ${link} and https://news.example.test/story`);

  const preview = linkPreview(editor(page));
  // Of the first link, read by the Worker from the simulated web.
  await expect(preview).toContainText("The example page");
  await expect(preview).toContainText("example.test");
  await expect(preview).not.toContainText("A story from the simulated news");
  // And who shows it.
  await expect(preview).toContainText(
    "Bluesky shows this with the post. Mastodon reads the page itself, and may show it another way.",
  );
  // No picture, from anywhere.
  await expect(preview.locator("img")).toHaveCount(0);

  // A page that writes markup into its title: the preview shows the
  // letters of it, and makes no element of any.
  await editor(page).fill("Read https://example.test/markup");
  await expect(preview).toContainText(
    '<b>Bold</b> claims & <script>alert("card")</script>',
  );
  await expect(preview.locator("b, script, img")).toHaveCount(0);

  // A link whose page the sandbox does not have: said, and nothing that
  // keeps the post back.
  await editor(page).fill("Read https://example.com/");
  await expect(preview).toContainText(
    "No preview: pigy could not read the page at example.com.",
  );
  await expect(
    publishPanel(page).getByRole("button", { name: "Publish now" }),
  ).toBeEnabled();

  // And with no link there is nothing to preview.
  await editor(page).fill("No link");
  await expect(preview).toHaveCount(0);
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("each part of a thread has its own marks and its own preview", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("First #one");
  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Add a part" })
    .click();
  await partField(page, 2).fill(`Second ${link}`);
  expect(await marksIn(partField(page, 1))).toEqual(["hashtag #one"]);
  expect(await marksIn(partField(page, 2))).toEqual([`link ${link}`]);
  await expect(linkPreview(partField(page, 2))).toContainText(
    "The example page",
  );
  await expect(linkPreview(partField(page, 1))).toHaveCount(0);
});

test("a post goes out with its link, its mention and its tag, and the Sent screen and the feed show them, with the card", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulatedBluesky(page, graceOnBluesky);
  await openScreen(page, "Drafts");
  const text = `Thanks @ada.bsky.test, read ${link} #pigy`;
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  await choose(page, graceOnBluesky);
  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Sent");
  const post = sentPost(page, text);
  await expect(post).toContainText("Sent");
  await expectSync(page, "Synced");
  // The text of the post, with what Bluesky takes in it told apart.
  const marksOf = (within: Locator) =>
    within
      .locator("[data-mark]")
      .evaluateAll((marks) =>
        marks.map(
          (mark) => `${mark.getAttribute("data-mark")} ${mark.textContent}`,
        ),
      );
  const expected = ["mention @ada.bsky.test", `link ${link}`, "hashtag #pigy"];
  expect(await marksOf(post)).toEqual(expected);

  // The feed of the account shows the post as the simulated Bluesky has
  // it: what the post marked up, and the card that came with it.
  await post
    .getByRole("link", { name: "See it in the simulated feed" })
    .click();
  const feed = feedOf(page, graceOnBluesky);
  await expect(feed).toContainText(text);
  expect(await marksOf(feed)).toEqual(expected);
  const card = feed.getByRole("region", { name: "Link preview" });
  await expect(card).toContainText("The example page");
  await expect(card).toContainText(link);
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});
