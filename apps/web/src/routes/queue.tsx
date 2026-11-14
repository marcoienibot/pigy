import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";

export const Route = createFileRoute("/queue")({
  component: Queue,
});

function Queue() {
  return (
    <Page title="Queue">
      <EmptyState
        title="Nothing scheduled"
        description="Scheduled and queued posts will appear here."
      />
    </Page>
  );
}
