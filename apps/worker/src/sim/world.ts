import type { Fetch } from "@pigy/core";
import type { Bindings } from "../env.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";
import type { WorldRequest } from "./object.ts";

/**
 * The Worker's side of the simulated worlds: the only way into their
 * Durable Objects, and the addresses of their pages.
 */

/**
 * What the `fetch` of a simulated world fails with for a host that the
 * world does not have. It is a TypeError, which is what a `fetch` fails
 * with when a host cannot be reached, so an adapter takes it for that.
 * Unlike on the internet it is for good: a world has the hosts that it
 * has, and trying again later finds the same.
 */
export class WorldHostMissing extends TypeError {
  constructor(readonly host: string) {
    super(`The simulated world has no host ${host}`);
  }
}

/**
 * Whether `error` is the runtime's own failure of a call into a Durable
 * Object, and not what the code of the object threw: the connection to the
 * object was lost, a deploy has reset the object, the object has more to do
 * than it can take. The runtime marks such an error, with `retryable` or
 * with `overloaded`: "Error handling" in the documentation of Durable
 * Objects. An error from the code of an object has neither mark.
 */
function isInfrastructureFailure(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (("retryable" in error && error.retryable === true) ||
      ("overloaded" in error && error.overloaded === true))
  );
}

/**
 * A `fetch` that the simulated world of the sandbox `workspace` answers.
 * It never leaves the Worker: a request goes to the Durable Object of the
 * world and to nothing else, whatever its address. It fails as a `fetch`
 * does that got no answer, with a TypeError, for a host that the world
 * does not have, for an answer that a fault made a simulator lose, and for
 * a world that the runtime could not reach or get an answer from.
 * Anything else that it throws is a failure of pigy's, not of a network.
 */
export function worldFetch(
  namespace: Bindings["SIM_WORLD"],
  workspace: WorkspaceIdentity,
): Fetch {
  if (workspace.environment !== "sandbox") {
    throw new Error(`The ${workspace.environment} workspace has no simulation`);
  }
  const ask = async (request: WorldRequest) => {
    try {
      return await namespace
        .getByName(workspace.id)
        .request(workspace, request);
    } catch (error) {
      // The way to the world is to a sandbox what the internet is to a live
      // workspace, and this is a connection that broke on it: nothing is
      // wrong with the request, and it may well work later. Whether it
      // arrived is as unknown as on the internet. Only what the runtime
      // marks as its own is taken for that. What the object threw is a bug
      // in it or in a simulator, and stays one.
      if (!isInfrastructureFailure(error)) throw error;
      throw new TypeError(
        `The simulated world could not be reached: ${error.message}`,
        { cause: error },
      );
    }
  };
  return async (input, init) => {
    const request = new Request(input, init);
    // What a network sees of a request, and nothing else of it, such as
    // the signal that would end it.
    const answer = await ask({
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: request.body && (await request.arrayBuffer()),
    });
    if (!answer) {
      throw new Error(
        `The simulated world of workspace ${workspace.id} is another workspace's`,
      );
    }
    if ("noSuchHost" in answer) throw new WorldHostMissing(answer.noSuchHost);
    // What `fetch` does when a connection breaks.
    if ("unreachable" in answer) throw new TypeError(answer.unreachable);
    const { status, headers, body } = answer;
    // An answer with one of these statuses has no body, not even an empty
    // one.
    const bodiless = [204, 205, 304].includes(status);
    return new Response(bodiless ? null : body, { status, headers });
  };
}

/** Where the Worker serves the pages of the simulated networks. */
export const worldPagesPath = "/sim/network";

/**
 * The address under which the app, at `origin`, serves the page of a
 * simulated network at `url`. A browser cannot open `url` itself: the host
 * exists in a simulated world only.
 */
export function worldPageUrl(url: string, origin: string): string {
  const { host, pathname, search } = new URL(url);
  return `${origin}${worldPagesPath}/${host}${pathname}${search}`;
}

/**
 * The address of a simulated network that a path of the app under
 * `worldPagesPath` stands for, the reverse of `worldPageUrl`, or undefined
 * if it stands for none that a browser may open.
 *
 * A browser may open the pages that are there for a person, which are the
 * ones where they consent to a connection: `/oauth/authorize` on Mastodon.
 * The rest of a simulated network is its API, which is for the adapters.
 */
export function worldPage(path: string, search: string): URL | undefined {
  if (!path.startsWith(`${worldPagesPath}/`)) return undefined;
  // A host name and nothing that could make an address read as another.
  const [, host, page] =
    /^([a-z0-9.-]+)(\/.*)$/.exec(path.slice(worldPagesPath.length + 1)) ?? [];
  if (!host || page !== "/oauth/authorize") return undefined;
  try {
    return new URL(`https://${host}${page}${search}`);
  } catch {
    // Not everything that is made of the letters of a host name is one:
    // "xn--" is none. No world has such a host.
    return undefined;
  }
}
