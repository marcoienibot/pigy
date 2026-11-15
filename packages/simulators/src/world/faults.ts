import type { Network } from "@pigy/core";
import type { SimStorage } from "./storage.ts";

/**
 * The ways a simulated network can be made to fail, so that a test, or a
 * person in the sandbox, can see what pigy does about it. A fault is armed
 * ahead of time and strikes the next request that it applies to, once.
 *
 * A simulator applies the kinds that its network can suffer from. Mastodon,
 * for one, has no tokens that expire.
 */
export const faultKinds = [
  /** The network answers that it has been asked too often. */
  "rate-limit",
  /** The network answers that it has failed. */
  "server-error",
  /**
   * The network does what it is asked, and the answer never arrives: the
   * request fails like a connection that broke. Whoever sent it cannot tell
   * whether it was carried out.
   */
  "lost-response",
  /** The token of the request has run out. It stays that way. */
  "token-expired",
  /** The token of the request was taken back. It stays that way. */
  "token-revoked",
  /**
   * What the request starts takes long to get ready, on networks that work
   * on what they are given after they have accepted it.
   */
  "slow-processing",
] as const;

export type FaultKind = (typeof faultKinds)[number];

export type Fault = {
  kind: FaultKind;
  /**
   * The kind of request to strike, by the names the network's simulator
   * gives them, such as "publish". Any request, if left out.
   */
  operation?: string | undefined;
};

export type Faults = {
  /** Arms `fault` for `network`, after the ones that are armed already. */
  arm(network: Network, fault: Fault): void;
  /** The faults of `network` that have yet to strike, oldest first. */
  armed(network: Network): Fault[];
  /**
   * The fault that strikes a request of `network` that does `operation`,
   * or undefined. Only a fault of one of `kinds` is taken, which are the
   * ones that the request can suffer from. A fault that is taken is no
   * longer armed.
   */
  take(
    network: Network,
    operation: string,
    kinds: readonly FaultKind[],
  ): FaultKind | undefined;
  /** Disarms every fault of `network`. */
  clear(network: Network): void;
};

export function createFaults(storage: SimStorage): Faults {
  const key = (network: Network) => `fault/${network}`;
  const armed = (network: Network) =>
    (storage.get(key(network)) as Fault[] | undefined) ?? [];
  return {
    arm(network, fault) {
      storage.put(key(network), [...armed(network), fault]);
    },
    armed,
    take(network, operation, kinds) {
      const faults = armed(network);
      const index = faults.findIndex(
        (fault) =>
          kinds.includes(fault.kind) &&
          (fault.operation === undefined || fault.operation === operation),
      );
      const [fault] = index < 0 ? [] : faults.splice(index, 1);
      if (!fault) return undefined;
      storage.put(key(network), faults);
      return fault.kind;
    },
    clear(network) {
      storage.delete(key(network));
    },
  };
}
