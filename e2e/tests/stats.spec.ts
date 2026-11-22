import {
  channelChoice,
  connectSimulated,
  connectSimulatedLinkedIn,
  deliveryTo,
  editor,
  grace,
  graceOnLinkedIn,
  openScreen,
  overflowOf,
  publishPanel,
  sentPost,
} from "../app.ts";
import { expect, test } from "../fixtures.ts";

// The stats of what was published, on the Sent screen. The server reads
// them by itself, at once when a delivery has been sent and then ten
// minutes, an hour and so on after, from the simulated world of the
// sandbox, whose audience likes a post as time goes by, from the first
// minutes. The clock of the server
// cannot be moved here, so what is shown is the first read, a moment
// after the post went out, when nobody has seen it yet: the later reads,
// and the counts that they find, are tested in
// apps/worker/test/stats.test.ts, where the clock moves.

test("a delivery that is sent shows its stats a moment later, and one to LinkedIn says that it has none", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await connectSimulatedLinkedIn(page, graceOnLinkedIn);
  await openScreen(page, "Drafts");
  const text = "A post to count";
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  await channelChoice(page, grace).click();
  await channelChoice(page, graceOnLinkedIn).click();
  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Sent");
  const post = sentPost(page, text);
  const mastodon = deliveryTo(post, grace);
  await expect(mastodon).toContainText("Sent");
  // What the simulated Mastodon counts, each in words for whoever does
  // not see its icon: no views, which Mastodon does not count, and boosts
  // for what the other networks call reposts.
  const stats = mastodon.getByRole("list", { name: "Stats" });
  await expect(stats.getByRole("listitem")).toHaveCount(4);
  for (const label of ["0 likes", "0 boosts", "0 replies", "0 quotes"]) {
    await expect(stats.getByTitle(label)).toBeVisible();
  }
  await expect(mastodon).toContainText(/Counted (just now|\dm ago)/);

  // LinkedIn is never asked: it gives pigy no stats of a member's posts.
  const linkedin = deliveryTo(post, graceOnLinkedIn);
  await expect(linkedin).toContainText("Sent");
  await expect(linkedin).toContainText("Stats unavailable");
  await expect(linkedin).toContainText(
    "LinkedIn does not give pigy the stats of its posts.",
  );
  await expect(linkedin.getByRole("list", { name: "Stats" })).toHaveCount(0);
  // On one line of a phone too.
  expect(await overflowOf(page)).toBe(0);
});
