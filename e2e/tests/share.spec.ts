import {
  backToList,
  draftRows,
  editor,
  serviceWorkerAnswersFor,
} from "../app.ts";
import { expect, signIn, test } from "../fixtures.ts";

// Sharing to pigy: the manifest registers the app as a share target, and
// Android then opens `/share?title=…&text=…&url=…` in the installed app
// for what another app shares. No test has an Android to share from: what
// these show is what the app does with that address, which is all that is
// the app's. That Android offers pigy in its share sheet is to be seen on
// a phone: PLAN.md section 19.

/** The address that Android opens for a share of `shared`. */
const shareAddress = (shared: Record<string, string>) =>
  `/share?${new URLSearchParams(shared)}`;

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

test("what is shared opens as a new draft, with the text and the link put together", async ({
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

test("a text that holds its link is not given the link twice", async ({
  ownPage: page,
}) => {
  await page.goto(
    shareAddress({
      text: "Look at this https://example.com/a",
      url: "https://example.com/a",
    }),
  );

  await expect(editor(page)).toHaveValue("Look at this https://example.com/a");
});

test("a share of nothing leads to the drafts and makes none", async ({
  ownPage: page,
}) => {
  await page.goto(shareAddress({ title: " ", text: "" }));

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(page).toHaveURL(/\/$/);
  await expect(draftRows(page)).toHaveCount(0);
});

test("somebody who is signed out signs in first, and the draft is there then", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  await page.goto(shareAddress({ text: "Shared while signed out" }));

  // The app has them sign in, and keeps where they were going.
  await page.waitForURL(({ pathname }) => pathname === "/sign-in");
  await signIn(page, ownEmail);

  await expect(editor(page)).toHaveValue("Shared while signed out");
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
});

test("what is shared without a connection is a draft on the device, and syncs later", async ({
  ownPage: page,
  context,
  otherDevice,
}) => {
  // The app is on the device once its service worker answers for it.
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);

  await page.goto(shareAddress({ text: "Shared on the train" }));

  await expect(editor(page)).toHaveValue("Shared on the train");

  await context.setOffline(false);
  const other = await otherDevice();
  await expect(draftRows(other)).toContainText("Shared on the train");
});
