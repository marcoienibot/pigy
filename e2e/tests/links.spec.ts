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

/** Adds a part to the open draft and writes `text` into it. */
async function addPart(page: Page, number: number, text: string) {
  await page
    .getByRole("region", { name: "Draft" })
    // After the last part: each part of a thread has such a button.
    .getByRole("button", { name: "Add a part" })
    .last()
    .click();
  await partField(page, number).fill(text);
}

test("a thread asks once for the card of a link that several of its parts lead with", async ({
  ownPage: page,
}) => {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/link-card")) {
      asked.push(request.postData() ?? "");
    }
  });
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(`One ${link}`);
  await expect(linkPreview(editor(page))).toContainText("The example page");
  for (const number of [2, 3, 4]) {
    await addPart(page, number, `Part ${number} ${link}`);
    // The answer is the editor's, so the part has it with its first
    // letter.
    await expect(linkPreview(partField(page, number))).toContainText(
      "The example page",
    );
  }
  // A part that leads to another page asks for that one. Its request is
  // also what shows that the others had the time to ask, and did not.
  await addPart(page, 5, "And https://news.example.test/story");
  await expect(linkPreview(partField(page, 5))).toContainText(
    "A story from the simulated news",
  );
  expect(asked.map((body) => JSON.parse(body).url)).toEqual([
    link,
    "https://news.example.test/story",
  ]);
});

