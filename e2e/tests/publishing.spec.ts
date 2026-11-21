import {
  armFault,
  backToList,
  channelChoice,
  channelRows,
  connectionOf,
  connectSimulated,
  connectSimulatedLinkedIn,
  deliveryTo,
  draftRow,
  editor,
  expectSync,
  expectWorkspace,
  feedOf,
  grace,
  graceOnLinkedIn,
  openScreen,
  overflowOf,
  publishDraft,
  publishPanel,
  sandboxServer,
  sentPost,
  workspaceSwitch,
  writeDraft,
} from "../app.ts";
import { expect, type Page, signIn, test } from "../fixtures.ts";

// Publishing from the app: the editor of a draft chooses where it goes and
// publishes it, the Sent screen follows each delivery, and the simulator of
// the sandbox shows where a post went and makes the next one fail.
//
// Every sandbox has the same simulated accounts and the tests run at the
// same time, so each test is somebody of its own, in a sandbox of their
// own: `ownPage`. The Worker tests cover what the pipeline does on every
// path. These are about what a person sees of it, with the built Worker
// behind the page.

/** The heading of the screen that the page shows. */
function heading(page: Page) {
  return page.getByRole("heading", { level: 1 });
}

/** The notices of the app, which the notice library lists. */
function notice(page: Page, text: string) {
  return page.getByRole("listitem").filter({ hasText: text });
}

test("a draft goes out to a simulated account, shows on Sent with where it went, and is in the feed of the account", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  const text = "Hello from the composer";

  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  const publish = publishPanel(page).getByRole("button", {
    name: "Publish now",
  });
  // Nothing is chosen yet, and the editor says what is missing.
  await expect(publish).toBeDisabled();
  await expect(publishPanel(page).getByRole("status")).toHaveText(
    "Choose where to publish.",
  );
  await channelChoice(page, grace).click();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await publish.click();

  // The draft has gone out of the drafts, and a notice leads to it.
  await expect(editor(page)).toHaveCount(0);
  await expect(draftRow(page, text)).toHaveCount(0);
  await notice(page, `Publishing to ${grace}`)
    .getByRole("button", { name: "View" })
    .click();

  await expect(heading(page)).toHaveText("Sent");
  const post = sentPost(page, text);
  // The post that the notice named is the one that the keyboard is on.
  await expect(post).toBeFocused();
  const delivery = deliveryTo(post, grace);
  // As the server reports it: waiting, sending, then sent.
  await expect(delivery).toContainText("Sent");
  // Whenever that was: the delivery can take more than a minute on a
  // machine under load.
  await expect(post).toContainText(/Published (just now|\d+m ago)/);
  expect(await overflowOf(page)).toBe(0);

  // A simulated post has no address that a browser could open: the link
  // leads to it in the feed of the account, which shows it as the one
  // that was asked for.
  await delivery
    .getByRole("link", { name: "See it in the simulated feed" })
    .click();
  await expect(heading(page)).toHaveText("Simulator");
  const published = feedOf(page, grace)
    .getByRole("article")
    .filter({ hasText: text });
  await expect(published).toHaveAttribute("aria-current", "true");
  await expect(published).toBeFocused();
  expect(await overflowOf(page)).toBe(0);
});

test("the editor leads to connecting an account, and does not publish what a chosen account would refuse", async ({
  ownPage: page,
  isMobile,
}) => {
  // One character over the 500 of the simulated server.
  const tooLong = `${"Long ".repeat(100)}!`;
  await writeDraft(page, isMobile, tooLong);
  await draftRow(page, "Long Long").click();

  // Without an account, the editor leads to connecting one, with the
  // form of the simulated server open.
  await publishPanel(page)
    .getByRole("link", { name: "Connect a simulated account" })
    .click();
  await page
    .getByRole("dialog", { name: "Connect a Mastodon account" })
    .getByRole("button", { name: "Continue to Mastodon" })
    .click();
  await page.getByRole("button", { name: grace }).click();
  await expect(channelRows(page).filter({ hasText: grace })).toBeVisible();

  await openScreen(page, "Drafts");
  await draftRow(page, "Long Long").click();
  await channelChoice(page, grace).click();
  // Counted the way Mastodon counts, against the limits that the server
  // gave the account, and said next to the choice.
  await expect(publishPanel(page)).toContainText(
    `Mastodon would refuse this for ${grace}: The post is 501 characters long. The limit is 500.`,
  );
  const publish = publishPanel(page).getByRole("button", {
    name: "Publish now",
  });
  await expect(publish).toBeDisabled();

  // One character less, and the post can go: with the keys, from the text.
  await editor(page).press("End");
  await editor(page).press("Backspace");
  await expect(publish).toBeEnabled();
  await editor(page).press("ControlOrMeta+Enter");
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Sent");
  await expect(deliveryTo(sentPost(page, "Long Long"), grace)).toContainText(
    "Sent",
  );
});

