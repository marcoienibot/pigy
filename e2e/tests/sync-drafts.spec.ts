import {
  backToList,
  breakStorage,
  connectionOf,
  draftRow,
  draftRows,
  editor,
  expectSync,
  localData,
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

  // Edited here, offline, and deleted there in the meantime.
  await connection.cut();
  await draftRow(page, "Doomed draft").click();
  await editor(page).fill("Edited after it was deleted elsewhere");
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
  await expect(editor(page)).toHaveValue(
    "Edited after it was deleted elsewhere",
  );
  await expect(notice).toHaveCount(0);
  await expect(draftRow(other, "Edited after it was deleted")).toBeVisible();
  await page.reload();
  await expect(editor(page)).toHaveValue(
    "Edited after it was deleted elsewhere",
  );
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

  // Typed here while the connection is down, and changed there.
  await connection.cut();
  await editor(page).fill("What I am typing right now");
  await editor(other).fill("Changed on the other device");
  await expectSync(other, "Synced");
  await connection.restore();

  // The change from the other device arrives first and does not replace
  // the text under the cursor. Then this device's text is the later one.
  await expectSync(page, "Synced");
  await expect(editor(page)).toHaveValue("What I am typing right now");
  await expect(editor(other)).toHaveValue("What I am typing right now");
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
  await editor(page).fill("Written with no room left");

  // The connection is fine, and that is not what the indicator is about
  // now: the change is in this window and nowhere else.
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
  await connection.cut({ api: true });
  await writeDraft(page, isMobile, "Written before the session ended");
  await expectSync(page, "Offline · 2 changes");

  // The session ends without the app having a say, as when it runs out:
  // this request is not the app's.
  const signOut = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);
  // The next step in the app finds out.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Queue" })
    .click();

  await expect(page).toHaveURL("/sign-in?returnTo=%2Fqueue");
  await expect(page.getByRole("main")).toContainText(
    `2 changes made on this device as ${ownEmail} could be synced`,
  );
  // The copy is kept for that, and nothing of it is shown.
  expect((await localData(page)).copies).toHaveLength(1);

  // The same person signs in again, and the change is sent.
  await connection.restore();
  await signIn(page, ownEmail);
  await expect(page).toHaveURL("/queue");
  await expectSync(page, "Synced");
  const other = await otherDevice();
  await expect(
    draftRow(other, "Written before the session ended"),
  ).toBeVisible();
});

test("changes that were kept after a session ended can be deleted", async ({
  ownPage: page,
  isMobile,
  baseURL,
}) => {
  const connection = await connectionOf(page);
  await page.reload();
  await expectSync(page, "Synced");
  await connection.cut({ api: true });
  await writeDraft(page, isMobile, "Not worth keeping");
  await expectSync(page, "Offline · 2 changes");
  const signOut = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: new URL(baseURL ?? "").origin },
  });
  expect(signOut.status()).toBe(204);

  // Straight to the sign-in page, as somebody else would who wants to use
  // this device.
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Delete these changes" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete 2 changes?");
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByText("could be synced")).toHaveCount(0);
  expect(await localData(page)).toEqual({ copies: [], session: null });
});

test("a window that is too old for the server says that it has to be reloaded", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  // The server of this test is the same version as the app, so the test
  // answers the hello in its place, as a server would that speaks a later
  // version of the protocol: with an error and the code 4400.
  let sockets = 0;
  await page.routeWebSocket(/\/sync\//, (socket) => {
    sockets += 1;
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
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectSync(page, "Reload to update");
  expect(sockets).toBe(1);
});
