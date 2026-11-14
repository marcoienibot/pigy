import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";

export const Route = createFileRoute("/_app/sent")({
  component: Sent,
});

function Sent() {
  return (
    <Page title="Sent">
      <EmptyState
        title="Nothing sent yet"
        description="Published posts will appear here."
      />
    </Page>
  );
}
