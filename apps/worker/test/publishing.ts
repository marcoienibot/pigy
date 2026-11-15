import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Fetch, Row } from "@pigy/core";
import { answerConsent } from "@pigy/simulators/world";
import { expect, onTestFinished, vi } from "vitest";
import { deliveryInstanceId } from "../src/publish/delivery.ts";
import { consentUrl, outcomeOf, pathOf } from "./channels.ts";
import {
  adminEmail,
  type Browser,
  realMastodonDomain,
  setup,
  signedIn,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import {
  newId,
  objectOf,
  type ReceivedPatch,
  type SyncClient,
  workspaceIds,
} from "./sync-client.ts";

/**
 * What the tests of publishing share: the steps that a person takes, and
 * ways to follow a delivery and to look at what it left behind.
 */

/**
 * Has the publishing workflows of the test run without waiting: a wait
 * that a workflow asks for is over at once. Returns the introspector of
 * `cloudflare:test`, which lists the runs that the test has started.
 *
 * A test of publishing calls this before anything is published. Without
 * it, a workflow that waits for a network does so in real time.
 */
export async function pipeline() {
  const workflows = await introspectWorkflow(env.PUBLISH);
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableSleeps();
  });
  onTestFinished(() => stopWatching(workflows));
  return workflows;
}

// The gates of the test that is running, by what opens each.
const gates = new Set<() => void>();

/**
 * Ends the introspection of the workflows of a test. The runs come to an
 * end first, which they do not while a request of theirs waits at a gate:
 * a test that fails before it opens its gate would never finish.
 */
export async function stopWatching(workflows: {
  dispose(): Promise<void>;
}): Promise<void> {
  for (const open of gates) open();
  gates.clear();
  await workflows.dispose();
}

/** A signed-in admin, their workspaces, and workflows that do not wait. */
export async function started(options: Parameters<typeof setup>[0] = {}) {
  const test = setup(options);
  const browser = await signedIn(test, { email: adminEmail });
  const workflows = await pipeline();
  return { test, browser, workflows, workspaces: await workspaceIds(browser) };
}

/**
 * Connects an account of what stands for the real networks to a live
 * workspace, and returns the ID of its channel: the account that `setup()`
 * has made, or one that the test has added to the world.
 */
export async function connectAccount(
  { network }: Pick<TestSetup, "network">,
  browser: Browser,
  workspaceId: string,
  account: { domain: string; accountId: string } = {
    domain: realMastodonDomain,
    accountId: network.account.id,
  },
): Promise<string> {
  const url = await consentUrl(browser, workspaceId, account.domain);
  const callback = await answerConsent(network.mastodon.fetch, url, {
    account: account.accountId,
  });
  const outcome = outcomeOf(await browser.fetch(pathOf(callback)));
  expect(outcome.connect).toBe("connected");
  if (!outcome.channel) throw new Error("The connection names no channel");
  return outcome.channel;
}

/**
 * A gate between the app and the networks, for `interceptNetwork` of
 * `setup()`: once it is closed, a request that `holds` picks out, given as
 * "METHOD address", waits at it until the test opens it. That makes a
 * moment last in which a delivery is in the middle of a step.
 *
 * The test and the request look at the gate from time to time, each on a
 * timer of its own. Neither wakes the other with a promise: the request is
 * made by a step of a workflow, which the runtime runs apart from the
 * test, and a promise that one of the two resolves for the other can leave
 * the other waiting for good.
 */
export function gate(holds: (request: string) => boolean) {
  const state = { closed: false, waiting: 0 };
  const open = () => {
    state.closed = false;
  };
  return {
    intercept:
      (network: Fetch): Fetch =>
      async (input, init) => {
        if (state.closed && holds(`${init?.method ?? "GET"} ${urlOf(input)}`)) {
          state.waiting++;
          while (state.closed) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          state.waiting--;
        }
        return network(input, init);
      },
    /** Holds the requests from now on. */
    close() {
      state.closed = true;
      gates.add(open);
    },
    /** Waits until a request waits at the gate. */
    async reached(): Promise<void> {
      await vi.waitFor(() => expect(state.waiting).toBeGreaterThan(0));
    },
    /** Lets through what waits, and everything after it. */
    open,
  };
}

/** The request that posts a status to the server of `setup()`. */
export const postStatus = `POST https://${realMastodonDomain}/api/v1/statuses`;

/**
 * For `interceptNetwork` of `setup()`: answers a request to post a status
 * in place of the network, while `on()` says so. `answer` gets the
 * network, to pass the request on if it wants it carried out.
 */
