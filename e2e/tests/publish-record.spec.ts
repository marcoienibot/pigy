import {
  armFault,
  connectSimulated,
  deliveryTo,
  grace,
  openScreen,
  publishDraft,
  sentPost,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

// Settings → Record: what the workspace on screen was asked to publish,
// from where, and how each account took it. The Worker tests cover what
// is recorded on every path. This is about what a person reads of it,
// with the built Worker behind the page.
//
// Every sandbox has the same simulated accounts, so the test is somebody
// of their own: `ownPage`.

/** Opens Settings → Record. */
async function openRecord(page: Page) {
  await openScreen(page, "Settings");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Record" })
    .click();
  return page.getByRole("list", { name: "Publishing record" });
}

test("says what was published in the app and how each try went, without the text, and leads to the post", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  // The first post fails at once: the network takes the access back.
  await armFault(page, "Mastodon", "Access taken back");
  await openScreen(page, "Drafts");
  const text = "A post for the record";
  await publishDraft(page, text, grace);
  await openScreen(page, "Sent");
  await expect(deliveryTo(sentPost(page, text), grace)).toContainText("Failed");

  const record = await openRecord(page);
  const entry = record.getByRole("listitem").filter({
    hasText: "Published in the app",
  });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText(grace);
  await expect(entry).toContainText("Not sent");
  // The record names a post by its ID, and the screen leads to it: the
  // text is on the Sent screen and nowhere in the record.
  await expect(record).not.toContainText(text);
  await entry.getByRole("link", { name: "See the post" }).click();
  await expect(page).toHaveURL(/\/sent\?post=/);
  await expect(sentPost(page, text)).toBeVisible();
});

test("asks for the record again when a delivery is asked for and when it ends, and when the person says so", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await armFault(page, "Mastodon", "Access taken back");
  // The record is open in a second tab of the same person, from before
  // anything was published: nothing tells the screen that the record has
  // changed but the deliveries in the local copy, which the tabs share.
  const other = await page.context().newPage();
  await other.goto("/");
  const record = await openRecord(other);
  await expect(other.getByText("Nothing was published")).toBeVisible();

  await openScreen(page, "Drafts");
  await publishDraft(page, "A post for an open record", grace);

  await expect(
    record.getByRole("listitem").filter({ hasText: "Published in the app" }),
  ).toContainText("Not sent");

  // And when the person asks.
  const asked = other.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/publish-record"),
  );
  await other.getByRole("button", { name: "Refresh" }).click();
  await asked;
});
