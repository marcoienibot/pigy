import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";

export const Route = createFileRoute("/_app/")({
  component: Drafts,
});

function Drafts() {
  return (
    <Page title="Drafts">
      <EmptyState
        title="No drafts yet"
        description="Posts you are still writing will appear here."
      />
    </Page>
  );
}