export function inPlaceOfPosting(
  on: () => boolean,
  answer: (
    network: Fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  return (network: Fetch): Fetch =>
    (input, init) =>
      `${init?.method ?? "GET"} ${urlOf(input)}` === postStatus && on()
        ? answer(network, input, init)
        : network(input, init);
}

/** A draft: its post, and its parts in order. */
export type Draft = { postId: string; partIds: string[] };

/**
 * Writes a draft with the given parts through `client`, which applies the
 * patch that confirms it.
 *
 * A draft gets its first part from `post.create`. No mutator adds another
 * until the thread editor of phase 4, so the parts after the first are
 * written into the database of the workspace as that mutator will write
 * them. Clients do not hear of them, and no test here needs them to.
 */
export async function writeDraft(
  client: SyncClient,
  workspaceId: string,
  ...texts: [string, ...string[]]
): Promise<Draft> {
  const [first, ...more] = texts;
  const postId = newId();
  const partIds = texts.map(() => newId());
  client.mutate("post.create", {
    id: postId,
    partId: partIds[0] ?? "",
    text: first,
  });
  await client.patch();
  await runInDurableObject(objectOf(workspaceId), (_, state) => {
    more.forEach((text, index) => {
      state.storage.sql.exec(
        "insert into post_part (id, post_id, position, text) values (?, ?, ?, ?)",
        partIds[index + 1],
        postId,
        index + 1,
        text,
      );
    });
  });
  return { postId, partIds };
}

/**
 * Chooses channels for a draft and asks for it to be published, as a
 * person does in the composer. Returns the IDs of the targets, in the
 * order of `channelIds`.
 */
export async function publishTo(
  client: SyncClient,
  postId: string,
  ...channelIds: string[]
): Promise<string[]> {
  const targetIds = channelIds.map(() => newId());
  client.send({
    type: "mutate",
    mutations: [
      ...channelIds.map((channelId, index) =>
        client.mutation("target.add", {
          id: targetIds[index] ?? "",
          postId,
          channelId,
        }),
      ),
      client.mutation("post.publish", { id: postId }),
    ],
  });
  const { rejected } = await client.patch();
  expect(rejected).toEqual([]);
  return targetIds;
}

/**
 * Applies the patches that `client` receives until `reached` says that its
 * copy is where the test wants it, and returns them. Fails if the server
 * stops sending before that.
 */
export async function follow(
  client: SyncClient,
  reached: () => boolean,
): Promise<ReceivedPatch[]> {
  const patches: ReceivedPatch[] = [];
  while (!reached()) patches.push(await client.patch());
  return patches;
}

/** The post with this ID as `client` has it. */
export function postOf(client: SyncClient, postId: string): Row<"post"> {
  const post = client.table("post").find(({ id }) => id === postId);
  if (!post) throw new Error(`The client has no post ${postId}`);
  return post;
}

/** The target with this ID as `client` has it. */
export function targetOf(
  client: SyncClient,
  targetId: string,
): Row<"post_target"> {
  const target = client.table("post_target").find(({ id }) => id === targetId);
  if (!target) throw new Error(`The client has no target ${targetId}`);
  return target;
}

/**
 * Asks for a delivery that failed to be tried again, as a person does, and
 * applies the patch that confirms it: the post is `sending` again.
 */
export async function retry(client: SyncClient, targetId: string) {
  client.mutate("target.retry", { id: targetId });
  const { rejected } = await client.patch();
  expect(rejected).toEqual([]);
}

/** Follows `client` until the post has left `sending`, and returns it. */
export async function ended(
  client: SyncClient,
  postId: string,
): Promise<Row<"post">> {
  await follow(client, () => postOf(client, postId).status !== "sending");
  return postOf(client, postId);
}

/**
 * What `client` has of the parts that a target has published: the ID of
 * each on the network, in the order of the parts of `draft`.
 */
export function publishedOf(
  client: SyncClient,
  targetId: string,
  draft: Draft,
): string[] {
  const results = client
    .table("target_part_result")
    .filter((result) => result.targetId === targetId);
  return draft.partIds.flatMap(
    (partId) =>
      results.find((result) => result.partId === partId)?.remoteId ?? [],
  );
}

/**
 * What a workspace keeps of its targets besides their rows: the progress
 * that the next attempt goes on from, as text.
 */
export function storedProgress(
  workspaceId: string,
): Promise<{ id: string; progress: string | null }[]> {
  return runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ id: string; progress: string | null }>(
        "select id, progress from post_target order by id",
      )
      .toArray(),
  );
}

/**
 * The ID of the run of the publishing workflow that carries the delivery
 * which a target is on, or was on last.
 */
export async function runIdOf(
  workspaceId: string,
  targetId: string,
): Promise<string> {
  const startedAt = await runInDurableObject(
    objectOf(workspaceId),
    (_, state) =>
      state.storage.sql
        .exec<{ started_at: number }>(
          "select started_at from post_target where id = ?",
          targetId,
        )
        .one().started_at,
  );
  return deliveryInstanceId({ workspaceId, targetId, startedAt });
}

/**
 * The run of the publishing workflow that carries the delivery which a
 * target is on, or was on last. Declare it with `using`: the runtime warns
 * about a handle that is left for it to collect.
 */
export async function runOf(workspaceId: string, targetId: string) {
  const run = await env.PUBLISH.get(await runIdOf(workspaceId, targetId));
  // What the handle has for letting go of it, if anything: the types of
  // the platform do not say.
  const dispose = (run as Partial<Disposable>)[Symbol.dispose]?.bind(run);
  return Object.assign(run, { [Symbol.dispose]: () => dispose?.() });
}

/**
 * How long the run of a target has waited, by the name of each wait, in
 * seconds: what it asked the platform for. The waits themselves are over
 * at once in a test, see `pipeline`.
 */
export async function waitsOf(
  workspaceId: string,
  targetId: string,
): Promise<Record<string, number>> {
  using run = await runOf(workspaceId, targetId);
  using events = await run.subscribe();
  const waits: Record<string, number> = {};
  for (;;) {
    // The events of a run that is over are all there. The pause is for a
    // platform that does not say that they have ended.
    const next = await Promise.race([
      events.next(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 250)),
    ]);
    if (!next || next.done) break;
    if (next.value.type === "sleep_started") {
      // The platform numbers the steps of one name: "wait-1" is "wait-1-1".
      const name = next.value.stepName.replace(/-\d+$/, "");
      waits[name] = next.value.durationMs / 1000;
    }
  }
  return waits;
}
