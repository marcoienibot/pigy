import { expect, type Page, signIn, test, uniqueEmail } from "../fixtures.ts";
import {
  api,
  openConsentPage,
  sandboxServer,
  workspacesOf,
} from "../sandbox.ts";

const server = sandboxServer;
const handle = `@grace@${server}`;

/** The channels of a workspace, as its sync socket sends them to a new client. */
function channelsOf(page: Page, workspaceId: string) {
  return page.evaluate(
    (workspaceId) =>
      new Promise<{ id: string; handle: string; status: string }[]>(
        (resolve, reject) => {
          const socket = new WebSocket(
            `${location.origin.replace(/^http/, "ws")}/sync/${workspaceId}`,
          );
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                type: "hello",
                // The versions in packages/core/src/sync/protocol.ts.
                protocolVersion: 2,
                schemaVersion: 3,
                clientId: `01932c07-0000-7000-8000-${crypto.randomUUID().slice(-12)}`,
                cursor: null,
                lastMutationId: 0,
              }),
            );
          socket.onmessage = (event) => {
            const { changes } = JSON.parse(event.data);
            resolve(
              changes
                .filter(
                  (change: { op: string; table: string }) =>
                    change.op === "put" && change.table === "channel",
                )
                .map((change: { row: unknown }) => change.row),
            );
            socket.close();
          };
          socket.onclose = ({ code }) =>
            reject(new Error(`The socket was closed with ${code}`));
        },
      ),
    workspaceId,
  );
}

// Every sandbox has the same simulated accounts, and the tests of both
// projects run at once. So each test connects as a person of its own, in a
// sandbox of their own, and leaves the admin's alone.
const personTest = test.extend<{ person: Page }>({
  person: async ({ signedInPage: admin, newPerson }, use, testInfo) => {
    const email = uniqueEmail(testInfo, "connect");
    const invited = await api(admin, "POST", "/api/admin/allowed-emails", {
      email,
      role: "member",
    });
    expect(invited.status).toBe(204);
    const page = await newPerson();
    await signIn(page, email);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await use(page);
  },
});

// The Worker tests cover what the routes do. This is about what only a
// browser shows: that the consent page is one a person can use, that the
// redirects from the app to the simulated network and back hold together
// with the cookie and the Origin that a browser sends, and that none of
// them leads to another host, which the fixture would fail the test for.
personTest(
  "a person connects a simulated account in their sandbox and disconnects it",
  async ({ person: page }) => {
    const { sandbox } = await workspacesOf(page);

    await openConsentPage(page, sandbox);

    // A page of the app itself, which says what it is.
    expect(new URL(page.url()).pathname).toBe(
      `/sim/network/${server}/oauth/authorize`,
    );
    await expect(page.getByText("Simulation", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "pigy wants to use your account" }),
    ).toBeVisible();
    // It has to fit the screen, on a phone too.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    await page.getByRole("button", { name: handle }).click();

    // Back in the app, on the screen of the channels, with the outcome in
    // the address for that screen to show.
    await page.waitForURL((url) => url.pathname === "/channels");
    const outcome = new URL(page.url()).searchParams;
    expect(outcome.get("connect")).toBe("connected");
    expect(outcome.get("network")).toBe("mastodon");
    expect(outcome.get("workspace")).toBe(sandbox);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Channels",
    );
    const channels = await channelsOf(page, sandbox);
    expect(channels).toMatchObject([
      { id: outcome.get("channel"), handle, status: "connected" },
    ]);

    const removed = await api(
      page,
      "DELETE",
      `/api/workspaces/${sandbox}/channels/${channels[0]?.id}`,
    );

    // The simulated server took the access back.
    expect(removed).toEqual({ status: 200, body: { revoked: true } });
    expect(await channelsOf(page, sandbox)).toEqual([]);
  },
);

personTest(
  "a person who cancels on the consent page is back in the app with nothing connected",
  async ({ person: page }) => {
    const { sandbox } = await workspacesOf(page);
    await openConsentPage(page, sandbox);

    await page.getByRole("button", { name: "Cancel" }).click();

    await page.waitForURL((url) => url.pathname === "/channels");
    expect(new URL(page.url()).searchParams.get("connect")).toBe("cancelled");
    expect(await channelsOf(page, sandbox)).toEqual([]);
  },
);

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
