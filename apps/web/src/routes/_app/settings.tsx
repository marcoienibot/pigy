import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings")({
  component: Settings,
});

const sectionLink = cn(
  "-mb-px border-b-2 border-transparent pb-2 text-muted-foreground outline-none",
  "hover:text-foreground focus-visible:text-foreground",
  "aria-[current=page]:border-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground",
);

function Settings() {
  const { me } = Route.useRouteContext();

  return (
    <Page title="Settings">
      <div className="mx-auto max-w-xl">
        <nav
          aria-label="Settings"
          className="mb-6 flex gap-4 overflow-x-auto border-b whitespace-nowrap"
        >
          <Link
            to="/settings"
            // Without this it would also be current on the other sections,
            // whose paths start with its own.
            activeOptions={{ exact: true }}
            className={sectionLink}
          >
            General
          </Link>
          <Link to="/settings/schedule" className={sectionLink}>
            Posting schedule
          </Link>
          <Link to="/settings/api" className={sectionLink}>
            API
          </Link>
          {me.role === "admin" && (
            <Link to="/settings/access" className={sectionLink}>
              Access
            </Link>
          )}
          <Link to="/settings/about" className={sectionLink}>
            About
          </Link>
        </nav>
        <Outlet />
      </div>
    </Page>
  );
}
