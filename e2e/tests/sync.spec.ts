import { expect, test } from "../fixtures.ts";

// What is said over the socket is tested in apps/worker. This is about the
// way there, in a real browser and a built app: the address reaches the
// Worker and not the app shell, the handshake gets through with the cookie
// and the Origin that a browser sends, and the workspace starts in the
// build, which has to contain the migrations of its database.
test("a page of the app can open the socket of its workspace", async ({
  signedInPage,
}) => {
  const answer = await signedInPage.evaluate(async () => {
    const response = await fetch("/api/workspaces");
    const { workspaces } = await response.json();
    const socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}/sync/${workspaces[0].id}`,
    );
    return new Promise((resolve, reject) => {
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            // The versions in packages/core/src/sync/protocol.ts. If this
            // test is answered with "version_mismatch", they have changed.
            protocolVersion: 2,
            schemaVersion: 10,
            // A client of its own, with an ID in the form of a UUIDv7. The
            // test runs in two projects at once, and with the same ID the
            // hello of one would close the socket of the other.
            clientId: `01932c07-0000-7000-8000-${crypto.randomUUID().slice(-12)}`,
            cursor: null,
            lastMutationId: 0,
          }),
        );
      socket.onmessage = (event) => {
        resolve(JSON.parse(event.data));
        socket.close();
      };
      socket.onclose = ({ code }) =>
        reject(new Error(`The socket was closed with ${code}`));
    });
  });

  // A snapshot, as for every client that has nothing yet. What is in it
  // depends on the other tests, which share the workspace of the admin.
  expect(answer).toMatchObject({ type: "patch", from: null });
});
