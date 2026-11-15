import { expect, test } from "../fixtures.ts";
import {
  api,
  connectInSandbox,
  publishNow,
  sandboxServer,
  workspacesOf,
} from "../sandbox.ts";

const handle = `@ada@${sandboxServer}`;

// The Worker tests cover the publishing pipeline, in the runtime and with
// the engine of the tests. This is about what they cannot show: that the
// Worker as it is built and served has the workflow, bound and exported,
// and that the Durable Object of a workspace, its alarm, the workflow and
// the simulated world of a sandbox work together there. There is no screen
// for publishing yet, so the test speaks the sync protocol itself.
//
// `ownPage` is somebody who is invited for this test alone: every sandbox
// has the same simulated accounts, and the tests of both projects run at
// once.
test("a post that is published in a sandbox arrives in its simulated world", async ({
  ownPage: page,
}) => {
  const { sandbox } = await workspacesOf(page);
  const channel = await connectInSandbox(page, sandbox, handle);
  const text = "Published by the built Worker";

  const published = await publishNow(page, sandbox, channel, text);

  expect(published.post.status).toBe("sent");
  expect(published.targets).toMatchObject([{ status: "sent", error: null }]);
  // The post is in the feed of the account that it went to, under the ID
  // that the result of its target has.
  const feed = await api(page, "GET", "/api/sandbox/feed");
  expect(feed.status).toBe(200);
  const account = feed.body.accounts.find(
    (candidate: { handle: string }) => candidate.handle === handle,
  );
  expect(account.posts).toMatchObject([
    { id: published.results[0]?.remoteId, text, replies: [] },
  ]);
  // A simulated post has no address that a browser could open.
  expect(published.results).toMatchObject([{ url: null }]);
});