test("⌘↵ in a menu is the menu's: it does not publish the draft that is open behind it", async ({
  ownPage: page,
  isMobile,
}) => {
  // On a phone the editor of a draft is over the header, where the switch
  // is: no menu can be opened over a draft there.
  test.skip(isMobile, "On a phone no menu is reached with a draft open");
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Not yet");
  await channelChoice(page, grace).click();
  // The draft could go out: the keys would publish it from the text.
  await expect(
    publishPanel(page).getByRole("button", { name: "Publish now" }),
  ).toBeEnabled();

  await workspaceSwitch(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // The option of the workspace that is shown: choosing it changes nothing.
  await menu
    .getByRole("menuitemradio", { name: /^Sandbox/ })
    .press("ControlOrMeta+Enter");
  // The menu takes the keys for a click on its option, and closes. No key
  // is pressed to close it: the focus goes back to the page a moment
  // after, and a key would then be the page's, where Escape closes the
  // draft.
  await expect(menu).toBeHidden();
  await expectWorkspace(page, "Sandbox");

  // The draft is still a draft, and nothing was published. That is read
  // from the list and from Sent, not from the editor: whether the draft
  // is still open is the menu's business, and would not be if the option
  // were the other workspace's.
  await expect(notice(page, "Publishing to")).toHaveCount(0);
  await expect(draftRow(page, "Not yet")).toBeVisible();
  await openScreen(page, "Sent");
  await expect(page.getByText("Nothing sent yet")).toBeVisible();
});

test("a draft that is deleted comes back with the accounts that it was to go to, by the notice and by the keys", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Going to Grace");
  await channelChoice(page, grace).click();
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(draftRow(page, "Going to Grace")).toHaveCount(0);
  await notice(page, "Draft deleted")
    .getByRole("button", { name: "Undo" })
    .click();
  // A new draft with the text, which goes where the deleted one went.
  await expect(editor(page)).toHaveValue("Going to Grace");
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // And the same with the keys, which are not for the text of a draft:
  // from the list.
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(draftRow(page, "Going to Grace")).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor(page)).toHaveValue("Going to Grace");
  await expect(channelChoice(page, grace)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await backToList(page, isMobile);
  await expect(draftRow(page, "Going to Grace")).toHaveCount(1);
});

test("a fault that is for good fails the post and the account, which goes out once it is connected again and tried again", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await armFault(page, "Mastodon", "Access taken back");

  await openScreen(page, "Drafts");
  await publishDraft(page, "Locked out", grace);
  await openScreen(page, "Sent");
  const delivery = deliveryTo(sentPost(page, "Locked out"), grace);
  await expect(delivery).toContainText("Failed");
  await expect(delivery).toContainText(
    `${sandboxServer} no longer accepts the access that pigy was given to this account.`,
  );
  // It would fail again at once: what is offered is to connect again.
  await expect(delivery.getByRole("button", { name: /^Retry/ })).toHaveCount(0);

  // The fault has struck, and is armed no more. The feed says of the
  // account what the list of channels says.
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace)).toContainText("Needs reconnecting");
  await page.getByRole("link", { name: "Failures" }).click();
  await expect(page.getByText("Nothing is armed")).toBeVisible();
  // The account says so where it is listed, and where it is chosen.
  await openScreen(page, "Channels");
  await expect(channelRows(page).filter({ hasText: grace })).toContainText(
    "Needs reconnecting",
  );
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Next");
  await expect(channelChoice(page, grace)).toBeDisabled();
  await expect(publishPanel(page)).toContainText(
    `${grace} has to be connected again before pigy can post to it.`,
  );
  await backToList(page, isMobile);

  // From the failed delivery to connecting the account again, and back.
  await openScreen(page, "Sent");
  await delivery.getByRole("link", { name: `Reconnect ${grace}` }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue to Mastodon" })
    .click();
  await page.getByRole("button", { name: grace }).click();
  await expect(channelRows(page).filter({ hasText: grace })).toContainText(
    "Connected",
  );
  await openScreen(page, "Sent");
  await delivery.getByRole("button", { name: `Retry ${grace}` }).click();
  await expect(delivery).toContainText("Sent");

  // Posted once: the request that was refused posted nothing.
  await delivery
    .getByRole("link", { name: "See it in the simulated feed" })
    .click();
  await expect(
    feedOf(page, grace).getByRole("article").filter({ hasText: "Locked out" }),
  ).toHaveCount(1);
});

