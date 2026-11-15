import type { Fetch } from "@pigy/core";
import type { Bindings } from "../env.ts";
import { worldFetch, worldPageUrl } from "../sim/world.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";

/** How the adapters of a workspace reach the networks. */
export type Reach = {
  /** Carries every request of an adapter. */
  fetch: Fetch;
  /**
   * Turns an address at a network that the browser is about to be sent to
   * into the one it should open, for the app at `origin`. `fetch` decides
   * where the Worker's own requests go, this does the same for the browser.
   */
  browserUrl(url: string, origin: string): string;
  /**
   * An address that a network gave for something of its own, such as the
   * picture of an account, if a browser can open it, and null otherwise.
   */
  publicUrl(url: string | null): string | null;
  /**
   * Whose registrations with Mastodon instances the workspace uses: the
   * `scope` of the table `mastodon_app`.
   */
  registrations: string;
};

/**
 * How `workspace` reaches the networks: for real if it is live, in its own
 * simulated world if it is a sandbox. This is the one place that decides,
 * and it goes by the environment of the workspace, which D1 holds, and by
 * nothing that a request says.
 *
 * A sandbox gets no `fetch` that leads outside, so whatever is done there,
 * and whatever is typed, cannot reach a real host. A live workspace gets
 * none that leads into a simulation.
 */
export function reachOf(
  workspace: WorkspaceIdentity,
  env: Bindings,
  fetch: Fetch,
): Reach {
  switch (workspace.environment) {
    case "live":
      return {
        fetch,
        browserUrl: (url) => url,
        publicUrl: (url) => url,
        registrations: "live",
      };
    case "sandbox":
      return {
        fetch: worldFetch(env.SIM_WORLD, workspace),
        browserUrl: worldPageUrl,
        // The hosts of a simulated world exist nowhere else. Its pages for
        // people are served by the app. The rest has no address at all, and
        // a link to it would lead nowhere.
        publicUrl: () => null,
        // A world has instances of its own, and so registrations of its
        // own: the same domain is another server in every world.
        registrations: workspace.id,
      };
  }
}
