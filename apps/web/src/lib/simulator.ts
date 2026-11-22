import type { Network, SandboxPost, Tables } from "@pigy/core";
import { networkInfo } from "@/lib/networks";

/**
 * What the screens of the simulator say about the simulated networks of a
 * sandbox: what each way to make a network fail does, and which request it
 * strikes, in words. The server says which of them each network has:
 * `GET /api/sandbox/faults`. A kind or a request that it names and this
 * file does not know is shown by its name.
 */

/** What a kind of fault is called, and what it makes pigy do. */
type Words = { label: string; description: string };

const kinds: Record<string, Words> = {
  "rate-limit": {
    label: "Too many requests",
    description:
      "The network says that it has been asked too often. pigy waits and tries again.",
  },
  "server-error": {
    label: "Server error",
    description:
      "The network fails with an error of its own. pigy waits and tries again.",
  },
  "lost-response": {
    label: "Lost answer",
    description:
      "The network does what it is asked, and its answer never arrives. When it was asked to post, pigy waits, looks at the account, and finds the post there instead of posting it twice.",
  },
  "token-revoked": {
    label: "Access taken back",
    description:
      "The access that pigy was given to the account is taken back, for good. The post fails, and the account has to be connected again.",
  },
  "token-expired": {
    label: "Access ran out",
    description: "The access ends before its time. pigy renews it and goes on.",
  },
  "slow-processing": {
    label: "Slow to prepare",
    description:
      "The network takes the next post and needs half a minute to prepare it before it can be published. pigy waits, asks again every few seconds, and publishes the post when it is ready.",
  },
};

/**
 * What the same kinds do on a network where pigy can neither look for a
 * post nor ask a second time without posting twice, `cannotLook` of
 * lib/networks.ts: nothing is tried again that could post twice. A fault
 * can be armed for any request, so what is said of it holds for all of
 * them, and what it does to a post is said as that.
 */
const kindsWithoutLooking: Record<string, Words> = {
  "rate-limit": {
    label: "Too many requests",
    description:
      "The network says that it has been asked too often for the day, which ends at midnight UTC. pigy waits for the next day only when that is less than an hour away, and then goes on. Otherwise what it was doing fails.",
  },
  "server-error": {
    label: "Server error",
    description:
      "The network fails with an error of its own. When it was asked to post, pigy cannot tell whether the post arrived: it does not try again, and asks you to look.",
  },
  "lost-response": {
    label: "Lost answer",
    description:
      "The network does what it is asked, and its answer never arrives. When it was asked to post, the post is there and pigy cannot know: it does not try again, and asks you to look.",
  },
};

// The kinds of fault that make the publishing workflow wait before it
// tries again, on a network where pigy can look.
const waitingKinds: ReadonlySet<string> = new Set([
  "rate-limit",
  "server-error",
  "lost-response",
]);

/**
 * Whether a fault of `kind` on `network` makes the publishing workflow
 * wait before it tries again: as long as it would for real, which is a
 * minute at least. Not on a network where pigy cannot look: there a
 * delivery ends at once, but for one that meets the limit of a day in the
 * last hour of that day, which the description of that kind says.
 */
export function makesWait(kind: string, network: Network): boolean {
  return waitingKinds.has(kind) && !networkInfo[network].cannotLook;
}

/** What the panel says of a fault of a kind that makes pigy wait. */
export const waitNote =
  "pigy waits as long as it would for a real network before it tries again: a minute at least. Until then the post says that it is sending.";

const operations: Record<string, string> = {
  publish: "Posting",
  container: "Preparing a post",
  read: "Reading posts",
  delete: "Deleting a post",
  instance: "Reading the server",
  account: "Reading the account",
  identity: "Finding the account",
  server: "Reading the sign-in server",
  authorize: "Beginning a connection",
  token: "Getting or renewing the access",
  exchange: "Getting the access that lasts",
  refresh: "Renewing the access",
  revoke: "Giving the access back",
  profile: "Reading the profile",
};

/** What the fault `kind` is called, and what it does on `network`. */
export function faultKind(kind: string, network?: Network): Words {
  const words =
    network && networkInfo[network].cannotLook
      ? (kindsWithoutLooking[kind] ?? kinds[kind])
      : kinds[kind];
  return words ?? { label: kind, description: "" };
}

/** What the request `operation` is called, or any request for null. */
export function faultOperation(operation: string | null): string {
  if (operation === null) return "Any request";
  return operations[operation] ?? operation;
}

/** The order in which the panel offers the requests of a network. */
export function offeredOperations(declared: readonly string[]): string[] {
  // Posting first: the panel is there to make the next publish fail.
  return [...declared].sort(
    (a, b) => Number(b === "publish") - Number(a === "publish"),
  );
}

/** The network that the panel offers first. */
export function firstNetwork(
  declared: readonly Network[],
  connected: readonly Network[],
): Network | undefined {
  // One that the sandbox has an account of, so that the fault strikes
  // something.
  return declared.find((network) => connected.includes(network)) ?? declared[0];
}

/**
 * How far the deliveries of the workspace have come, in one value that
 * changes whenever one of them does: a target that changes its status, a
 * part that is published. The feeds are not synced, so they are asked for
 * again when it changes: what a delivery has done is in the world by then.
 */
export function selectDeliveries(tables: Tables): string {
  let statuses = "";
  for (const target of tables.post_target.values()) {
    // A channel that is chosen for a draft has sent nothing.
    if (target.status === "pending") continue;
    statuses += `${target.id}:${target.status}:${target.attempt};`;
  }
  return `${tables.target_part_result.size}/${statuses}`;
}

/**
 * Whether a delivery of the workspace is under way. While one is, the
 * world can change without a change of the workspace: a network that asks
 * to be tried again has used up a fault, or has taken a post and lost its
 * answer, and the workflow waits without a word.
 */
export function selectSending(tables: Tables): boolean {
  for (const target of tables.post_target.values()) {
    if (target.status === "sending") return true;
  }
  return false;
}

/**
 * A post of a feed and the replies that follow it, as the feed shows them:
 * a chain that goes on while a post has one reply is one list, the way a
 * thread is read. Where a post has several replies, each begins a chain of
 * its own under it.
 */
export type FeedChain = {
  /** The posts of the chain, in the order in which they reply. */
  posts: SandboxPost[];
  /** The chains that begin under the last post of this one. */
  branches: FeedChain[];
};

export function chainOf(post: SandboxPost): FeedChain {
  const posts = [post];
  let last = post;
  while (last.replies.length === 1) {
    const [next] = last.replies;
    if (!next) break;
    posts.push(next);
    last = next;
  }
  return {
    posts,
    branches: last.replies.length > 1 ? last.replies.map(chainOf) : [],
  };
}