test("a lost answer makes pigy wait as long as it would for real, and then find the post instead of posting it twice", async ({
  ownPage: page,
}) => {
  // The workflow waits a minute before it looks: the server's clock, which
  // the test cannot move. This is the one test that waits it out, because
  // it is what only the built Worker shows: that the wait of a workflow
  // ends in the runtime as it is deployed, and the delivery goes on.
  test.setTimeout(180_000);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await armFault(page, "Mastodon", "Lost answer");
  // The panel says what is about to happen.
  await expect(page.getByText("a minute at least")).toBeVisible();

  await openScreen(page, "Drafts");
  await publishDraft(page, "Answer lost", grace);
  await openScreen(page, "Sent");
  const delivery = deliveryTo(sentPost(page, "Answer lost"), grace);
  await expect(delivery).toContainText("Sending");

  // The network did what it was asked: the post is there, though pigy
  // has not heard so.
  await openScreen(page, "Simulator");
  const posted = feedOf(page, grace)
    .getByRole("article")
    .filter({ hasText: "Answer lost" });
  // Nobody refreshes: nothing of the workspace changes when the answer is
  // lost, so the feeds look by themselves while a delivery is under way.
  await expect(posted).toHaveCount(1, { timeout: 15_000 });

  await openScreen(page, "Sent");
  await expect(delivery).toContainText("Sending");
  // A minute from the lost answer, and some time to look.
  await expect(delivery).toContainText("Sent", { timeout: 120_000 });
  await openScreen(page, "Simulator");
  await expect(posted).toHaveCount(1);
});

test("a post that is published offline goes out when the device is back, and says so meanwhile", async ({
  page,
  ownEmail,
}) => {
  const connection = await connectionOf(page);
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Written on a train");
  await channelChoice(page, grace).click();

  await connection.cut();
  // With the count of what waits to be sent, which can be the choice.
  await expectSync(page, /Offline/);
  await expect(publishPanel(page).getByRole("status")).toHaveText(
    "You are offline. What you publish now goes out when this device is back online.",
  );
  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  await expect(
    notice(page, `Publishing to ${grace} when this device is back online`),
  ).toBeVisible();

  await openScreen(page, "Sent");
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "You are offline.",
  );
  const post = sentPost(page, "Written on a train");
  await expect(deliveryTo(post, grace)).toContainText("Waiting");
  // A post that is on its way cannot be deleted: the server would refuse.
  await expect(post.getByRole("button", { name: "Delete post" })).toHaveCount(
    0,
  );

  await connection.restore();
  await expect(deliveryTo(post, grace)).toContainText("Sent");

  // Once it has gone out, pigy can forget it, here with the keys: ↓ goes
  // to the post and ⌫ asks to delete it. The network keeps it.
  await expect(post.getByRole("button", { name: "Delete post" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(post).toBeFocused();
  await page.keyboard.press("Backspace");
  const question = page.getByRole("alertdialog");
  await expect(question).toContainText("What it published stays");
  await question.getByRole("button", { name: "Delete" }).click();
  await expect(post).toHaveCount(0);
  await expect(page.getByText("Nothing sent yet")).toBeVisible();
  await openScreen(page, "Simulator");
  await expect(
    feedOf(page, grace)
      .getByRole("article")
      .filter({ hasText: "Written on a train" }),
  ).toHaveCount(1);
});

test("a delivery whose end nobody knows asks the person to look at the account before trying again", async ({
  page,
  ownEmail,
}) => {
  // The simulated Mastodon never leaves a delivery uncertain: the pipeline
  // does when a run stops without a word, which the Worker tests cover. So
  // the test changes what the server says about the delivery on its way
  // to the page.
  await page.routeWebSocket(/\/sync\//, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message);
      const patch = JSON.parse(message);
      for (const change of patch.changes ?? []) {
        if (change.op !== "put") continue;
        if (change.table === "post_target" && change.row.status === "sent") {
          Object.assign(change.row, {
            status: "uncertain",
            error: "pigy lost track of this delivery.",
            sentAt: null,
          });
        }
        if (change.table === "post" && change.row.status === "sent") {
          change.row.status = "error";
        }
      }
      socket.send(JSON.stringify(patch));
    });
  });
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await publishDraft(page, "Maybe there", grace);

  await openScreen(page, "Sent");
  const delivery = deliveryTo(sentPost(page, "Maybe there"), grace);
  await expect(delivery).toContainText("Unknown");
  await expect(delivery).toContainText(
    "Look at the account first: if the post is there, do not try again",
  );
  await expect(
    delivery.getByRole("button", { name: `Retry ${grace}` }),
  ).toBeVisible();

  // The account is a link away: its feed, brought into view.
  await delivery
    .getByRole("link", { name: `Look at ${grace} in the simulated feed` })
    .click();
  await expect(feedOf(page, grace)).toHaveAttribute("aria-current", "true");
  await expect(feedOf(page, grace)).toBeFocused();
  await expect(feedOf(page, grace)).toContainText("Maybe there");
});

