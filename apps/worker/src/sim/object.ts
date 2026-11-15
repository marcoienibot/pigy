import { DurableObject } from "cloudflare:workers";
import { type Clock, sandboxMastodonDomain } from "@pigy/core";
import { createMastodonSimulator } from "@pigy/simulators/mastodon";
import { createWorld } from "@pigy/simulators/world";
import type { Bindings } from "../env.ts";
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

// The accounts that a new world has, for a person to connect as.
const seedAccounts = [
  ["ada", "Ada Lovelace"],
  ["grace", "Grace Hopper"],
  ["alan", "Alan Turing"],
] as const;

// Where the object keeps what is its own, next to the keys of the world.
// No network has this name, so no key of the world begins like these.
const workspaceKey = "object/workspace";
const seededKey = "object/seeded";

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
export function simWorldObject({ now }: { now: Clock }) {
  return class SimWorldObject extends DurableObject<Bindings> {
    /**
     * Answers `request`, which is addressed to a host of a simulated
     * network, for the sandbox `workspace`. The Worker makes the request
     * itself, after it has decided whose world this is. Returns nothing if
     * `workspace` is not the sandbox that the world belongs to.
     */
    async request(
      workspace: WorkspaceIdentity,
      { url, method, headers, body }: WorldRequest,
    ): Promise<WorldAnswer | undefined> {
      if (!this.#bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const world = createWorld({ storage: this.ctx.storage.kv, now });
      const mastodon = createMastodonSimulator(world);
      if (!this.ctx.storage.kv.get(seededKey)) {
        mastodon.addInstance(sandboxMastodonDomain);
        for (const [username, name] of seedAccounts) {
          mastodon.addAccount(sandboxMastodonDomain, username, name);
        }
        this.ctx.storage.kv.put(seededKey, true);
      }
      // The simulators of the networks. Each says which hosts are its own,
      // and the one that owns the host of the request answers it. They are
      // not tried in turn: a simulator fails for a host that is not its own
      // the same way as for an answer that a fault loses, so going on to
      // the next would take a fault of one network for a host of another.
      const simulators = [mastodon];
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
