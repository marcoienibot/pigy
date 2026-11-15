import {
  backToList,
  breakStorage,
  channelRows,
  connectionOf,
  connectSimulated,
  draftRow,
  draftRows,
  editor,
  expectElsewhere,
  expectSync,
  expectWorkspace,
  grace,
  localData,
  openScreen,
  switchTo,
  workspaceSwitch,
  writeDraft,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

// The two workspaces of a person, live and sandbox, and the switch between
// them. A tab shows one of them, which is its own choice, and the device
// remembers the last choice for the next tab.

/** Opens the menu of the account and asks to sign out. */
async function askToSignOut(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Account" })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}

/**
 * Notes, with every change of the page from now on, whether a notice with
 * `text` in it is on the page, and under which name: that of the sandbox,
 * which has its banner, or that of live. Returns how to read the notes.
 *
 * A notice that stayed for a moment after the name had changed is caught
 * here and nowhere else: by the time a test looks, it is gone either way.
 */
async function watchNotice(page: Page, text: string) {
  type Seen = { inSandbox: boolean; inLive: boolean; liveWithout: boolean };
  await page.evaluate((text) => {
    const seen = { inSandbox: false, inLive: false, liveWithout: false };
    Object.assign(window, { seenNotice: seen });
    new MutationObserver(() => {
      const sandbox = document.querySelector('[role="note"]') !== null;
      const shown = [...document.querySelectorAll("li")].some((item) =>
        item.textContent?.includes(text),
      );
      if (shown && sandbox) seen.inSandbox = true;
      if (shown && !sandbox) seen.inLive = true;
      if (!shown && !sandbox) seen.liveWithout = true;
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, text);
  return () =>
    page.evaluate(() => (window as unknown as { seenNotice: Seen }).seenNotice);
}

test("somebody new starts in the sandbox, which says so on every screen, and live does not", async ({
  ownPage: page,
}) => {
  await expectWorkspace(page, "Sandbox");
  const banner = page.getByRole("note");
  await expect(banner).toContainText("Sandbox");
  await expect(banner).toContainText("Nothing is posted for real");
  // The name of the tab says it too: two tabs can show the two workspaces.
  await expect(page).toHaveTitle("Drafts · Sandbox · pigy");
  for (const screen of ["Queue", "Sent", "Channels", "Settings"]) {
    await openScreen(page, screen);
    await expect(banner).toBeVisible();
  }

  await switchTo(page, "Live");

  // The same screen, without any of it.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page).toHaveTitle("Settings · pigy");
  for (const screen of ["Drafts", "Queue", "Sent", "Channels"]) {
    await openScreen(page, screen);
    await expect(banner).toHaveCount(0);
  }
});

test("each workspace shows its own drafts and channels, never under the name of the other, and the choice survives a reload", async ({
  ownPage: page,
  isMobile,
}) => {
  // Notes what is listed under which name, with every change of the page.
  // A list that was on screen under the wrong name for a moment, between
  // two renders, is caught here and nowhere else. The script runs on every
  // page load from here on, of which connecting an account is the first,
  // so the notes are read before each later one.
  await page.addInitScript(() => {
    const seen = window as {
      listed?: { sandbox: boolean; live: boolean; mixed: boolean };
    };
    seen.listed = { sandbox: false, live: false, mixed: false };
    new MutationObserver(() => {
      const { listed } = seen;
      if (!listed) return;
      // The banner of the sandbox.
      const inSandbox = document.querySelector('[role="note"]') !== null;
      const rows = document.querySelectorAll(
        'ul[aria-label="Drafts"] a, ul[aria-label="Channels"] li',
      );
      for (const row of rows) {
        const text = row.textContent ?? "";
        if (text.includes("Sandbox draft") || text.includes("@grace@")) {
          listed.sandbox = true;
          if (!inSandbox) listed.mixed = true;
        }
        if (text.includes("Live draft")) {
          listed.live = true;
          if (inSandbox) listed.mixed = true;
        }
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  const listed = () =>
    page.evaluate(
      () =>
        (
          window as {
            listed?: { sandbox: boolean; live: boolean; mixed: boolean };
          }
        ).listed,
    );

  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await writeDraft(page, isMobile, "Sandbox draft");

  // Live has neither.
  await switchTo(page, "Live");
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
  await writeDraft(page, isMobile, "Live draft");
  await expect(draftRows(page)).toHaveCount(1);
  await openScreen(page, "Channels");
  await expect(
    page.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
  await expect(channelRows(page)).toHaveCount(0);
  // Both were looked at, or the note below would say nothing: what the
  // sandbox has and the draft of live, since the page was last loaded.
  expect(await listed()).toEqual({ sandbox: true, live: true, mixed: false });

  // The tab remembers.
  await page.reload();
  await expectWorkspace(page, "Live");
  await openScreen(page, "Drafts");
  await expect(draftRow(page, "Live draft")).toBeVisible();
  await expect(draftRows(page)).toHaveCount(1);

  // And back: the sandbox has what was left in it, and nothing of live.
  await switchTo(page, "Sandbox");
  await expect(draftRow(page, "Sandbox draft")).toBeVisible();
  await expect(draftRows(page)).toHaveCount(1);
  await openScreen(page, "Channels");
  await expect(channelRows(page)).toHaveCount(1);
  await expect(channelRows(page)).toContainText(grace);
  expect(await listed()).toEqual({ sandbox: true, live: true, mixed: false });
});

test("a new tab starts with the workspace that was chosen last on the device, and every tab keeps its own", async ({
  ownPage: first,
  context,
}) => {
  await switchTo(first, "Live");

  // The device remembers the choice for the next tab.
  const second = await context.newPage();
  await second.goto("/");
  await expectWorkspace(second, "Live");

  // The second tab goes on to the sandbox, and the first does not follow.
  // Not at its next step either, which is when a tab asks itself which
  // workspace it shows: without that step, this would only say that the
  // first tab has not followed yet.
  await switchTo(second, "Sandbox");
  await openScreen(first, "Queue");
  await expectWorkspace(first, "Live");
  // And not over a reload, although the sandbox is what the device has
  // been told last.
  await first.reload();
  await expectWorkspace(first, "Live");

  // Which is where the next tab starts.
  const third = await context.newPage();
  await third.goto("/");
  await expectWorkspace(third, "Sandbox");
});

test("a draft that is open when the workspace changes is closed, and nothing is written into the other workspace", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Written in the sandbox");

  // With the keyboard, from inside the text: on a phone the editor is over
  // the switch.
  const palette = page.getByRole("dialog", { name: "Commands" });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("switch to live");
  await page.keyboard.press("Enter");

  await expectWorkspace(page, "Live");
  // The address named the draft, which live does not have.
  await expect(page).toHaveURL("/");
  await expect(editor(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();

  // What is written from here on is live's, and the draft of the sandbox
  // is as it was left.
  await writeDraft(page, isMobile, "Written live");
  await switchTo(page, "Sandbox");
  await expect(draftRows(page)).toHaveCount(1);
  await draftRow(page, "Written in the sandbox").click();
  await expect(editor(page)).toHaveValue("Written in the sandbox");
});

test("the offer to bring a deleted draft back goes when the workspace changes", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Deleted in the sandbox");
  // The notice leaves by itself ten seconds after it has come, and the
  // notice library takes a notice off the screen over several frames. The
  // clock of the page stands still from here on, so neither happens
  // unless the test says so: only the switch can make the notice go,
  // however long the machine takes over the steps.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);
  await draftRow(page, "Deleted in the sandbox").click();
  await page.getByRole("button", { name: "Delete draft" }).click();
  const notice = page
    .getByRole("listitem")
    .filter({ hasText: "Draft deleted" });
  // A notice is put on screen a moment after the app has said so, which
  // the clock is moved for.
  await page.clock.runFor(1_000);
  await expect(notice).toBeVisible();
  const seen = await watchNotice(page, "Draft deleted");

  // The choice of the switch opens a moment after it is asked for, like a
  // notice. From the choice on, the clock stands still.
  await workspaceSwitch(page).click();
  await page.clock.runFor(1_000);
  await page.getByRole("menuitemradio", { name: /^Live/ }).click();
  await expectWorkspace(page, "Live");

  // In live there is nothing to bring the draft back into. The notice is
  // gone the moment the page says "live", not a while later: this looks
  // once and does not wait.
  expect(await notice.count()).toBe(0);
  // It was never there under the name of live, between two renders
  // either. The first two say that the page was watched in both
  // workspaces, without which the third would say nothing.
  expect(await seen()).toEqual({
    inSandbox: true,
    liveWithout: true,
    inLive: false,
  });
  await page.clock.resume();
  // And the keys that undo bring nothing into live.
  await page.keyboard.press("ControlOrMeta+z");
  await switchTo(page, "Sandbox");
  // Back in the sandbox, the draft is still deleted, and live has stayed
  // empty: the first is waited for, so the second says something.
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
  await switchTo(page, "Live");
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
});

test("the notice of a refused change leaves the screen with its workspace and is back with it", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  // The route above only applies to sockets that are opened after it.
  await page.reload();
  await writeDraft(page, isMobile, "Doomed draft");
  await expectSync(page, "Synced");
  const other = await otherDevice();
  // Edited here, offline, and deleted there in the meantime: the server
  // refuses the edit when it arrives.
  await connection.cut();
  await draftRow(page, "Doomed draft").click();
  await editor(page).fill("Edited after it was deleted elsewhere");
  await draftRow(other, "Doomed draft").click();
  await other.getByRole("button", { name: "Delete draft" }).click();
  await expect(draftRows(other)).toHaveCount(0);
  await connection.restore();
  const notice = page
    .getByRole("listitem")
    .filter({ hasText: "An edit was not saved" });
  await expect(notice).toBeVisible();
  const seen = await watchNotice(page, "An edit was not saved");

  // It is about the sandbox, and is not shown under the name of live: not
  // when the page first says "live", which is looked at once and not
  // waited for, and not between two renders on the way there.
  await switchTo(page, "Live");
  expect(await notice.count()).toBe(0);
  expect(await seen()).toEqual({
    inSandbox: true,
    liveWithout: true,
    inLive: false,
  });

  // Taking it off the screen was not the person dismissing it, which
  // would have deleted it: it is there again with the sandbox, and with
  // what it offers.
  await switchTo(page, "Sandbox");
  await expect(notice).toBeVisible();
  await expect(
    notice.getByRole("button", { name: "Keep as new draft" }),
  ).toBeVisible();
  // Dismissed by the person, it is gone for good: also from the copy,
  // which is where it would come back from after loading the page again.
  await notice.getByRole("button", { name: "Close toast" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expectSync(page, "Synced");
  await expect(notice).toHaveCount(0);
});

test("signing out counts the changes that were not synced in the workspace that is not on screen", async ({
  ownPage: page,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  // Only the socket fails: signing out itself still reaches the server.
  await connection.cut({ api: true });
  // Two changes: the draft, and the text that was put in it.
  await writeDraft(page, isMobile, "Only on this device");
  await expectSync(page, "Offline · 2 changes");

  // Live has nothing that waits, and says so. That is not all there is to
  // say of this window, so the switch says what waits in the sandbox.
  await switchTo(page, "Live");
  await expectSync(page, "Offline");
  await expectElsewhere(page, "Sandbox: Offline · 2 changes");
  await askToSignOut(page);

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 changes have not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();
  await switchTo(page, "Sandbox");
  await expect(draftRow(page, "Only on this device")).toBeVisible();
  await expectSync(page, "Offline · 2 changes");
});

test("a change that could not be saved is not lost when the workspace changes, and signing out counts it", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");
  // Live is looked at once while the device can still write: that is when
  // its copy is made. The sandbox holds nothing that waits, and the switch
  // says nothing about it.
  await switchTo(page, "Live");
  await expectSync(page, "Synced");
  await expectElsewhere(page, "");
  await switchTo(page, "Sandbox");

  // The device has no room left, and the next change exists only in the
  // memory of this window.
  const storage = await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room left");
  await expectSync(page, "Not saved · 1 change");
  await backToList(page, isMobile);

  // Nothing is wrong with live, which is what the indicator is about now.
  // "Synced" is not the whole story of this window, though: closing it
  // would lose the change of the sandbox, and the switch says so.
  await switchTo(page, "Live");
  await expectSync(page, "Synced");
  await expectElsewhere(page, "Sandbox: Not saved · 1 change");
  // The words are also where a phone has room for them: at the sandbox, in
  // the choice that the switch opens.
  await workspaceSwitch(page).click();
  await expect(
    page.getByRole("menuitemradio", { name: /^Sandbox/ }),
  ).toContainText("Not saved · 1 change");
  await page.keyboard.press("Escape");
  // Signing out would lose it too.
  await askToSignOut(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("1 change has not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();

  // The window has kept it over the two switches. When there is room
  // again, it is saved with the next change, and both reach the server.
  await switchTo(page, "Sandbox");
  await expectSync(page, "Not saved · 1 change");
  await storage.repair();
  await draftRow(page, "Written with no room left").click();
  await editor(page).press("End");
  await page.keyboard.type(", and then some");
  await expectSync(page, "Synced");
  // Now that nothing would be lost, the page goes without a question from
  // the browser. One that it asked would be noted here, before the page
  // is loaded again.
  const questions: string[] = [];
  page.on("dialog", (dialog) => {
    questions.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  await expect(editor(page)).toHaveValue(
    "Written with no room left, and then some",
  );
  expect(questions).toEqual([]);
});

test("the browser asks before a window is closed that holds an unsaved change of the workspace that is not on screen", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");
  // Live is looked at once while the device can still write: that is when
  // its copy is made.
  await switchTo(page, "Live");
  await expectSync(page, "Synced");
  await switchTo(page, "Sandbox");
  await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room left");
  await expectSync(page, "Not saved · 1 change");
  await backToList(page, isMobile);
  // On to live, where nothing is unsaved and the indicator says so.
  await switchTo(page, "Live");
  await expectSync(page, "Synced");

  // The tab is closed, as a person closes it: the page has its say first.
  // It asks, with the question of the browser, and the person stays.
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const question = await asked;
  expect(question.type()).toBe("beforeunload");
  await question.dismiss();

  // The window is still there, and so is what only it holds.
  await switchTo(page, "Sandbox");
  await expectSync(page, "Not saved · 1 change");
  await draftRow(page, "Written with no room left").click();
  await expect(editor(page)).toHaveValue("Written with no room left");
});

test("signing out counts a change that another tab could not save in the other workspace", async ({
  ownPage: first,
  context,
  isMobile,
}) => {
  await writeDraft(first, isMobile, "Written while there was room");
  await expectSync(first, "Synced");
  // Two tabs on the sandbox, of which the first goes on to live.
  const second = await context.newPage();
  await second.goto("/");
  await expect(draftRow(second, "Written while there was room")).toBeVisible();
  await switchTo(first, "Live");
  await expectSync(first, "Synced");

  // The second tab cannot write the copy of the sandbox, and says so.
  await breakStorage(second);
  await draftRow(second, "Written while there was room").click();
  await editor(second).fill("Written in the second tab");
  await expectSync(second, "Not saved · 1 change");

  // The first tab shows live, where nothing is unsaved, and shares no copy
  // with the second any more. Signing out here still makes the second tab
  // start again, without its change, so the app asks first.
  await askToSignOut(first);
  const dialog = first.getByRole("alertdialog");
  await expect(dialog).toContainText("1 change has not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();
  await expect(editor(second)).toHaveValue("Written in the second tab");
});

test("what was written offline in one workspace is sent when the app starts on the other", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  // Another device, which shows the sandbox.
  const other = await otherDevice();

  await connection.cut();
  await writeDraft(page, isMobile, "Written offline in the sandbox");
  await expectSync(page, "Offline · 2 changes");
  await switchTo(page, "Live");
  // The app starts again, on live, and still without the server. The
  // sandbox is not on screen and never was since: its draft is in its copy
  // on the device.
  await page.reload();
  await expectWorkspace(page, "Live");
  await expectSync(page, "Offline");

  // The draft is sent all the same when the connection is back.
  await connection.restore();
  await expect(draftRow(other, "Written offline in the sandbox")).toBeVisible();
});

test("a tab goes on sending what was written in the workspace that it has left", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  // Another device, which shows the sandbox.
  const other = await otherDevice();

  await connection.cut();
  await writeDraft(page, isMobile, "Written before leaving the sandbox");
  await switchTo(page, "Live");
  await expectSync(page, "Offline");

  await connection.restore();
  await expect(
    draftRow(other, "Written before leaving the sandbox"),
  ).toBeVisible();
});

test("signing out deletes the copies of both workspaces and the choice between them", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "In the sandbox");
  await expectSync(page, "Synced");
  await switchTo(page, "Live");
  await writeDraft(page, isMobile, "In live");
  await expectSync(page, "Synced");
  // What the device remembers of the choice: for the tab, and for the
  // next one.
  const choice = () =>
    page.evaluate(() => [
      sessionStorage.getItem("pigy-workspace"),
      localStorage.getItem("pigy-workspace"),
    ]);
  // Otherwise the checks below would pass without looking at anything.
  expect((await localData(page)).copies).toHaveLength(2);
  expect(await choice()).toEqual([expect.any(String), expect.any(String)]);

  await askToSignOut(page);

  await expect(page).toHaveURL("/sign-in");
  expect(await localData(page)).toEqual({ copies: [], session: null });
  // So whoever signs in next starts where somebody new does, also if it is
  // the same person in the same tab.
  expect(await choice()).toEqual([null, null]);
});
