import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * What the tests of a sandbox share: the API as a page of the app calls
 * it, connecting a simulated account, and publishing without a screen.
 */

// The simulated Mastodon server that every sandbox starts with:
// `sandboxMastodonDomain` in packages/core/src/sandbox.ts. Its accounts are
// in apps/worker/src/sim/object.ts.
export const sandboxServer = "mastodon.example";

/** Calls the API from `page`, as the app does, and returns the answer. */
export function api(page: Page, method: string, path: string, json?: unknown) {
  return page.evaluate(
    async ({ method, path, json }) => {
      const response = await fetch(path, {
        method,
        ...(json !== undefined && {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(json),
        }),
      });
      // An answer without content has no JSON to read.
      const body = response.status === 204 ? null : await response.json();
      return { status: response.status, body };
    },
    { method, path, json },
  );
}

/** The IDs of the workspaces of whoever is signed in on `page`. */
export async function workspacesOf(
  page: Page,
): Promise<{ live: string; sandbox: string }> {
  const { body } = await api(page, "GET", "/api/workspaces");
  const id = (environment: string): string =>
    body.workspaces.find(
      (workspace: { environment: string }) =>
        workspace.environment === environment,
    ).id;
  return { live: id("live"), sandbox: id("sandbox") };
}

/** Begins to connect a Mastodon account, and goes where the app says. */
export async function openConsentPage(page: Page, workspaceId: string) {
  const start = await api(
    page,
    "POST",
    `/api/workspaces/${workspaceId}/connect`,
    { network: "mastodon", identifier: sandboxServer },
  );
  expect(start.status).toBe(200);
  await page.goto(start.body.url);
}

/**
 * Connects the simulated account `handle` to a sandbox, through its
 * consent page, and returns the ID of the channel.
 */
export async function connectInSandbox(
  page: Page,
  workspaceId: string,
  handle: string,
): Promise<string> {
  await openConsentPage(page, workspaceId);
  await page.getByRole("button", { name: handle }).click();
  await page.waitForURL((url) => url.pathname === "/channels");
  const outcome = new URL(page.url()).searchParams;
  expect(outcome.get("connect")).toBe("connected");
  const channel = outcome.get("channel");
  if (!channel) throw new Error("The connection names no channel");
  return channel;
}

/** What a client of the sync protocol holds of a published post. */
export type Published = {
  post: { id: string; status: string };
  targets: { id: string; status: string; error: string | null }[];
  results: { targetId: string; remoteId: string; url: string | null }[];
};

/**
 * Writes a post with `text` and publishes it to a channel, as a client of
 * the sync protocol and without the screens, which `publishDraft` of
 * app.ts goes through. It returns what the client holds of the post once
 * the post has left `sending`.
 *
 * The client is written from SYNC.md, in the page, where it has the
 * session of whoever is signed in. It is the one that AGENTS.md gives for
 * publishing by hand, so this is also the test of those instructions.
 */
export function publishNow(
  page: Page,
  workspaceId: string,
  channelId: string,
  text: string,
): Promise<Published> {
  return page.evaluate(
    ({ workspaceId, channelId, text }) =>
      new Promise<Published>((resolve, reject) => {
        // A UUID version 7, which is what the ID of a row has to be.
        const id = () => {
          const time = Date.now().toString(16).padStart(12, "0");
          const random = crypto.randomUUID().replaceAll("-", "");
          return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 18)}`;
        };
        const [postId, partId, targetId] = [id(), id(), id()];
        const rows: Record<string, Map<string, { id: string }>> = {};
        const socket = new WebSocket(
          `${location.origin.replace(/^http/, "ws")}/sync/${workspaceId}`,
        );
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "hello",
              // The versions in packages/core/src/sync/protocol.ts.
              protocolVersion: 2,
              schemaVersion: 6,
              clientId: id(),
              cursor: null,
              lastMutationId: 0,
            }),
          );
        let asked = false;
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type !== "patch") {
            reject(new Error(`The server said ${event.data}`));
            return;
          }
          for (const change of message.changes) {
            rows[change.table] ??= new Map();
            if (change.op === "put") {
              rows[change.table]?.set(change.row.id, change.row);
            } else rows[change.table]?.delete(change.id);
          }
          if (message.rejected.length > 0) {
            reject(new Error(`Rejected: ${JSON.stringify(message.rejected)}`));
            return;
          }
          if (!asked) {
            // The answer to the hello: the client is up to date. Now the
            // draft, where it goes, and the request to publish it.
            asked = true;
            socket.send(
              JSON.stringify({
                type: "mutate",
                mutations: [
                  {
                    id: 1,
                    name: "post.create",
                    args: { id: postId, partId, text },
                  },
                  {
                    id: 2,
                    name: "target.add",
                    args: { id: targetId, postId, channelId },
                  },
                  { id: 3, name: "post.publish", args: { id: postId } },
                ],
              }),
            );
            return;
          }
          const post = rows.post?.get(postId) as Published["post"] | undefined;
          if (!post || post.status === "sending") return;
          const ofPost = <Row>(table: string, own: (row: Row) => boolean) =>
            [...(rows[table]?.values() ?? [])].filter((row) =>
              own(row as unknown as Row),
            ) as unknown as Row[];
          resolve({
            post,
            targets: ofPost<Published["targets"][number] & { postId: string }>(
              "post_target",
              (target) => target.postId === postId,
            ),
            results: ofPost<Published["results"][number]>(
              "target_part_result",
              (result) => result.targetId === targetId,
            ),
          });
          socket.close();
        };
        socket.onclose = ({ code }) =>
          reject(new Error(`The socket was closed with ${code}`));
      }),
    { workspaceId, channelId, text },
  );
}
