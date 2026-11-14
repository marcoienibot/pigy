import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";

// Matches every path that no other route does.
export const Route = createFileRoute("/_app/$")({
  component: NotFound,
});

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
