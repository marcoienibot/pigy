import { DurableObject } from "cloudflare:workers";
import {
  type Clock,
  connectCallbackPath,
  type Network,
  type SandboxFault,
  type SandboxFaults,
  sandboxBlueskyHandles,
  sandboxMastodonDomain,
} from "@pigy/core";
import {
  blueskyFaultKinds,
  blueskyOperations,
  createBlueskySimulator,
} from "@pigy/simulators/bluesky";
import {
  createLinkedInSimulator,
  linkedInFaultKinds,
  linkedInOperations,
} from "@pigy/simulators/linkedin";
import {
  createMastodonSimulator,
  mastodonFaultKinds,
  mastodonOperations,
} from "@pigy/simulators/mastodon";
import {
  createWorld,
  type FaultKind,
  feed,
  type SimAccount,
  type SimPost,
} from "@pigy/simulators/world";
import type { Bindings } from "../env.ts";
import {
  blueskyClientMetadataPath,
  blueskyKeysWithoutRequest,
  pigyClientMetadata,
} from "../network/bluesky-client.ts";
import { sandboxLinkedInClient } from "../network/linkedin-client.ts";
import {
  type WorkspaceIdentity,
  workspaceIdentitySchema,
} from "../workspace/store.ts";

/**
 * A request to a simulated network as it goes into the object: whole. A
 * `Request` would bring its body as a stream, which stays open across the
 * call until somebody has read it, and a network that refuses a request
 * does not always read it.
 */
export type WorldRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  /**
   * For a request that a browser makes of a page of the world: the origin
   * at which that browser reaches pigy, as the Worker read it from the
   * request. It is where the pigy of this world is, and so where a
   * simulated network may send the browser back to.
   */
  pigy?: string;
};

/**
 * What a simulated network answers a request with, whole as well. The
 * other two stand for the failure of a `fetch` that got no answer:
 * `noSuchHost` if no network of the world has the host of the request,
 * which is for good, and `unreachable` if a fault made the answer get lost.
 */
export type WorldAnswer =
  | { status: number; headers: [string, string][]; body: ArrayBuffer }
  | { noSuchHost: string }
  | { unreachable: string };

/** What is in a world for a person to look at: its accounts and posts. */
export type WorldContents = { accounts: SimAccount[]; posts: SimPost[] };

/** The faults of a world after one was armed, or which field was wrong. */
export type ArmOutcome =
  | { ok: true; faults: SandboxFaults }
  | { ok: false; field: "network" | "kind" | "operation"; message: string };

/**
 * The networks that a world simulates, each with the ways it can be made
 * to fail and the kinds of request that a fault can strike, as its
 * simulator declares them. A network joins by getting an entry here.
 */
const simulated: {
  readonly [Name in Network]?: {
    kinds: readonly FaultKind[];
    operations: readonly string[];
  };
} = {
  bluesky: { kinds: blueskyFaultKinds, operations: blueskyOperations },
  linkedin: { kinds: linkedInFaultKinds, operations: linkedInOperations },
  mastodon: { kinds: mastodonFaultKinds, operations: mastodonOperations },
};

const simulatedNetworks = Object.keys(simulated) as Network[];

// The accounts that a new world has, for a person to connect as.
const seedAccounts = [
  ["ada", "Ada Lovelace"],
  ["grace", "Grace Hopper"],
  ["alan", "Alan Turing"],
] as const;

// The PDS of the simulated Bluesky of a sandbox, behind the simulated
// entryway, as most accounts of Bluesky are.
const sandboxBlueskyPds = "pds.bsky.test";

// Where the object keeps what is its own, next to the keys of the world.
// No network has this name, so no key of the world begins like these.
const workspaceKey = "object/workspace";
// Mastodon's, from before there was another network.
const seededKey = "object/seeded";
// Each network that came later has its own, so that a world from before it
// gets its accounts the first time it is used.
const seededBlueskyKey = "object/seeded/bluesky";
const seededLinkedInKey = "object/seeded/linkedin";

