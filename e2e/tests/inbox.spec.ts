import {
  armFault,
  channelRows,
  connectSimulated,
  grace,
  inboxItem,
  inboxLink,
  openInbox,
  openScreen,
  overflowOf,
  publishDraft,
  sentPost,
} from "../app.ts";
import { expect, test } from "../fixtures.ts";

// The inbox: what the server tells a person of, where push messages are
// read by whoever gets none. The Worker tests cover when a notification
// is made. These are about what a person sees of it, on a desktop and on
// a phone, with the built Worker behind the page.
//
// Every test is somebody of its own, in a sandbox of their own: `ownPage`.

const postFailed = `A post was not sent to ${grace}`;
const channelBroken = `pigy can no longer post to ${grace}`;

/**
 * A delivery that fails for good, in the sandbox: the simulated Mastodon
 * takes the access of the account back, so the post fails and the account
 * has to be connected again. The inbox is told of both.
 */
async function failedDelivery(page: Parameters<typeof openScreen>[0]) {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await armFault(page, "Mastodon", "Access taken back");
  await openScreen(page, "Drafts");
  await publishDraft(page, "Locked out", grace);
}

test("an empty inbox says what it is for, and has nothing to count", async ({
  ownPage: page,
}) => {
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox");

  await openInbox(page);

  await expect(
    page.getByRole("heading", { name: "Nothing needs your attention" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(
    0,
  );
});

test("a failed delivery shows in the inbox, is counted while unread, leads to the post, and is read then", async ({
  ownPage: page,
}) => {
  await failedDelivery(page);

  // On whatever screen the person is: the way to the inbox counts both.
  await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox,? 2 unread$/);
  await openInbox(page);
  await expect(inboxItem(page, postFailed)).toHaveAttribute(
    "data-unread",
    "true",
  );
  await expect(inboxItem(page, postFailed)).toContainText("Locked out");
  await expect(inboxItem(page, channelBroken)).toHaveAttribute(
    "data-unread",
    "true",
  );
  // No page is wider than its window, on a phone least of all.
  expect(await overflowOf(page)).toBe(0);

  // To where the thing is dealt with: the post, on the Sent screen.
  await inboxItem(page, postFailed).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent");
  await expect(sentPost(page, "Locked out")).toBeFocused();

  // Going there was reading it: one is left to count.
  await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox,? 1 unread$/);
  await openInbox(page);
  await expect(inboxItem(page, postFailed)).toHaveAttribute(
    "data-unread",
    "false",
  );
  await expect(inboxItem(page, channelBroken)).toHaveAttribute(
    "data-unread",
    "true",
  );
});

test("everything is marked as read at once, and a notification is dismissed", async ({
  ownPage: page,
}) => {
  await failedDelivery(page);
  await openInbox(page);

  await page.getByRole("button", { name: "Mark all read" }).click();

  await expect(inboxItem(page, postFailed)).toHaveAttribute(
    "data-unread",
    "false",
  );
  await expect(inboxItem(page, channelBroken)).toHaveAttribute(
    "data-unread",
    "false",
  );
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox");
  // Nothing is left to mark.
  await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: `Dismiss: ${postFailed}` }).click();
  await expect(inboxItem(page, postFailed)).toHaveCount(0);
  await expect(inboxItem(page, channelBroken)).toBeVisible();
  // It is gone for good, and the post is where it was.
  await page.reload();
  await expect(inboxItem(page, channelBroken)).toBeVisible();
  await expect(inboxItem(page, postFailed)).toHaveCount(0);
  await openScreen(page, "Sent");
  await expect(sentPost(page, "Locked out")).toBeVisible();
});

test("a notification about an account leads to connecting it again, which takes it out of the inbox", async ({
  ownPage: page,
}) => {
  await failedDelivery(page);
  await openInbox(page);

  await inboxItem(page, channelBroken).getByRole("link").click();

  // The dialog that connects the account again, over the Channels
  // screen, which is hidden from the roles while the dialog is open.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Reconnect ${grace}`);
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  await page.getByRole("button", { name: grace }).click();
  await expect(channelRows(page)).toHaveCount(1);

  // The account is connected again: what the inbox said of it is dealt
  // with. The post is still not sent, and still there.
  await openInbox(page);
  await expect(inboxItem(page, postFailed)).toBeVisible();
  await expect(inboxItem(page, channelBroken)).toHaveCount(0);
});

test("reading and dismissing work without a connection, and reach the other device when it is back", async ({
  ownPage: page,
  context,
  otherDevice,
}) => {
  await failedDelivery(page);
  await openInbox(page);
  await expect(inboxItem(page, postFailed)).toBeVisible();
  const other = await otherDevice();
  await expect(inboxLink(other)).toHaveAccessibleName(/^Inbox,? 2 unread$/);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Mark all read" }).click();
  await page.getByRole("button", { name: `Dismiss: ${channelBroken}` }).click();

  // At once, on the device that did it.
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox");
  await expect(inboxItem(page, channelBroken)).toHaveCount(0);
  // The other device has heard nothing yet.
  await expect(inboxLink(other)).toHaveAccessibleName(/^Inbox,? 2 unread$/);

  await context.setOffline(false);

  await expect(inboxLink(other)).toHaveAccessibleName("Inbox");
  await openInbox(other);
  await expect(inboxItem(other, postFailed)).toHaveAttribute(
    "data-unread",
    "false",
  );
  await expect(inboxItem(other, channelBroken)).toHaveCount(0);
});
