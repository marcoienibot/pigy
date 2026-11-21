import {
  backToList,
  breakStorage,
  connectionOf,
  draftRow,
  draftRows,
  editor,
  expectSync,
  holdStorage,
  localData,
  selectionOf,
  syncSockets,
  writeDraft,
} from "../app.ts";
import { expect, signIn, test } from "../fixtures.ts";

// The drafts of one person on several devices and in several tabs, with
// and without a connection. What the server and the client say to each
// other is tested in apps/worker and packages/core: these tests are about
// what a person sees.

test("a draft made on one device appears on another without a reload", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const other = await otherDevice();
  await expect(
    other.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();

  await writeDraft(page, isMobile, "Hello from the first device");

  await expect(draftRow(other, "Hello from the first device")).toBeVisible();

  // And the other way round, into a draft that is open.
  await draftRow(page, "Hello from the first device").click();
  await draftRow(other, "Hello from the first device").click();
  await editor(other).fill("Hello back from the second device");
  await expect(editor(page)).toHaveValue("Hello back from the second device");
});

test("the editor closes when its draft is deleted on another device", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Short-lived");
  const other = await otherDevice();
  await draftRow(page, "Short-lived").click();
  await expect(editor(page)).toHaveValue("Short-lived");

  await draftRow(other, "Short-lived").click();
  await other.getByRole("button", { name: "Delete draft" }).click();

  await expect(editor(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("an edit made offline survives a reload and syncs when the connection is back", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  // The route above only applies to sockets that are opened after it.
  await page.reload();
  await writeDraft(page, isMobile, "Written online");
  await expectSync(page, "Synced");
  const other = await otherDevice();
  await expect(draftRow(other, "Written online")).toBeVisible();

  await connection.cut();
  await expectSync(page, "Offline");
  await draftRow(page, "Written online").click();
  await editor(page).fill("Edited offline");
  // Several keystrokes, one change to send.
  await page.keyboard.type(", twice");
  await expectSync(page, "Offline · 1 change");
  await expect(draftRow(other, "Written online")).toBeVisible();

  // The app starts again without the server: neither the session nor the
  // socket gets an answer.
  await page.reload();
  await expect(editor(page)).toHaveValue("Edited offline, twice");
  await expectSync(page, "Offline · 1 change");
  await backToList(page, isMobile);
  await expect(draftRow(page, "Edited offline, twice")).toBeVisible();

  await connection.restore();
  await expectSync(page, "Synced");
  await expect(draftRow(other, "Edited offline, twice")).toBeVisible();
});

test("the drafts are listed from the local copy when the server cannot be reached", async ({
  ownPage: page,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await writeDraft(page, isMobile, "One");
  await writeDraft(page, isMobile, "Two");
  await expectSync(page, "Synced");

  await connection.cut();
  const attempts = connection.attempts;
  await page.reload();

  await expect(draftRows(page)).toHaveCount(2);
  await expect(draftRow(page, "One")).toBeVisible();
  await expectSync(page, "Offline");
  // It did try: the list was not waiting for a socket that came.
  expect(connection.attempts).toBeGreaterThan(attempts);

  // And it takes new work: a draft, and the text that was put in it.
  await writeDraft(page, isMobile, "Three, offline");
  await expect(draftRows(page)).toHaveCount(3);
  await expectSync(page, "Offline · 2 changes");
});

test("a draft is listed where it will stay before the server has confirmed it, on a device whose clock is behind", async ({
  ownPage: page,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  // From here on the clock of the page says that it is an hour earlier
  // than the server takes it for, and goes on running. The app starts
  // again under that clock, and with the route above, which only applies
  // to sockets that are opened after it.
  await page.clock.install({ time: Date.now() - 3_600_000 });
  await page.reload();
  await writeDraft(page, isMobile, "Confirmed");
  // The server has said when that draft was written, by its own clock.
  await expectSync(page, "Synced");

  // The next draft is held back on its way to the server, so that the
  // moment lasts in which only the device knows of it. By the clock of the
  // device it was written an hour before the other one.
  connection.hold();
  await writeDraft(page, isMobile, "Not confirmed yet");
  await expectSync(page, "Syncing 2 changes");
  // It was written last all the same, and that is where the server will
  // put it: at the top.
  await expect(draftRows(page).first()).toContainText("Not confirmed yet");

  // The confirmation moves nothing.
  connection.release();
  await expectSync(page, "Synced");
  await expect(draftRows(page).first()).toContainText("Not confirmed yet");
  await expect(draftRows(page)).toHaveCount(2);
});

test("two tabs stay in step, and only one of them holds a socket", async ({
  ownPage: first,
  context,
  otherDevice,
  isMobile,
}) => {
  await writeDraft(first, isMobile, "From the first tab");
  await expectSync(first, "Synced");
  const second = await context.newPage();
  const sockets = syncSockets(second);
  await second.goto("/");

  // The second tab shows what the first one made, from the copy that they
  // share, and what the first one says about the connection.
  await expect(draftRow(second, "From the first tab")).toBeVisible();
  await expectSync(second, "Synced");

  // A change in either shows in the other at once.
  await writeDraft(second, isMobile, "From the second tab");
  await expect(draftRow(first, "From the second tab")).toBeVisible();
  await draftRow(first, "From the second tab").click();
  await editor(first).fill("Changed in the first tab");
  await expect(draftRow(second, "Changed in the first tab")).toBeVisible();
  await expectSync(second, "Synced");

  // What the second tab made has reached the server, through the socket
  // of the first: the second has none.
  const other = await otherDevice();
  await expect(draftRow(other, "Changed in the first tab")).toBeVisible();
  expect(sockets).toEqual([]);
});

test("another tab takes the socket over when the tab that holds it is closed", async ({
  ownPage: first,
  context,
  otherDevice,
  isMobile,
}) => {
  await expectSync(first, "Synced");
  const second = await context.newPage();
  const sockets = syncSockets(second);
  await second.goto("/");
  await expectSync(second, "Synced");
  expect(sockets).toEqual([]);

  await first.close();

  await expect.poll(() => sockets.length).toBe(1);
  await expectSync(second, "Synced");
  // The socket works: what the second tab writes now reaches other devices.
  await writeDraft(second, isMobile, "After the first tab was closed");
  const other = await otherDevice();
  await expect(draftRow(other, "After the first tab was closed")).toBeVisible();
});

test("an edit that the server refuses is taken back, and the person is told", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await writeDraft(page, isMobile, "Doomed draft");
  await expectSync(page, "Synced");
  const other = await otherDevice();

  // Edited here, offline, and deleted there in the meantime. The text
  // begins with an indentation and ends with an empty line, which are part
  // of what was written.
  const written = "  Edited after it was deleted elsewhere\n";
  await connection.cut();
  await draftRow(page, "Doomed draft").click();
  await editor(page).fill(written);
  await draftRow(other, "Doomed draft").click();
  await other.getByRole("button", { name: "Delete draft" }).click();
  await expect(draftRows(other)).toHaveCount(0);

  await connection.restore();

  // The draft is gone here too, and the edit is not lost without a word.
  const notice = page
    .getByRole("listitem")
    .filter({ hasText: "An edit was not saved" });
  await expect(notice).toContainText("This post no longer exists");
  await expect(notice).toContainText("Edited after it was deleted elsewhere");
  await expect(editor(page)).toHaveCount(0);
  await expect(draftRows(page)).toHaveCount(0);
  await expectSync(page, "Synced");

  // The notice stays until it is dealt with, also over a reload.
  await page.reload();
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Keep as new draft" }).click();
  // All of it: the notice quotes the text without the space around it, and
  // the draft is not made from the quote.
  await expect(editor(page)).toHaveValue(written);
  await expect(notice).toHaveCount(0);
  await expect(draftRow(other, "Edited after it was deleted")).toBeVisible();
  await page.reload();
  await expect(editor(page)).toHaveValue(written);
  await expect(notice).toHaveCount(0);
});

test("what is typed stays when the same draft is changed elsewhere", async ({
  ownPage: page,
  otherDevice,
  isMobile,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await writeDraft(page, isMobile, "Shared draft");
  await expectSync(page, "Synced");
  const other = await otherDevice();
  await draftRow(page, "Shared draft").click();
  await draftRow(other, "Shared draft").click();

  // Typed here while the connection is down, with the caret left in the
  // middle of the text, and changed there.
  await connection.cut();
  await editor(page).fill("What I am typing right now");
  await page.keyboard.press("Home");
  for (let moved = 0; moved < 6; moved += 1) {
    await page.keyboard.press("ArrowRight");
  }
  expect(await selectionOf(page)).toEqual([6, 6]);
  await editor(other).fill("Changed on the other device");
  await expectSync(other, "Synced");

  // The connection is back, and the change from the other device arrives.
  // The text that was typed here is held back on its way to the server, so
  // that the moment lasts in which the copy has the other device's text
  // under an edit that the server has not seen. The indicator says when it
  // has come: online, with one change to send.
  connection.hold();
  await connection.restore();
  await expectSync(page, "Syncing 1 change");
  // Had the text from elsewhere taken the place of the typed one, it would
  // be on screen now, and the caret would be at its end.
  await expect(editor(page)).toHaveValue("What I am typing right now");
  expect(await selectionOf(page)).toEqual([6, 6]);

  // Then this device's text is the later one, everywhere.
  connection.release();
  await expectSync(page, "Synced");
  await expect(editor(page)).toHaveValue("What I am typing right now");
  await expect(editor(other)).toHaveValue("What I am typing right now");

  // With nothing being typed here, a change from elsewhere does replace
  // the text. A browser puts the caret at the end of a field whose text is
  // set, and the editor puts it back where the person had it.
  await editor(other).fill("Changed again on the other device");
  await expect(editor(page)).toHaveValue("Changed again on the other device");
  expect(await selectionOf(page)).toEqual([6, 6]);
  await expect(editor(page)).toBeFocused();
});

test("a change that the device cannot save is not called saved", async ({
  ownPage: page,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");

  // The device has no room left: the local copy cannot be written.
  const storage = await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room");
  await page.keyboard.type(" left");

  // The connection is fine, and that is not what the indicator is about
  // now: the change is in this window and nowhere else. It is one change,
  // the text of the draft, although it took several keys.
  await expectSync(page, "Not saved · 1 change");
  await backToList(page, isMobile);
  await page
    .getByRole("button", { name: "Sync: Not saved · 1 change" })
    .filter({ visible: true })
    .first()
    .click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("could not save 1 change on this device");
  await expect(detail).toContainText("only in this window");
  await page.keyboard.press("Escape");

  // Signing out would lose it, so the app asks first, although the copy on
  // the device holds nothing that the server has not got.
  await page
    .getByRole("button", { name: "Account" })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("1 change has not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();

  // There is room again. The next change is saved, and the one before it
  // with it: both reach the server.
  await storage.repair();
  await draftRow(page, "Written with no room left").click();
  await editor(page).press("End");
  await page.keyboard.type(", and then some");
  await expectSync(page, "Synced");
  await page.reload();
  await expect(editor(page)).toHaveValue(
    "Written with no room left, and then some",
  );
});

test("signing out asks first when another tab holds a change that it could not save", async ({
  ownPage: first,
  context,
  isMobile,
}) => {
  await writeDraft(first, isMobile, "Written while there was room");
  await expectSync(first, "Synced");
  const second = await context.newPage();
  await second.goto("/");

  // The second tab cannot write the local copy, and says so.
  await breakStorage(second);
  await draftRow(second, "Written while there was room").click();
  await editor(second).fill("Written in the second tab");
  await expectSync(second, "Not saved · 1 change");

  // Nothing in the first tab is unsaved, and the copy on the device holds
  // nothing that the server has not got. Signing out here still makes the
  // second tab start again, without its change, so the app asks first. The
  // second tab told the first of the change before it said so on screen.
  await expectSync(first, "Synced");
  const account = first
    .getByRole("button", { name: "Account" })
    .filter({ visible: true });
  await account.click();
  await first.getByRole("menuitem", { name: "Sign out" }).click();
  const dialog = first.getByRole("alertdialog");
  await expect(dialog).toContainText("1 change has not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();
  await expect(editor(second)).toHaveValue("Written in the second tab");

  // The second tab is closed, and its change is gone with it: there is
  // nothing left to ask about. The first tab does not go on asking because
  // of a tab that can no longer tell it otherwise. It gives that tab two
  // seconds to answer before it signs out, hence the longer wait.
  await second.close();
  await account.click();
  await first.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(first).toHaveURL("/sign-in", { timeout: 15_000 });
  expect(await localData(first)).toEqual({ copies: [], session: null });
});

test("signing out deletes the local copy, and signs the other tabs out", async ({
  ownPage: page,
  context,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Not to be left behind");
  await expectSync(page, "Synced");
  const second = await context.newPage();
  await second.goto("/");
  await expect(draftRow(second, "Not to be left behind")).toBeVisible();
  const before = await localData(page);
  // Otherwise the check below would pass without looking at anything.
  expect(before.copies).toHaveLength(1);
  expect(before.session).toContain("writer");

  await page
    .getByRole("button", { name: "Account" })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page).toHaveURL("/sign-in");
  expect(await localData(page)).toEqual({ copies: [], session: null });
  // The other tab had the copy open and the drafts on screen.
  await expect(second).toHaveURL("/sign-in");
});

test("signing out with changes that are not synced asks first", async ({
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
  const account = page
    .getByRole("button", { name: "Account" })
    .filter({ visible: true });

  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 changes have not been synced");
  await dialog.getByRole("button", { name: "Stay signed in" }).click();
  await expect(draftRow(page, "Only on this device")).toBeVisible();

  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await dialog.getByRole("button", { name: "Sign out and delete" }).click();

  await expect(page).toHaveURL("/sign-in");
  expect(await localData(page)).toEqual({ copies: [], session: null });
});

test("changes that were not synced survive the end of a session", async ({
  ownPage: page,
  ownEmail,
  otherDevice,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  // Cut off from the API too. An app that can still reach it asks the
  // server every time its socket fails again, and would be told that the
  // session is over at a moment that the test does not choose: it leaves
  // for the sign-in page then, in the middle of the test's next step.
  await connection.cut();
  await writeDraft(page, isMobile, "Written before the session ended");
  await expectSync(page, "Offline · 2 changes");
  // On another screen than the one the app starts on, which is where it
  // has to come back to.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Queue" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");

  // The session ends without the app having a say, as when it runs out:
  // this request is not the app's, and does not pass through the cut.
  const signOut = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);

  // The connection is back. The server refuses the socket, the app asks
  // why, and leaves for the sign-in page by itself.
  await connection.restore();
  await expect(page).toHaveURL("/sign-in?returnTo=%2Fqueue");
  await expect(page.getByRole("main")).toContainText(
    `2 changes made on this device as ${ownEmail} could be synced`,
  );
  // The copy is kept for that, and nothing of it is shown.
  expect((await localData(page)).copies).toHaveLength(1);

  // The same person signs in again, and the change is sent.
  await signIn(page, ownEmail);
  await expect(page).toHaveURL("/queue");
  await expectSync(page, "Synced");
  const other = await otherDevice();
  await expect(
    draftRow(other, "Written before the session ended"),
  ).toBeVisible();
});

test("a session that ends waits for a change that is still being written, and keeps it", async ({
  ownPage: page,
  ownEmail,
  otherDevice,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await writeDraft(page, isMobile, "Written while signed in");
  await expectSync(page, "Synced");
  // Cut off, API included, so that the app hears that the session is over
  // when the test says: see the test above.
  await connection.cut();
  // The device is slow: the next change is in this window and on its way
  // to the disk, and nothing has failed.
  const storage = await holdStorage(page);
  await draftRow(page, "Written while signed in").click();
  await editor(page).fill("Finished as the session ended");

  const signOut = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);
  // The server refuses the socket, the app asks why and hears that the
  // session is over.
  await connection.restore();

  // It does not leave: the change would be lost with the page. After the
  // moment that a write usually takes, it says so, over the app.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("You have been signed out");
  await expect(dialog).toContainText("has not finished saving");
  expect(new URL(page.url()).pathname).not.toBe("/sign-in");

  // The write goes through, and the window leaves by itself. The change
  // is in the copy, which is kept for it: one change, the text.
  await storage.release();
  await expect(page).toHaveURL(/^[^?]*\/sign-in\?returnTo=/);
  await expect(page.getByRole("main")).toContainText(
    `1 change made on this device as ${ownEmail} could be synced`,
  );

  // The same person signs in again, and the change is sent.
  await signIn(page, ownEmail);
  await expectSync(page, "Synced");
  const other = await otherDevice();
  await expect(draftRow(other, "Finished as the session ended")).toBeVisible();
});

test("a session that ends does not go without a change that could not be saved unless the person says so", async ({
  ownPage: page,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");
  await connection.cut();
  // The device has no room left, and the change stays in this window.
  await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room left");
  await expectSync(page, "Not saved · 1 change");

  const signOut = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);
  await connection.restore();

  // The window stays, and says what is at stake.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("You have been signed out");
  await expect(dialog).toContainText("could not save 1 change on this device");
  // Well after the app has begun to wait, it is still there: no time
  // that runs out decides for the person.
  await page.waitForTimeout(3_000);
  expect(new URL(page.url()).pathname).not.toBe("/sign-in");

  // The person lets the change go. The app has asked, so the browser does
  // not ask again as it would for a page that is left with such a change.
  let asked = false;
  page.on("dialog", (question) => {
    asked = true;
    void question.accept();
  });
  await dialog.getByRole("button", { name: "Lose them and sign in" }).click();
  await expect(page).toHaveURL(/^[^?]*\/sign-in\?returnTo=/);
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  // Nothing was kept, and the page does not say that anything was.
  await expect(page.getByText("could be synced")).toHaveCount(0);
  expect(asked).toBe(false);
});

test("another tab of a session that has ended saves its change before it starts again", async ({
  ownPage: first,
  ownEmail,
  context,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(first);
  await first.reload();
  await writeDraft(first, isMobile, "Written while there was room");
  await expectSync(first, "Synced");
  // The second tab asks the server who is signed in as it starts, while
  // the session is good, and is not navigated after that: it hears that
  // the session is over from the first tab and not from the server.
  const second = await context.newPage();
  await second.goto("/");
  const storage = await breakStorage(second);
  await draftRow(second, "Written while there was room").click();
  await editor(second).fill("Written in the second tab");
  await expectSync(second, "Not saved · 1 change");

  await connection.cut();
  const signOut = await first.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);
  await connection.restore();

  // The first tab holds nothing, and leaves. The copy on the device holds
  // nothing that the server has not got either, and is kept all the same,
  // for the second tab, without a word about changes that are not in it.
  await expect(first).toHaveURL(/^[^?]*\/sign-in/);
  await expect(
    first.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(first.getByText("could be synced")).toHaveCount(0);
  expect((await localData(first)).copies).not.toEqual([]);

  // The second tab has heard, and stays for its change.
  const dialog = second.getByRole("alertdialog");
  await expect(dialog).toContainText("You have been signed out");
  await expect(dialog).toContainText("could not save 1 change on this device");

  // There is room again. The store tries every few seconds, the change is
  // in the copy, and the tab starts again: on the sign-in page, which
  // says what is kept.
  await storage.repair();
  await expect(second).toHaveURL(/^[^?]*\/sign-in/, { timeout: 15_000 });
  await expect(second.getByRole("main")).toContainText(
    `1 change made on this device as ${ownEmail} could be synced`,
  );
});

test("changes that were kept after a session ended can be deleted", async ({
  ownPage: page,
  context,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  await connection.cut();
  await writeDraft(page, isMobile, "Not worth keeping");
  await expectSync(page, "Offline · 2 changes");
  // The window is closed before the session ends, and the next one opens
  // on the sign-in page. In a window that is left open, the app goes to
  // the sign-in page by itself once it has heard that the session is over,
  // and a test that is on its own way there is cut short by that.
  await page.close();
  const signOut = await context.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);

  // Straight to the sign-in page, as somebody else would who wants to use
  // this device. Nothing on the device knows yet that the session is over:
  // it is this page that finds out, and keeps the changes.
  const visitor = await context.newPage();
  await visitor.goto("/sign-in");
  await visitor.getByRole("button", { name: "Delete these changes" }).click();
  const dialog = visitor.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete 2 changes?");
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(visitor.getByText("could be synced")).toHaveCount(0);
  expect(await localData(visitor)).toEqual({ copies: [], session: null });
});

test("a window that is too old for the server says that it has to be reloaded", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  // The server of this test is the same version as the app, so the test
  // answers the hello in its place, as a server would that speaks a later
  // version of the protocol: with an error and the code 4400.
  const sockets: string[] = [];
  await page.routeWebSocket(/\/sync\//, (socket) => {
    sockets.push(new URL(socket.url()).pathname);
    if (sockets.at(-1) === "/sync/marker") {
      // Not a socket of the app: see below.
      void socket.close();
      return;
    }
    socket.onMessage(() => {
      socket.send(
        JSON.stringify({
          type: "error",
          code: "version_mismatch",
          message: "The client and the server speak different versions",
          protocolVersion: 1000,
          schemaVersion: 1,
        }),
      );
      void socket.close({ code: 4400, reason: "version_mismatch" });
    });
  });
  await signIn(page, ownEmail);

  await expectSync(page, "Reload to update");
  // The app still takes work, and keeps it on the device.
  await writeDraft(page, isMobile, "Written in an old window");
  await expectSync(page, "Reload to update");
  await page
    .getByRole("button", { name: "Sync: Reload to update" })
    .filter({ visible: true })
    .first()
    .click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("2 changes are saved on this device");
  await expect(detail.getByRole("button", { name: "Reload" })).toBeVisible();
  // It does not connect again before it has updated itself, not even
  // when the browser says that the network is back, which makes a client
  // that is waiting to try again do so at once.
  //
  // A socket that the app opens is counted here only when the browser has
  // told the test of it, which is later. So the test opens a socket of its
  // own after the event, as a marker: the route hears of sockets in the
  // order in which the page opens them, and once it has heard of the
  // marker, it has heard of every socket that the event made the app open.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    new WebSocket(`${location.origin.replace(/^http/, "ws")}/sync/marker`);
  });
  await expect.poll(() => sockets.at(-1)).toBe("/sync/marker");
  // The socket that was refused, and the marker.
  expect(sockets).toHaveLength(2);
  await expectSync(page, "Reload to update");
});
