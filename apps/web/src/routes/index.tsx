import {
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EmptyState, Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { fetchHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  loader: ({ abortController }) => fetchHealth(abortController.signal),
  component: Drafts,
  errorComponent: DraftsError,
});

function Drafts() {
  const health = Route.useLoaderData();

  return (
    <Page title="Drafts">
      <EmptyState
        title="No drafts yet"
        description="Posts you are still writing will appear here."
      />
      <Status>
        <StatusRow label="API">
          <Dot className="bg-emerald-500" />
          {health.status}
        </StatusRow>
        <StatusRow label="Version">
          <span className="font-mono text-xs">{health.version}</span>
        </StatusRow>
      </Status>
    </Page>
  );
}

function DraftsError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title="Drafts">
      <Status>
        <StatusRow label="API">
          <Dot className="bg-destructive" />
          unreachable
        </StatusRow>
        <StatusRow label="Error">
          {error instanceof Error ? error.message : String(error)}
        </StatusRow>
      </Status>
      <div className="mx-auto mt-3 max-w-sm">
        <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
          Retry
        </Button>
      </div>
    </Page>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <dl className="mx-auto max-w-sm divide-y rounded-lg border">{children}</dl>
  );
}

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 break-all">{children}</dd>
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", className)}
    />
  );
}
