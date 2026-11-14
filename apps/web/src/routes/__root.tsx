import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Page } from "@/components/page";

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function NotFound() {
  return (
    <Page title="Not found">
      <EmptyState
        title="Page not found"
        description="There is nothing at this address."
      >
        <Link to="/" className="underline underline-offset-4">
          Go to Drafts
        </Link>
      </EmptyState>
    </Page>
  );
}
