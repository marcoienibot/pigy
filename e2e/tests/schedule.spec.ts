import {
  backToList,
  channelChoice,
  connectionOf,
  connectSimulated,
  draftRow,
  editor,
  expectSync,
  feedOf,
  grace,
  openScreen,
  overflowOf,
  publishDraft,
  publishPanel,
  sentPost,
} from "../app.ts";
import { expect, type Page, signIn, test } from "../fixtures.ts";
import {
  connectInSandbox,
  postsOf,
  publishNow,
  workspacesOf,
} from "../sandbox.ts";

// Scheduling from the app: a time from the editor, the queue with its
// posting times, the Queue screen and the calendar. The Worker tests move
// a clock to show when a post goes out. Here the server keeps real time,
// which no test can move: these are about what a person does and sees,
// and one test waits a few seconds to show that the built Worker
// publishes a scheduled post by itself.
//
// Every test is somebody of its own, in a sandbox of their own: `ownPage`.

// What the app says goes by the zone and the language of the browser.
test.use({ timezoneId: "Europe/Rome", locale: "en-GB" });

/** The notices of the app, which the notice library lists. */
function notice(page: Page, text: string) {
  return page.getByRole("listitem").filter({ hasText: text });
}

/** The scheduled posts on the Queue screen. */
function queueRows(page: Page) {
  return page
    .getByRole("list", { name: "Scheduled posts" })
    .getByRole("article");
}

/** The scheduled post whose text begins with `text`. */
function queueRow(page: Page, text: string) {
  return page
    .getByRole("list", { name: "Scheduled posts" })
    .getByRole("article", { name: text });
}

/** What each scheduled post is called, in the order of the screen. */
function queueTitles(page: Page): Promise<(string | null)[]> {
  return queueRows(page).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("aria-label")),
  );
}

/** When each scheduled post goes out, as the screen says it. */
function queueTimes(page: Page): Promise<string[]> {
  return queueRows(page).locator("header p").allTextContents();
}

/** Chooses an action from the menu of a scheduled post. */
async function act(page: Page, text: string, action: string) {
  await queueRow(page, text)
    .getByRole("button", { name: `Actions for “${text}”` })
    .click();
  await page.getByRole("menuitem", { name: action }).click();
}

/** Writes a draft that goes to `grace`, and leaves its editor open. */
async function draftFor(page: Page, text: string) {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  await channelChoice(page, grace).click();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** Writes a draft and adds it to the queue from its editor. */
async function addToQueue(page: Page, text: string) {
  await draftFor(page, text);
  await publishPanel(page)
    .getByRole("button", { name: "Add to queue" })
    .click();
  // A post that is queued is a draft no more: the editor closes.
  await expect(editor(page)).toHaveCount(0);
}

/** Goes to the posting schedule in Settings. */
async function openSchedule(page: Page) {
  await openScreen(page, "Settings");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Posting schedule" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Posting times" }),
  ).toBeVisible();
}

/**
 * Adds a posting time on the days that are pressed: `days` by their
 * names, or the ones that the form begins with.
 */
async function addTime(page: Page, time: string, days?: string[]) {
  const form = page.getByRole("form", { name: "Add a posting time" });
  if (days) {
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      const button = form.getByRole("button", { name: day });
      const pressed = (await button.getAttribute("aria-pressed")) === "true";
      if (pressed !== days.includes(day)) await button.click();
    }
  }
  await form.getByLabel("Time").fill(time);
  await form.getByRole("button", { name: "Add" }).click();
}

const everyDay = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

