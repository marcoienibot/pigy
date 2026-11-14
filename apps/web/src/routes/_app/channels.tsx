import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, Page } from "@/components/page";

export const Route = createFileRoute("/_app/channels")({
  component: Channels,
});

function Channels() {
  return (
    <Page title="Channels">
      <EmptyState
        title="No channels connected"
        description="Your LinkedIn, Mastodon, Bluesky and Threads accounts will appear here."
      />
    </Page>
  );
}