test("without a connection a link has no preview, which the editor says, and gets it when the connection is back", async ({
  ownPage: page,
  context,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Written on a train");
  await context.setOffline(true);
  await editor(page).fill(`Written on a train ${link}`);
  const preview = linkPreview(editor(page));
  await expect(preview).toContainText("No preview without a connection");
  // Nobody has tried to read the page, so nothing says that it could
  // not be read.
  await expect(preview).not.toContainText("could not read");
  await context.setOffline(false);
  // The browser says that the connection is back, and the editor asks.
  await expect(preview).toContainText("The example page");
  await expect(preview).not.toContainText("No preview");
});

test("a preview that the server makes none of, because it was asked too often, says so and is asked for again until the server answers", async ({
  ownPage: page,
}) => {
  // The clock of the page, for the minutes to pass when the test says.
  await page.clock.install();
  let refused = 0;
  await page.route("**/link-card", async (route) => {
    refused++;
    await route.fulfill({
      status: 429,
      json: {
        error: "LimitReachedError",
        message: "pigy was asked for more previews than it makes in a minute.",
      },
    });
  });
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(`Read ${link}`);
  const preview = linkPreview(editor(page));
  const note =
    "No preview for the moment: pigy makes 60 a minute for one person. It is asked for again by itself";
  await expect(preview).toContainText(note);
  await expect(preview).not.toContainText("could not read");
  expect(refused).toBe(1);

  // A minute later the editor asks again, and is refused again: another
  // tab or another device of the person has used the minute up.
  await page.clock.fastForward("01:01");
  await expect.poll(() => refused).toBe(2);
  await expect(preview).toContainText(note);

  // It goes on asking, as it says, after a longer pause: the second
  // refusal sets a timer like the first. Not within the next minute,
  // which the request below shows by being the third and not the fourth.
  await page.clock.fastForward("01:01");
  await page.unroute("**/link-card");
  const answered = page.waitForResponse("**/link-card");
  await page.clock.fastForward("01:01");
  await answered;
  await expect(preview).toContainText("The example page");
  expect(refused).toBe(2);
});

test("a link whose page could not be read is asked about again some minutes later, and at once when it is typed anew", async ({
  ownPage: page,
}) => {
  await page.clock.install();
  // The server's answers are the test's: a page that is not there at
  // first and is there later, which the simulated web has none of.
  const later = "https://later.example.test/";
  const anew = "https://anew.example.test/";
  const there = new Set<string>();
  const asked: string[] = [];
  await page.route("**/link-card", async (route) => {
    const { url } = route.request().postDataJSON() as { url: string };
    asked.push(url);
    await route.fulfill({
      json: {
        card: there.has(url)
          ? { url, title: `The page at ${url}`, description: "" }
          : null,
      },
    });
  });
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(`Read ${later}`);
  const preview = linkPreview(editor(page));
  await expect(preview).toContainText(
    "pigy could not read the page at later.example.test",
  );

  // The page comes up. For some minutes the editor goes by what it was
  // told, and then it asks again, with nothing typed.
  there.add(later);
  await page.clock.fastForward("04:00");
  expect(asked).toEqual([later]);
  await page.clock.fastForward("01:01");
  await expect(preview).toContainText(`The page at ${later}`);
  expect(asked).toEqual([later, later]);

  // A card is kept: it is not asked for again, however long the draft is
  // open. The requests that follow show that the time has passed.
  await page.clock.fastForward("30:00");

  // Another page that cannot be read. Whoever takes the link out and
  // types it again is asking again, and gets an answer of now, with no
  // minutes passed.
  await editor(page).fill(`Read ${anew}`);
  await expect(preview).toContainText(
    "pigy could not read the page at anew.example.test",
  );
  there.add(anew);
  await editor(page).fill("Read");
  await expect(preview).toHaveCount(0);
  await editor(page).fill(`Read ${anew}`);
  await expect(preview).toContainText(`The page at ${anew}`);
  expect(asked).toEqual([later, later, anew, anew]);
});

test("a handle is looked up once for the parts that are opened together, and one that was nobody's is looked up again later and when it is typed anew", async ({
  ownPage: page,
}) => {
  test.slow();
  await openScreen(page, "Channels");
  await connectSimulatedBluesky(page, graceOnBluesky);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await choose(page, graceOnBluesky);
  await editor(page).fill("Hi @ada.bsky.test and @grace.bsky.test");
  await addPart(page, 2, "And @ada.bsky.test with @alan.bsky.test");
  await expectSync(page, "Synced");

  // The clock of the page, for the minutes to pass when the test says:
  // before the page is loaded whose timers it is to move.
  await page.clock.install();
  // The lookups of the page from here on. The server answers them,
  // except about the accounts that the test says are made meanwhile.
  const made = new Set<string>();
  const lookedUp: string[][] = [];
  await page.route("**/mentions", async (route) => {
    const { names } = route.request().postDataJSON() as { names: string[] };
    lookedUp.push(names);
    const response = await route.fetch();
    const { known } = (await response.json()) as { known: string[] };
    await route.fulfill({
      json: { known: [...known, ...names.filter((name) => made.has(name))] },
    });
  });
  // The draft is opened anew, with both of its parts at once: each asks
  // on its own, in the same moment.
  await page.reload();
  await expect(partField(page, 2)).toHaveValue(/alan/);
  await expect
    .poll(() => lookedUp.flat().sort())
    .toEqual(["ada.bsky.test", "alan.bsky.test", "grace.bsky.test"]);
  // A part that is added later with the same handles asks nothing. The
  // lookup of the handle after it shows that it had the time to.
  await addPart(page, 3, "Also @ada.bsky.test and @alan.bsky.test");
  await partField(page, 3).fill(
    "Also @ada.bsky.test and @alan.bsky.test, not @nobody.bsky.test",
  );
  await expect(markNotes(partField(page, 3))).toContainText(
    "Bluesky has no account @nobody.bsky.test",
  );
  expect(lookedUp.flat().sort()).toEqual([
    "ada.bsky.test",
    "alan.bsky.test",
    "grace.bsky.test",
    "nobody.bsky.test",
  ]);

  // The account is made. Some minutes later the editor asks again, with
  // nothing typed, and marks the mention.
  made.add("nobody.bsky.test");
  await page.clock.fastForward("05:01");
  await expect(markNotes(partField(page, 3))).toHaveCount(0);
  expect(await marksIn(partField(page, 3))).toContain(
    "mention @nobody.bsky.test",
  );

  // And a handle that is taken out and typed again is looked up again
  // at once.
  await partField(page, 3).fill("Not @anew.bsky.test");
  await expect(markNotes(partField(page, 3))).toContainText(
    "Bluesky has no account @anew.bsky.test",
  );
  made.add("anew.bsky.test");
  await partField(page, 3).fill("Not");
  await expect(markNotes(partField(page, 3))).toHaveCount(0);
  await partField(page, 3).fill("Not @anew.bsky.test");
  // Until an answer is in, a mention is taken for one of an account, so
  // the marks say nothing here: the lookup itself is what shows that the
  // answer of before was not handed out. Each of the two was looked up
  // twice, and the accounts that there were from the first never again.
  await expect
    .poll(() => lookedUp.flat().sort())
    .toEqual([
      "ada.bsky.test",
      "alan.bsky.test",
      "anew.bsky.test",
      "anew.bsky.test",
      "grace.bsky.test",
      "nobody.bsky.test",
      "nobody.bsky.test",
    ]);
  expect(await marksIn(partField(page, 3))).toEqual([
    "mention @anew.bsky.test",
  ]);
  await expect(markNotes(partField(page, 3))).toHaveCount(0);
});

test("each network is said to show the card of the link that it leads with, and LinkedIn one card for a whole thread", async ({
  ownPage: page,
}) => {
  test.slow();
  await openScreen(page, "Channels");
  await connectSimulatedBluesky(page, graceOnBluesky);
  await connectSimulatedLinkedIn(page, graceOnLinkedIn);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await choose(page, graceOnBluesky);
  await choose(page, graceOnLinkedIn);
  // An address without its scheme is a link on Bluesky alone: Bluesky
  // leads with it, and LinkedIn with the address after it.
  await editor(page).fill(`example.com and ${link}`);
  const previews = linkPreview(editor(page));
  await expect(previews).toHaveCount(2);
  // The sandbox has no page at example.com: no card goes to Bluesky.
  await expect(previews.nth(0)).toContainText(
    "pigy could not read the page at example.com",
  );
  await expect(previews.nth(1)).toContainText("The example page");
  await expect(previews.nth(1)).toContainText(
    "LinkedIn shows this with the post.",
  );
  await expect(previews.nth(1)).not.toContainText("Bluesky");

  // A thread is one post on LinkedIn, with the card of its first link,
  // and a post per part on Bluesky, each with its own.
  await editor(page).fill(`First ${link}`);
  await addPart(page, 2, "Second https://news.example.test/story");
  await expect(linkPreview(partField(page, 1))).toContainText(
    "Bluesky and LinkedIn show this with the post.",
  );
  const second = linkPreview(partField(page, 2));
  await expect(second).toContainText("A story from the simulated news");
  await expect(second).toContainText("Bluesky shows this with the post.");
  await expect(second).not.toContainText("LinkedIn");
  expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("where the browser does not size a field by its text, a field shows all of its text after its width has changed", async ({
  ownPage: page,
}) => {
  // A browser that knows no `field-sizing`, as Safari before 26 and
  // Firefox: the app then sizes the field of a part itself. The Chromium
  // of the tests knows it, so the test says for it that it does not,
  // before the app starts.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string, string?]) =>
      args[0] === "field-sizing"
        ? false
        : supports(...(args as [string]))) as typeof CSS.supports;
  });
  await page.reload();
  await page.getByRole("button", { name: "New draft" }).click();
  // Two parts: the one part of a post takes the room that there is, and
  // the parts of a thread are as high as their text.
  await editor(page).fill("First");
  const text = `Several lines that wrap, with a ${link} and a #tag: ${"words and more words ".repeat(12)}`;
  await addPart(page, 2, text);
  const field = partField(page, 2);
  /** The field against its text, and against the layer behind it. */
  const sizes = () =>
    field.evaluate((element) => {
      const layer = element.parentElement?.querySelector("[data-marks]");
      return {
        cut: element.scrollHeight - element.clientHeight,
        // The app has set the height, and not the browser: the test is
        // about the app's own sizing.
        sized: (element as HTMLElement).style.height !== "",
        field: Math.round(element.getBoundingClientRect().height),
        layer: Math.round(layer?.getBoundingClientRect().height ?? 0),
      };
    });
  const before = await sizes();
  expect(before).toMatchObject({ cut: 0, sized: true });

  // The window is made narrower, as when a phone is turned: the text
  // wraps into more lines.
  const { width = 0, height = 0 } = page.viewportSize() ?? {};
  await page.setViewportSize({ width: Math.round(width * 0.7), height });
  await expect
    .poll(async () => (await sizes()).field)
    .toBeGreaterThan(before.field);
  const after = await sizes();
  // Nothing of the text is beyond the field, which does not scroll, and
  // the layer with the tints is as high as the field.
  expect(after.cut).toBe(0);
  expect(after.layer).toBe(after.field);
  // And wider again.
  await page.setViewportSize({ width, height });
  await expect.poll(async () => (await sizes()).field).toBe(before.field);
  expect((await sizes()).cut).toBe(0);
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