test("a post goes out to a simulated LinkedIn account, and one whose answer is lost is unknown at once: pigy cannot look there, and takes the post that LinkedIn names when it is tried again", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulatedLinkedIn(page, graceOnLinkedIn);
  await openScreen(page, "Drafts");
  await publishDraft(page, "Hello LinkedIn (from pigy)", graceOnLinkedIn);

  await openScreen(page, "Sent");
  const sent = deliveryTo(
    sentPost(page, "Hello LinkedIn (from pigy)"),
    graceOnLinkedIn,
  );
  await expect(sent).toContainText("Sent");
  await sent
    .getByRole("link", { name: "See it in the simulated feed" })
    .click();
  // As it was written, with the characters that LinkedIn reserves.
  await expect(feedOf(page, graceOnLinkedIn)).toContainText(
    "Hello LinkedIn (from pigy)",
  );

  // The panel says what this fault does on LinkedIn, which is not what it
  // does on a network where pigy can look, and that nothing waits.
  await page.getByRole("link", { name: "Failures" }).click();
  await page.getByRole("radio", { name: "LinkedIn" }).check();
  await expect(
    page.getByRole("radio", { name: "Lost answer", exact: true }),
  ).toHaveAccessibleDescription(
    /the post is there and pigy cannot know: it does not try again, and asks you to look/,
  );
  await armFault(page, "LinkedIn", "Lost answer");
  await expect(page.getByText("pigy waits as long as it would")).toHaveCount(0);

  await openScreen(page, "Drafts");
  await publishDraft(page, "Did it arrive", graceOnLinkedIn);
  await openScreen(page, "Sent");
  const unknown = deliveryTo(sentPost(page, "Did it arrive"), graceOnLinkedIn);
  // At once: no wait of a minute, as for a network that is tried again.
  // The workflow still takes its steps, which a machine under load is
  // slow at.
  await expect(unknown).toContainText("Unknown", { timeout: 20_000 });
  await expect(unknown).toContainText(
    "LinkedIn did not answer, so pigy cannot tell whether the post is on LinkedIn",
  );
  await expect(unknown).toContainText("LinkedIn gives it no way to look");

  // The person looks: the post is there.
  await unknown
    .getByRole("link", {
      name: `Look at ${graceOnLinkedIn} in the simulated feed`,
    })
    .click();
  const arrived = feedOf(page, graceOnLinkedIn)
    .getByRole("article")
    .filter({ hasText: "Did it arrive" });
  await expect(arrived).toHaveCount(1);

  // They try again all the same, within the minutes in which LinkedIn
  // refuses the same text and names the post that it has. That post is
  // the delivery's then, and there is no second one.
  await openScreen(page, "Sent");
  await unknown
    .getByRole("button", { name: `Retry ${graceOnLinkedIn}` })
    .click();
  await expect(unknown).toContainText("Sent", { timeout: 20_000 });
  await unknown
    .getByRole("link", { name: "See it in the simulated feed" })
    .click();
  await expect(arrived).toHaveCount(1);
});