/**
 * The Durable Object of a simulated world: the networks as one person's
 * sandbox workspace sees them, with their accounts, tokens and posts. It is
 * named after the ID of the workspace. The simulators of @pigy/simulators
 * do the work, and keep everything in the storage of the object, so they
 * are made anew for every request.
 *
 * Nothing reaches the object but the Worker, which has its binding, and it
 * reaches nothing: a simulator makes no requests. `worldFetch` of world.ts
 * is the way in.
 *
 * A function that returns the class, because the runtime constructs the
 * object and there is no other way to hand it what it is built with.
 */
export function simWorldObject({
  now,
  developmentBlueskyClientKeys,
}: {
  now: Clock;
  /** See `AppDependencies`. */
  developmentBlueskyClientKeys: string | undefined;
}) {
  return class SimWorldObject extends DurableObject<Bindings> {
    /**
     * Answers `request`, which is addressed to a host of a simulated
     * network, for the sandbox `workspace`. The Worker makes the request
     * itself, after it has decided whose world this is. Returns nothing if
     * `workspace` is not the sandbox that the world belongs to.
     */
    async request(
      workspace: WorkspaceIdentity,
      { url, method, headers, body, pigy }: WorldRequest,
    ): Promise<WorldAnswer | undefined> {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const { mastodon, bluesky, linkedin } = this.#world();
      if (pigy !== undefined) {
        // LinkedIn sends a browser to an address that was entered for the
        // application, in full, and to no other. The application of a
        // sandbox is pigy where this browser reaches it, so that is the
        // one address it has, as an operator enters the address of their
        // pigy for theirs. A world cannot know it before it is asked.
        linkedin.setRedirectUris(sandboxLinkedInClient.clientId, [
          pigy + connectCallbackPath("linkedin"),
        ]);
      }
      // The simulators of the networks. Each says which hosts are its own,
      // and the one that owns the host of the request answers it. They are
      // not tried in turn: a simulator fails for a host that is not its own
      // the same way as for an answer that a fault loses, so going on to
      // the next would take a fault of one network for a host of another.
      const simulators = [mastodon, bluesky, linkedin];
      const { host } = new URL(url);
      const simulator = simulators.find((candidate) => candidate.owns(host));
      if (!simulator) return { noSuchHost: host };
      try {
        const response = await simulator.fetch(url, { method, headers, body });
        return {
          status: response.status,
          headers: [...response.headers],
          body: await response.arrayBuffer(),
        };
      } catch (error) {
        // What `fetch` fails with when no answer comes: the simulator has
        // lost its answer, as a fault told it to. Anything else is a bug in
        // a simulator, and is not passed off as the network's.
        if (error instanceof TypeError) return { unreachable: error.message };
        throw error;
      }
    }

    /**
     * The accounts of the world and what they have published, oldest
     * first, for the sandbox `workspace`. Returns nothing if `workspace` is
     * not the sandbox that the world belongs to.
     */
    contents(workspace: WorkspaceIdentity): WorldContents | undefined {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const { world } = this.#world();
      return {
        accounts: simulatedNetworks.flatMap((network) =>
          world.accounts(network).all(),
        ),
        posts: feed(world, simulatedNetworks).map(({ post }) => post),
      };
    }

    /**
     * The ways the networks of the world can be made to fail, and the
     * faults that are armed. Returns nothing if `workspace` is not the
     * sandbox that the world belongs to.
     */
    faults(workspace: WorkspaceIdentity): SandboxFaults | undefined {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const { world } = this.#world();
      return {
        networks: simulatedNetworks.map((network) => ({
          network,
          kinds: [...(simulated[network]?.kinds ?? [])],
          operations: [...(simulated[network]?.operations ?? [])],
          armed: world.faults.armed(network).map(({ kind, operation }) => ({
            kind,
            operation: operation ?? null,
          })),
        })),
      };
    }

    /**
     * Arms a fault: the next request to the network that it applies to
     * fails that way. Only what the simulator of the network declares is
     * taken. Returns nothing if `workspace` is not the sandbox that the
     * world belongs to.
     */
    arm(
      workspace: WorkspaceIdentity,
      { network, kind, operation }: SandboxFault,
    ): ArmOutcome | undefined {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const declared = simulated[network];
      if (!declared) {
        return {
          ok: false,
          field: "network",
          message: `The sandbox does not simulate ${network} yet.`,
        };
      }
      const known = declared.kinds.find((candidate) => candidate === kind);
      if (!known) {
        return {
          ok: false,
          field: "kind",
          message: `The simulated ${network} cannot fail with "${kind}".`,
        };
      }
      if (operation !== undefined && !declared.operations.includes(operation)) {
        return {
          ok: false,
          field: "operation",
          message: `The simulated ${network} has no request "${operation}".`,
        };
      }
      this.#world().world.faults.arm(network, { kind: known, operation });
      // Checked just now: the world is this workspace's.
      const faults = this.faults(workspace);
      if (!faults) throw new Error("The world has changed hands");
      return { ok: true, faults };
    }

    /**
     * Disarms every fault of the world. Returns nothing if `workspace` is
     * not the sandbox that the world belongs to.
     */
    disarm(workspace: WorkspaceIdentity): SandboxFaults | undefined {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const { world } = this.#world();
      for (const network of simulatedNetworks) world.faults.clear(network);
      return this.faults(workspace);
    }

    /**
     * The world of the object and the simulators of its networks, over the
     * storage of the object. A world that is used for the first time gets
     * what every sandbox starts with.
     */
    #world() {
      const { kv } = this.ctx.storage;
      const world = createWorld({ storage: kv, now });
      const mastodon = createMastodonSimulator(world);
      if (!kv.get(seededKey)) {
        mastodon.addInstance(sandboxMastodonDomain);
        for (const [username, name] of seedAccounts) {
          mastodon.addAccount(sandboxMastodonDomain, username, name);
        }
        kv.put(seededKey, true);
      }
      const bluesky = createBlueskySimulator(world, {
        // What the web has at the address of a client, which a real
        // authorization server reads and a simulator cannot. The one client
        // of a sandbox is pigy, and pigy knows what it serves at its
        // address: its client metadata, with the keys that it has.
        clients: async (clientId) => {
          const url = new URL(clientId);
          const keys = blueskyKeysWithoutRequest(
            this.env,
            developmentBlueskyClientKeys,
          );
          return url.pathname === blueskyClientMetadataPath && keys
            ? pigyClientMetadata(url.origin, keys)
            : undefined;
        },
        // pigy on somebody's machine is reached at http://localhost, which
        // a real server does not take as the address of a client. Its
        // sandbox takes it, or it could not be tried there.
        localClients: true,
      });
      if (!kv.get(seededBlueskyKey)) {
        bluesky.addPds(sandboxBlueskyPds);
        for (const [index, handle] of sandboxBlueskyHandles.entries()) {
          bluesky.addAccount({
            handle,
            pds: sandboxBlueskyPds,
            name: seedAccounts[index]?.[1] ?? handle,
          });
        }
        kv.put(seededBlueskyKey, true);
      }
      const linkedin = createLinkedInSimulator(world);
      if (!kv.get(seededLinkedInKey)) {
        // LinkedIn knows an application only as somebody has made it in
        // its developer portal. In the world of a sandbox pigy is this
        // one, which is made with the world, and never the application of
        // the operator's. It has no redirect address yet: `request` enters
        // the one of the pigy that a browser asks for a page of LinkedIn.
        linkedin.addClient({ name: "pigy", ...sandboxLinkedInClient });
        for (const [, name] of seedAccounts) linkedin.addMember(name);
        kv.put(seededLinkedInKey, true);
      }
      return { world, mastodon, bluesky, linkedin };
    }

    /**
     * Ties the object to the workspace it is first used for, and from then
     * on says no to any other: it returns whether the world is that of the
     * workspace. A world belongs to a sandbox, so it is never that of a
     * live workspace. A mistake in the Worker can then neither make a live
     * workspace talk to a simulation nor hand one person's world to
     * another.
     */
    #bind({ id, ownerId, environment }: WorkspaceIdentity): boolean {
      if (environment !== "sandbox") return false;
      const { kv } = this.ctx.storage;
      const bound = kv.get<{ id: string; ownerId: string }>(workspaceKey);
      if (!bound) {
        kv.put(workspaceKey, { id, ownerId });
        return true;
      }
      return bound.id === id && bound.ownerId === ownerId;
    }
  };
}
