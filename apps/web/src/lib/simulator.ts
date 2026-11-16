import type { Network, SandboxPost, Tables } from "@pigy/core";

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
      "The network does what it is asked, and its answer never arrives. pigy waits, looks at the account, and finds the post there instead of posting it twice.",
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
};

/**
 * The kinds of fault that make the publishing workflow wait before it tries
 * again: as long as it would for real, which is a minute at least.
 */
export const waitingKinds: ReadonlySet<string> = new Set([
  "rate-limit",
  "server-error",
  "lost-response",
]);

/** What the panel says of a fault of a kind that makes pigy wait. */
export const waitNote =
  "pigy waits as long as it would for a real network before it tries again: a minute at least. Until then the post says that it is sending.";

const operations: Record<string, string> = {
  publish: "Posting",
  read: "Reading posts",
  delete: "Deleting a post",
  instance: "Reading the server",
  account: "Reading the account",
  identity: "Finding the account",
  server: "Reading the sign-in server",
  authorize: "Beginning a connection",
  token: "Getting or renewing the access",
  revoke: "Giving the access back",
  profile: "Reading the profile",
};

/** What the fault `kind` is called and does. */
export function faultKind(kind: string): Words {
  return kinds[kind] ?? { label: kind, description: "" };
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
