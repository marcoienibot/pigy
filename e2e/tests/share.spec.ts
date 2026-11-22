import {
  backToList,
  draftRows,
  editor,
  expectSync,
  expectWorkspace,
  serviceWorkerAnswersFor,
  switchTo,
} from "../app.ts";
import { expect, type Page, signIn, test } from "../fixtures.ts";

// Sharing to pigy: the manifest registers the app as a share target, and
// Android then opens `/share?title=…&text=…&url=…` in the installed app
// for what another app shares. No test has an Android to share from: what
// these show is what the app does with that address, which is all that is
// the app's. That Android offers pigy in its share sheet is to be seen on
// a phone: PLAN.md section 19.
//
// The address is one that any website can send a browser to, so opening it
// stores nothing: the app shows what came and asks.

/** The address that Android opens for a share of `shared`. */
const shareAddress = (shared: Record<string, string>) =>
  `/share?${new URLSearchParams(shared)}`;

/** What the screen says was shared. */
const shared = (page: Page) => page.getByLabel("What was shared");

const save = (page: Page) =>
  page.getByRole("button", { name: "Save as draft" });

test("the manifest registers pigy for text and links, at an address of the app's own", async ({
  page,
}) => {
  const response = await page.request.get("/manifest.webmanifest");
  const manifest = await response.json();

  expect(manifest.share_target).toEqual({
    action: "/share",
    method: "GET",
    params: { title: "title", text: "text", url: "url" },
  });
  // Not a path of the Worker: the answer is the app shell, which the
  // service worker also has without a connection. No session is needed
  // to be given it.
  const shell = await page.request.get(shareAddress({ text: "Hello" }));
  expect(shell.headers()["content-type"]).toContain("text/html");
  expect(await shell.text()).toContain('<div id="root">');
});

test("what is shared is shown with the text and the link put together, and becomes a draft when the person says so", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.goto(
    shareAddress({
      title: "A fine article",
      text: "",
      url: "https://example.com/article",
    }),
  );

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Shared to pigy",
  );
  // Read without its line breaks here: the draft below has them.
  await expect(shared(page)).toHaveText(
    "A fine article https://example.com/article",
  );
  // As text: the address in it is nothing to press.
  await expect(shared(page).getByRole("link")).toHaveCount(0);

  // Saving is the main thing to do there, and has the keyboard.
  await expect(save(page)).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(editor(page)).toHaveValue(
    "A fine article\n\nhttps://example.com/article",
  );
  // In the sandbox, which this device showed last, and on to the draft:
  // the address of the share is gone from the history.
  await expect(page).toHaveURL(/\/\?draft=/);

  // Loading the page again shares nothing a second time: one draft. On a
  // phone the editor covers the list.
  await page.reload();
  await expect(editor(page)).toHaveValue(
    "A fine article\n\nhttps://example.com/article",
  );
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
});

test("opening the address of a share stores nothing: the person can discard what came", async ({
  ownPage: page,
  otherDevice,
}) => {
  // As a website does that sends a signed-in browser here, with a text
  // of its own.
  await page.goto(shareAddress({ text: "Written by somebody else" }));
  await expect(shared(page)).toHaveText("Written by somebody else");
  // The page has nothing to sync, and says so once it has heard from the
  // server: the check below is about a server that was reached.
  await expectSync(page, "Synced");

  // Nothing has reached the other devices of the person.
  const other = await otherDevice();
  await expectSync(other, "Synced");
  await expect(draftRows(other)).toHaveCount(0);

  await page.getByRole("button", { name: "Discard" }).click();

  // And nothing is on this one, where the drafts are read from the copy.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(page).toHaveURL(/\/$/);
  await expect(draftRows(page)).toHaveCount(0);
});

test("a text that holds its link is not given the link twice", async ({
  ownPage: page,
}) => {
  await page.goto(
    shareAddress({
      text: "Look at this https://example.com/a",
      url: "https://example.com/a",
    }),
  );

  await expect(shared(page)).toHaveText("Look at this https://example.com/a");
});

for (const text of [
  "null",
  "[1,2]",
  '{"a":1}',
  "9007199254740993",
  '"quoted"',
]) {
  test(`a shared text that reads like JSON is the text that it is: ${text}`, async ({
    ownPage: page,
  }) => {
    // A router reads such a value of an address as what it reads like:
    // as nothing, as a list or an object, as a number that it rounds, as
    // a text without its quotation marks.
    await page.goto(shareAddress({ text }));

    await expect(shared(page)).toHaveText(text);
    await save(page).click();
    await expect(editor(page)).toHaveValue(text);
  });
}

test("a share of nothing leads to the drafts and makes none", async ({
  ownPage: page,
}) => {
  await page.goto(shareAddress({ title: " ", text: "" }));

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(page).toHaveURL(/\/$/);
  await expect(draftRows(page)).toHaveCount(0);
});

test("what is shared can be saved in the other workspace: it stays when the person changes to that one", async ({
  ownPage: page,
}) => {
  // In quotation marks, which the address loses if it is written anew
  // the way the router reads it.
  await page.goto(shareAddress({ text: '"For real"' }));
  await expect(shared(page)).toHaveText('"For real"');
  await expect(page.getByText("The draft is saved in Sandbox.")).toBeVisible();

  await switchTo(page, "Live");

  await expectWorkspace(page, "Live");
  await expect(shared(page)).toHaveText('"For real"');
  await expect(page.getByText("The draft is saved in Live.")).toBeVisible();
  await save(page).click();
  await expect(editor(page)).toHaveValue('"For real"');
  await expectWorkspace(page, "Live");
});

test("somebody who is signed out signs in first, and what was shared is there then, as it came", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  // In quotation marks: the way back from signing in must not change it.
  await page.goto(shareAddress({ text: '"Shared while signed out"' }));

  // The app has them sign in, and keeps where they were going.
  await page.waitForURL(({ pathname }) => pathname === "/sign-in");
  await signIn(page, ownEmail);

  // Nothing was saved on the way: they are asked like anybody.
  await expect(shared(page)).toHaveText('"Shared while signed out"');
  await save(page).click();
  await expect(editor(page)).toHaveValue('"Shared while signed out"');
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
});

test("what is shared without a connection is shown, saved as a draft on the device, and synced later", async ({
  ownPage: page,
  context,
  otherDevice,
}) => {
  // The app is on the device once its service worker answers for it.
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);

  await page.goto(shareAddress({ text: "Shared on the train" }));

  await expect(shared(page)).toHaveText("Shared on the train");
  await save(page).click();
  await expect(editor(page)).toHaveValue("Shared on the train");

  await context.setOffline(false);
  const other = await otherDevice();
  await expect(draftRows(other)).toContainText("Shared on the train");
});