test("the posting times are set in Settings, in the time zone of the device, and are kept", async ({
  ownPage: page,
}) => {
  await openSchedule(page);
  const zone = page.getByRole("combobox", { name: "Time zone" });
  // A workspace that has no zone shows the one of the device, which it
  // gets with its first posting time.
  await expect(zone).toHaveValue("Europe/Rome");
  await expect(page.getByText("No posting times yet.")).toBeVisible();

  // Monday to Friday is what the form begins with.
  await addTime(page, "09:00");
  const times = page.getByRole("list", { name: "Posting times" });
  for (const day of everyDay.slice(0, 5)) {
    await expect(times.getByRole("list", { name: day })).toHaveText("09:00");
  }
  await expect(times.getByRole("list", { name: "Saturday" })).toHaveCount(0);

  // A second time on one day goes after the first.
  await addTime(page, "17:30", ["Wednesday"]);
  await expect(
    times.getByRole("list", { name: "Wednesday" }).getByRole("listitem"),
  ).toHaveText(["09:00", "17:30"]);
  // The same time again is the same slot, not a second one.
  await addTime(page, "17:30", ["Wednesday"]);
  await expect(
    times.getByRole("list", { name: "Wednesday" }).getByRole("listitem"),
  ).toHaveCount(2);

  await page.getByRole("button", { name: "Remove Monday 09:00" }).click();
  await expect(times.getByRole("list", { name: "Monday" })).toHaveCount(0);

  await zone.selectOption("America/New_York");
  // The device is somewhere else now, and the screen offers its zone.
  await expect(page.getByText("This device is in Europe/Rome.")).toBeVisible();
  expect(await overflowOf(page)).toBe(0);

  // The server took all of it, and it is there after a reload.
  await expectSync(page, "Synced");
  await page.reload();
  await expect(zone).toHaveValue("America/New_York");
  await expect(
    times.getByRole("list", { name: "Wednesday" }).getByRole("listitem"),
  ).toHaveText(["09:00", "17:30"]);
  await expect(times.getByRole("list", { name: "Monday" })).toHaveCount(0);
});

