import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { hasScreen, useSwitchWorkspace } from "@/lib/workspace";

export const Route = createFileRoute("/_app/simulator")({
  component: Simulator,
});

const sectionLink = cn(
  "-mb-px border-b-2 border-transparent pb-2 text-muted-foreground outline-none",
  "hover:text-foreground focus-visible:text-foreground",
  "aria-[current=page]:border-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground",
);

/**
 * The simulated networks of the sandbox: what they have published, and a
 * way to make them fail. Neither is synced data: it is the world of the
 * sandbox, which the server holds and the screens ask for.
 *
 * It is the sandbox's alone: `hasScreen`. In the live workspace there is
 * no such screen: not in the navigation, not in the command palette, and
 * not at its address, which says so. The switch to live leaves it for the
 * drafts, so the address is one that was typed, kept or opened in a tab
 * that shows live.
 */
function Simulator() {
  const { workspace } = Route.useRouteContext();
  if (!hasScreen(workspace.environment, "/simulator")) return <NotInLive />;

  return (
    <Page title="Simulator">
      <div className="mx-auto max-w-2xl">
        <nav aria-label="Simulator" className="mb-4 flex gap-4 border-b">
          <Link
            to="/simulator"
            // Without this it would also be current on the other section,
            // whose path starts with its own.
            activeOptions={{ exact: true, includeSearch: false }}
            className={sectionLink}
          >
            Feeds
          </Link>
          <Link to="/simulator/failures" className={sectionLink}>
            Failures
          </Link>
        </nav>
        <Outlet />
      </div>
    </Page>
  );
}

/**
 * What the address of the simulator shows in the live workspace: that
 * there is nothing at it there. The way to the sandbox is offered, where
 * the person may have meant to be: the address is the same in both.
 */
function NotInLive() {
  const switchWorkspace = useSwitchWorkspace();

  return (
    <Page title="Not found">
      <EmptyState
        title="Not in the live workspace"
        description="The simulator belongs to the sandbox, whose networks are simulated. The live workspace posts to the real networks, which pigy cannot show or make fail."
      >
        <Button variant="outline" onClick={() => switchWorkspace("sandbox")}>
          Switch to the sandbox
        </Button>
      </EmptyState>
    </Page>
  );
}
