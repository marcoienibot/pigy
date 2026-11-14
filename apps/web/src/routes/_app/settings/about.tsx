import {
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { fetchHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/about")({
  loader: ({ abortController }) => fetchHealth(abortController.signal),
  component: About,
  errorComponent: AboutError,
});

function About() {
  const health = Route.useLoaderData();

  return (
    <Status>
      <StatusRow label="API">
        <Dot className="bg-emerald-500" />
        {health.status}
      </StatusRow>
      <StatusRow label="Version">
        <span className="font-mono text-xs">{health.version}</span>
      </StatusRow>
    </Status>
  );
}

function AboutError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <>
      <Status>
        <StatusRow label="API">
          <Dot className="bg-destructive" />
          unreachable
        </StatusRow>
        <StatusRow label="Error">
          {error instanceof Error ? error.message : String(error)}
        </StatusRow>
      </Status>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => router.invalidate()}
      >
        Retry
      </Button>
    </>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <section>
      <h2 className="font-medium">About</h2>
      <dl className="mt-3 divide-y rounded-lg border">{children}</dl>
    </section>
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