test("a draft is scheduled for a time from its editor, leaves the drafts for the queue, is given another time and taken back", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  const text = "For next spring";
  await draftFor(page, text);

  await publishPanel(page).getByRole("button", { name: "Schedule…" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this post" });
  const field = dialog.getByLabel("Date and time");
  // The dialog names the zone that the time is in: the one of this
  // device, which a workspace that has none takes with its first post.
  await expect(dialog).toContainText(
    "In the time zone of this device, Europe/Rome",
  );
  // It begins with a time that is still to come, on the hour.
  await expect(field).toHaveValue(/^\d{4}-\d\d-\d\dT\d\d:00$/);

  // A time that has passed is not taken.
  await field.fill("2020-01-01T09:00");
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(dialog.getByRole("alert")).toContainText("has passed");

  await field.fill("2031-05-06T09:30");
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(dialog).toHaveCount(0);
  // The post is a draft no more: the editor closes, and the list has it
  // no longer.
  await expect(editor(page)).toHaveCount(0);
  await expect(draftRow(page, text)).toHaveCount(0);
  await expect(
    // The date as the Queue screen writes it, names and all.
    notice(page, "Scheduled for Tue, 6 May 2031, 09:30"),
  ).toBeVisible();

  await openScreen(page, "Queue");
  const row = queueRow(page, text);
  await expect(row).toContainText("Tue, 6 May 2031, 09:30");
  await expect(row).toContainText("Scheduled");
  await expect(row.getByRole("list", { name: "Goes to" })).toContainText(grace);
  expect(await overflowOf(page)).toBe(0);
  // The server has it so too: read again once it has answered.
  await expectSync(page, "Synced");
  await expect(row).toContainText("Tue, 6 May 2031, 09:30");
  // It has not gone out.
  await openScreen(page, "Sent");
  await expect(sentPost(page, text)).toHaveCount(0);

  await openScreen(page, "Queue");
  await act(page, text, "Reschedule…");
  const again = page.getByRole("dialog", { name: "Schedule for another time" });
  // It begins with the time that the post has.
  await expect(again.getByLabel("Date and time")).toHaveValue(
    "2031-05-06T09:30",
  );
  await again.getByLabel("Date and time").fill("2031-06-07T18:15");
  await again.getByRole("button", { name: "Schedule" }).click();
  await expect(row).toContainText("Sat, 7 Jun 2031, 18:15");

  await act(page, text, "Back to drafts");
  await expect(queueRows(page)).toHaveCount(0);
  await expect(page.getByText("Nothing scheduled")).toBeVisible();
  await expectSync(page, "Synced");
  await openScreen(page, "Drafts");
  await expect(draftRow(page, text)).toBeVisible();
});

test("the Queue screen and the calendar say whose clocks their times are on, where those are not the clocks of the device", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  const text = "Read in two zones";
  await draftFor(page, text);
  await publishPanel(page).getByRole("button", { name: "Schedule…" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this post" });
  await dialog.getByLabel("Date and time").fill("2031-05-06T09:30");
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(editor(page)).toHaveCount(0);

  // The workspace has the zone of this device: there is nothing to say.
  await openScreen(page, "Queue");
  const zone = page.getByText("Times are in");
  await expect(queueRow(page, text)).toContainText("Tue, 6 May 2031, 09:30");
  await expect(zone).toHaveCount(0);

  // Somebody sets it to another one, as from a device elsewhere.
  await openSchedule(page);
  await page
    .getByRole("combobox", { name: "Time zone" })
    .selectOption("Asia/Tokyo");
  await openScreen(page, "Queue");
  // The same moment, on the clocks of Tokyo, which the screen names:
  // without that, 16:30 would be read as a time of this device.
  await expect(queueRow(page, text)).toContainText("Tue, 6 May 2031, 16:30");
  await expect(zone).toHaveText(
    "Times are in Asia/Tokyo, the time zone of this workspace.",
  );
  expect(await overflowOf(page)).toBe(0);
  await page
    .getByRole("navigation", { name: "Queue" })
    .getByRole("link", { name: "Calendar" })
    .click();
  await expect(page.getByRole("region", { name: "Calendar" })).toBeVisible();
  await expect(zone).toHaveText(
    "Times are in Asia/Tokyo, the time zone of this workspace.",
  );
  // And the dialog says it for the time that it asks for.
  await page
    .getByRole("navigation", { name: "Queue" })
    .getByRole("link", { name: "List" })
    .click();
  await act(page, text, "Reschedule…");
  await expect(
    page.getByRole("dialog", { name: "Schedule for another time" }),
  ).toContainText("In the time zone of this workspace, Asia/Tokyo.");
});

test("the word queue in the command palette leads to the Queue screen, and does not pause the queue", async ({
  ownPage: page,
}) => {
  const palette = page.getByRole("dialog", { name: "Commands" });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("queue");
  // The screen is the first of what is listed, which Enter takes: before
  // the commands that have the word in them.
  await expect(palette.getByRole("option").first()).toHaveText("Queue");
  await expect(
    palette.getByRole("option", { name: "Pause the queue" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");
  await expect(page.getByRole("button", { name: "Pause queue" })).toBeVisible();
  await expect(page.getByText("The queue is paused.")).toHaveCount(0);

  // The command that pauses is found by what it does.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("pause");
  await page.keyboard.press("Enter");
  await expect(page.getByText("The queue is paused.")).toBeVisible();
});

test("the keys and the command palette schedule the open draft, and a draft that cannot go out is not offered", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("By the keys");
  // No account is chosen: nothing can be scheduled.
  await expect(
    publishPanel(page).getByRole("button", { name: "Schedule…" }),
  ).toBeDisabled();
  await expect(
    publishPanel(page).getByRole("button", { name: "Add to queue" }),
  ).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await expect(
    palette.getByRole("option", { name: "Pause the queue" }),
  ).toBeVisible();
  await expect(palette.getByRole("option", { name: "Schedule…" })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");

  await channelChoice(page, grace).click();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Shift+S");
  const dialog = page.getByRole("dialog", { name: "Schedule this post" });
  await expect(dialog).toBeVisible();
  // Escape leaves the draft as it is.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editor(page)).toHaveValue("By the keys");

  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("option", { name: "Schedule…" }).click();
  await dialog.getByLabel("Date and time").fill("2031-05-06T09:30");
  // Enter in the field schedules.
  await dialog.getByLabel("Date and time").press("Enter");
  await expect(editor(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("option", { name: "Pause the queue" }).click();
  await openScreen(page, "Queue");
  await expect(page.getByText("The queue is paused.")).toBeVisible();
  // A post with a time of its own keeps it while the queue is paused.
  await expect(queueRow(page, "By the keys")).toContainText(
    "Tue, 6 May 2031, 09:30",
  );
});

test("posts are added to the queue, take its slots in their order, are reordered, paused, sent now and deleted", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);

  // Without posting times the queue has no time for a post, and says
  // where to set them.
  await openScreen(page, "Queue");
  await expect(page.getByText("Nothing scheduled")).toBeVisible();
  await page.getByRole("link", { name: "Set posting times" }).click();
  await addTime(page, "09:00", everyDay);
  await addTime(page, "17:00", everyDay);

  await openScreen(page, "Drafts");
  await addToQueue(page, "First");
  await expect(notice(page, "Added to the queue")).toBeVisible();
  await addToQueue(page, "Second");
  // Shared next: it goes to the front.
  await draftFor(page, "Third");
  await publishPanel(page)
    .getByRole("button", { name: "More ways to queue" })
    .click();
  await page.getByRole("menuitem", { name: /Share next/ }).click();
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Queue");
  await expectSync(page, "Synced");
  expect(await queueTitles(page)).toEqual(["Third", "First", "Second"]);
  await expect(queueRow(page, "Third")).toContainText("Queue · 1");
  await expect(queueRow(page, "Second")).toContainText("Queue · 3");
  // Each has a slot of its own: the times of the day take turns.
  const times = await queueTimes(page);
  expect(times).toHaveLength(3);
  for (const time of times) expect(time).toMatch(/, (09|17):00$/);
  expect(new Set(times).size).toBe(3);

  // Moved up, a post takes the slot of the one that it passes: the
  // order of the posts changes, and the times stay where they are.
  await page.getByRole("button", { name: "Move “Second” up" }).click();
  await expect
    .poll(() => queueTitles(page))
    .toEqual(["Third", "Second", "First"]);
  expect(await queueTimes(page)).toEqual(times);
  await act(page, "First", "Move to the top");
  await expect
    .poll(() => queueTitles(page))
    .toEqual(["First", "Third", "Second"]);
  // The first cannot go further up, and the last no further down.
  await expect(
    page.getByRole("button", { name: "Move “First” up" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move “Second” down" }),
  ).toBeDisabled();
  await expectSync(page, "Synced");
  expect(await queueTitles(page)).toEqual(["First", "Third", "Second"]);
  expect(await queueTimes(page)).toEqual(times);
  expect(await overflowOf(page)).toBe(0);

  // Paused, the queue says so plainly, and no post of it has a time.
  await page.getByRole("button", { name: "Pause queue" }).click();
  await expect(page.getByText("The queue is paused.")).toBeVisible();
  expect(await queueTimes(page)).toEqual(["Paused", "Paused", "Paused"]);
  await expectSync(page, "Synced");
  expect(await queueTimes(page)).toEqual(["Paused", "Paused", "Paused"]);
  await page.getByRole("button", { name: "Resume queue" }).click();
  await expect(page.getByText("The queue is paused.")).toHaveCount(0);
  await expect.poll(() => queueTimes(page)).toEqual(times);

  // Sent now, a post leaves the queue for the Sent screen, and the
  // others close up.
  await act(page, "First", "Send now");
  await expect.poll(() => queueTitles(page)).toEqual(["Third", "Second"]);
  await expect(queueRow(page, "Third")).toContainText("Queue · 1");

  // Deleted, a post can be brought back, to the place that it had.
  await act(page, "Third", "Delete");
  await expect.poll(() => queueTitles(page)).toEqual(["Second"]);
  await notice(page, "Scheduled post deleted")
    .getByRole("button", { name: "Undo" })
    .click();
  await expect.poll(() => queueTitles(page)).toEqual(["Third", "Second"]);
  await expectSync(page, "Synced");
  expect(await queueTitles(page)).toEqual(["Third", "Second"]);

  // Edit takes a post back to the drafts and opens it.
  await act(page, "Second", "Edit");
  await expect(editor(page)).toHaveValue("Second");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await backToList(page, isMobile);

  await openScreen(page, "Sent");
  await expect(sentPost(page, "First")).toContainText("Sent");
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace)).toContainText("First");
});

/** Writes a draft and schedules it for a time in 2031, from its editor. */
async function scheduleFor2031(page: Page, text: string) {
  await draftFor(page, text);
  await publishPanel(page).getByRole("button", { name: "Schedule…" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this post" });
  await dialog.getByLabel("Date and time").fill("2031-05-06T09:30");
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(editor(page)).toHaveCount(0);
}

test("a deleted scheduled post is only put aside while its Undo is offered, and deleted when that has passed", async ({
  ownPage: page,
}) => {
  // The notice with the Undo stays for ten seconds, which this waits out.
  test.slow();
  const { sandbox } = await workspacesOf(page);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await scheduleFor2031(page, "Not after all");
  await openScreen(page, "Queue");
  await expect(queueRow(page, "Not after all")).toBeVisible();

  await act(page, "Not after all", "Delete");
  const undo = notice(page, "Scheduled post deleted");
  await expect(undo).toBeVisible();
  // It is gone from the screen at once, and the server has it still:
  // put aside, for the Undo to take back.
  await expect(queueRows(page)).toHaveCount(0);
  await expect(page.getByText("Nothing scheduled")).toBeVisible();
  await expectSync(page, "Synced");
  expect(await postsOf(page, sandbox)).toMatchObject([
    { status: "scheduled", trashedAt: expect.any(Number) },
  ]);

  // When the notice has gone, nobody can take the deletion back, and
  // the post is deleted for good.
  await expect(undo).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => postsOf(page, sandbox)).toEqual([]);
  // Nowhere else either: not in the drafts, where a copy would be.
  await openScreen(page, "Drafts");
  await expect(draftRow(page, "Not after all")).toHaveCount(0);
});

test("an Undo after a delete that the server refused says where the post is, in one notice of the refusal, and leads there", async ({
  page,
  ownEmail,
  otherDevice,
  isMobile,
}) => {
  // Before the app opens its socket, which this is put in the way of.
  const connection = await connectionOf(page);
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await scheduleFor2031(page, "Taken back");
  await openScreen(page, "Queue");
  await expectSync(page, "Synced");

  // While this device has no connection, another takes the post back to
  // the drafts.
  await connection.cut();
  await expectSync(page, /Offline/);
  const other = await otherDevice();
  await openScreen(other, "Queue");
  await act(other, "Taken back", "Back to drafts");
  await expectSync(other, "Synced");

  // This one has not heard, and deletes the post from its queue.
  await act(page, "Taken back", "Delete");
  await expect(queueRows(page)).toHaveCount(0);
  await connection.restore();

  // The server did not delete a draft of somebody's from a Queue screen.
  // The device is told once, and what is true: not that the post went
  // out.
  const refusal = notice(page, "A scheduled post was not deleted");
  await expect(refusal).toContainText(
    "This post is back in the drafts: somebody took it back.",
  );
  // Closed, as a person does who has read it: it lies over the notice
  // with the Undo.
  await refusal.getByRole("button", { name: "Close toast" }).click();
  await expect(refusal).toHaveCount(0);
  // The Undo has nothing to take back, and says where the post is.
  await notice(page, "Scheduled post deleted")
    .getByRole("button", { name: "Undo" })
    .click();
  const nothing = notice(page, "Nothing to undo: the post was not deleted");
  await expect(nothing).toContainText(
    "Somebody had taken it back to the drafts before the delete reached pigy.",
  );
  // Read once the server has answered everything that the Undo made of
  // it: no second refusal has come, of something that followed the
  // delete, as a post that was not moved in the queue.
  await expectSync(page, "Synced");
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: /A (scheduled |deleted )?post was not/ }),
  ).toHaveCount(0);

  await nothing.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(editor(page)).toHaveValue("Taken back");
  await backToList(page, isMobile);
  // The other device has it as it left it: a draft.
  await openScreen(other, "Drafts");
  await expect(draftRow(other, "Taken back")).toBeVisible();
});

test("a post is queued without a connection, with the time that the queue will give it, and stays when the device is back", async ({
  page,
  ownEmail,
}) => {
  // Before the app opens its socket, which this is put in the way of.
  const connection = await connectionOf(page);
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openSchedule(page);
  await addTime(page, "09:00", everyDay);
  await expectSync(page, "Synced");
  await connection.cut();
  await expectSync(page, /Offline/);

  await openScreen(page, "Drafts");
  await addToQueue(page, "Written offline");
  await openScreen(page, "Queue");
  // The device has given it the next slot itself.
  const row = queueRow(page, "Written offline");
  await expect(row).toContainText(/, 09:00/);
  await page.getByRole("button", { name: "Pause queue" }).click();
  await expect(row).toContainText("Paused");
  await page.getByRole("button", { name: "Resume queue" }).click();

  await connection.restore();
  await expectSync(page, "Synced");
  // The server took the post and gave it the slot.
  await expect(row).toContainText(/, 09:00/);
  await expect(row).toContainText("Queue · 1");
});

test("the server publishes a scheduled post by itself when its time has come", async ({
  ownPage: page,
}) => {
  const { sandbox } = await workspacesOf(page);
  const channel = await connectInSandbox(page, sandbox, grace);

  // Scheduled a few seconds ahead, as a client of the sync protocol:
  // the field of the app goes by minutes. Nobody asks for it to be
  // published. This is the one test that waits for a time to come.
  const before = Date.now();
  const published = await publishNow(
    page,
    sandbox,
    channel,
    "Out by itself",
    4000,
  );

  expect(published.post.status).toBe("sent");
  expect(published.targets).toMatchObject([{ status: "sent", error: null }]);
  // Not before its time.
  expect(Date.now() - before).toBeGreaterThanOrEqual(4000);
  await page.goto("/sent");
  await expect(sentPost(page, "Out by itself")).toContainText("Sent");
  // It is not in the queue any more.
  await openScreen(page, "Queue");
  await expect(queueRows(page)).toHaveCount(0);
});

/** The names of a day as the calendar says them. */
function dayNames(page: Page, date: Date) {
  return page.evaluate((time) => {
    const say = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, {
        ...options,
        timeZone: "Europe/Rome",
      }).format(time);
    return {
      day: say({ weekday: "long", day: "numeric", month: "long" }),
      month: say({ month: "long", year: "numeric" }),
    };
  }, date.getTime());
}

test("the calendar shows what is scheduled and what went out on their days, a month as a grid or as its days on a phone", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await publishDraft(page, "Out today", grace);

  // The fifteenth of next month, at 09:30 in Rome.
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 12),
  );
  const date = next.toISOString().slice(0, 10);
  await draftFor(page, "Next month");
  await publishPanel(page).getByRole("button", { name: "Schedule…" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this post" });
  await dialog.getByLabel("Date and time").fill(`${date}T09:30`);
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Queue");
  await page
    .getByRole("navigation", { name: "Queue" })
    .getByRole("link", { name: "Calendar" })
    .click();
  const calendar = page.getByRole("region", { name: "Calendar" });
  const today = await dayNames(page, now);
  const then = await dayNames(page, next);
  /** The day of the calendar that is called `name`. */
  const dayOf = (name: string) =>
    isMobile
      ? calendar.getByRole("listitem").filter({ hasText: name })
      : calendar.getByRole("cell", { name });

  // This month, with what went out today. The post of next month is not
  // in it.
  await expect(calendar.getByRole("heading", { level: 2 })).toHaveText(
    today.month,
  );
  await expect(dayOf(today.day)).toContainText("Out today");
  await expect(dayOf(today.day)).toContainText("Sent");
  await expect(calendar.getByText("Next month")).toHaveCount(0);
  expect(await overflowOf(page)).toBe(0);

  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(calendar.getByRole("heading", { level: 2 })).toHaveText(
    then.month,
  );
  await expect(dayOf(then.day)).toContainText("09:30");
  await expect(dayOf(then.day)).toContainText("Next month");
  await expect(dayOf(then.day)).toContainText("Scheduled");
  await expect(calendar.getByText("Out today")).toHaveCount(0);
  expect(await overflowOf(page)).toBe(0);

  // "Today" leads back, and a post of the calendar to where it is.
  await calendar.getByRole("button", { name: "Today" }).click();
  await expect(calendar.getByRole("heading", { level: 2 })).toHaveText(
    today.month,
  );
  await dayOf(today.day)
    .getByRole("link", { name: /Out today/ })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent");
  await expect(sentPost(page, "Out today")).toBeVisible();
});
