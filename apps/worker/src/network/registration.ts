import type { Reach } from "./reach.ts";

/**
 * pigy as a network knows it that takes no registration from pigy itself:
 * whoever runs this pigy has registered it by hand, with the network's
 * portal for developers, and has given the Worker what the portal handed
 * out, as secrets. LinkedIn and Threads are such networks.
 *
 * `sandbox` is the registration that the simulated network of every
 * sandbox is made with, src/sim/object.ts, and `operator` is the one of
 * whoever runs this pigy, as the secrets of the Worker have it. The
 * result is the registration of pigy at the network of `reach`, or
 * undefined if it has none there: a live workspace of a pigy whose
 * operator has not given it every part of one.
 *
 * The two never mix. The registration of the operator's does not go into
 * a simulated world: a simulator would refuse its secret unread, and it
 * has no business there. And the one of a sandbox is good in a simulated
 * world and nowhere else: its secret is marked as a simulated one, which
 * no real service takes. So a sandbox connects accounts in a pigy that is
 * registered nowhere.
 */
export function registrationFor<Registration extends Record<string, string>>(
  reach: Reach,
  sandbox: Registration,
  operator: { [Part in keyof Registration]: string | undefined },
): Registration | undefined {
  if (reach.simulated) return sandbox;
  return Object.values(operator).every(Boolean)
    ? (operator as Registration)
    : undefined;
}
