import { expect, test } from "../fixtures.ts";
import { api, workspacesOf } from "../sandbox.ts";

// Connecting an account as a person does it, through the Channels screen
// and the consent page of a simulated network, is in channels.spec.ts.
// This is about the one thing that those tests cannot show from a sandbox.
test("the Worker of this build reaches no real host, not even for a live workspace", async ({
  signedInPage: page,
}) => {
  const { live } = await workspacesOf(page);

  // A live workspace talks to the real networks. The host is under the
  // reserved ".invalid" domain: if the guard is ever lost, the request
  // still reaches nobody.
  const start = await api(page, "POST", `/api/workspaces/${live}/connect`, {
    network: "mastodon",
    identifier: "mastodon.example.invalid",
  });

  // "HTTP 502" is the answer of the guard in apps/worker/src/outbound.ts,
  // which this build has in place of the runtime's `fetch`. A request that
  // had left the Worker would have found no such host, and the message
  // would say that the server could not be reached.
  expect(start).toEqual({
    status: 502,
    body: {
      error: "UnexpectedError",
      message: "mastodon.example.invalid is having trouble (HTTP 502).",
    },
  });
});
