import type { Fetch } from "@pigy/core";
import type { Bindings } from "../env.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";

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
 * A `fetch` that the simulated world of the sandbox `workspace` answers.
 * It never leaves the Worker: a request goes to the Durable Object of the
 * world and to nothing else, whatever its address. It fails as a `fetch`
 * does that got no answer, with a TypeError, for a host that the world
 * does not have and for an answer that a fault made a simulator lose.
 * Anything else that it throws is a failure of pigy's, not of a network.
 */
export function worldFetch(
  namespace: Bindings["SIM_WORLD"],
  workspace: WorkspaceIdentity,
): Fetch {
  if (workspace.environment !== "sandbox") {
    throw new Error(`The ${workspace.environment} workspace has no simulation`);
  }
  return async (input, init) => {
    const request = new Request(input, init);
    // What a network sees of a request, and nothing else of it, such as
    // the signal that would end it.
    const answer = await namespace.getByName(workspace.id).request(workspace, {
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
