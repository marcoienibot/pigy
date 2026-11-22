import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshFailure } from "@/components/refresh-failure";
import { Button } from "@/components/ui/button";
import { fetchPublishRecord } from "@/lib/api";
import { workspaceWords } from "@/lib/api-keys";
import { failureMessage, useFetched } from "@/lib/fetched";
import {
  type RecordEntry,
  recordEntries,
  selectRecorded,
  selectRecordNames,
  type Tone,
} from "@/lib/publish-record";
import { useNow, whenAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSynced } from "@/sync/react";

export const Route = createFileRoute("/_app/settings/record")({
  component: PublishRecord,
});

const toneClass: { readonly [T in Tone]: string } = {
  done: "text-muted-foreground",
  failed: "text-destructive",
  open: "text-foreground",
};

/**
 * The record of what the workspace on screen was asked to publish: from
 * where, when, and how each delivery ended. It is not synced: the object
 * of the workspace keeps it, and this screen asks for it, page by page,
 * and keeps it in itself alone, so it goes when the workspace changes.
 * It asks again when the person says so, and when the local copy says
 * that a delivery was asked for or has ended, `selectRecorded`, which is
 * when the record has changed, whoever asked: without that, a delivery
 * that was on its way when the screen was opened would stay so on it.
 */
function PublishRecord() {
  const { workspace } = Route.useRouteContext();
  // How many pages are asked for. They are asked for anew, from the
  // newest, so that what is on screen is one answer.
  const [pages, setPages] = useState(1);
  const request = useCallback(
    (signal: AbortSignal) => fetchPublishRecord(workspace.id, pages, signal),
    [workspace.id, pages],
  );
  const { data, failure, loading, refresh } = useFetched(request);
  const recorded = useSynced(selectRecorded);
  const seen = useRef(recorded);
  useEffect(() => {
    if (seen.current === recorded) return;
    seen.current = recorded;
    refresh();
  }, [recorded, refresh]);
  const names = useSynced(selectRecordNames);
  const entries = useMemo(
    () => data && recordEntries(data.requests, names, workspace.environment),
    [data, names, workspace.environment],
  );
  const now = useNow();

  return (
    <section>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Publishing record</h2>
          <p className="mt-1 text-muted-foreground">
            Every time the {workspaceWords[workspace.environment]} was asked to
            publish in the last 90 days: in the app, through the API or by the
            schedule, and how each account took it. The record keeps no text of
            a post.
          </p>
        </div>
        {entries !== null && (
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(loading && "animate-spin")}
            />
            Refresh
          </Button>
        )}
      </div>

      <div className="mt-6">
        {entries === null ? (
          failure ? (
            <div role="alert">
              <p className="text-destructive">{failureMessage(failure)}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={refresh}
                disabled={loading}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">Loading the record…</p>
          )
        ) : (
          <>
            {failure !== null && (
              <div className="mb-3">
                <RefreshFailure
                  what="The record"
                  failure={failure}
                  loading={loading}
                  onRetry={refresh}
                />
              </div>
            )}
            {entries.length === 0 ? (
              <p className="text-muted-foreground">
                Nothing was published in the{" "}
                {workspaceWords[workspace.environment]} in the last 90 days.
              </p>
            ) : (
              <ol
                aria-label="Publishing record"
                className="divide-y rounded-lg border"
              >
                {entries.map((entry) => (
                  <Entry key={entry.key} entry={entry} now={now} />
                ))}
              </ol>
            )}
            {data?.more && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={loading}
                onClick={() => setPages((count) => count + 1)}
              >
                Show older
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Entry({ entry, now }: { entry: RecordEntry; now: number }) {
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{entry.source}</span>
        <time
          dateTime={new Date(entry.requestedAt).toISOString()}
          title={new Date(entry.requestedAt).toLocaleString()}
          className="text-xs text-muted-foreground"
        >
          {whenAgo(entry.requestedAt, now)}
        </time>
        {entry.postId !== null && (
          <Link
            to="/sent"
            search={{ post: entry.postId }}
            className="text-xs underline underline-offset-2 hover:text-foreground"
          >
            See the post
          </Link>
        )}
      </div>
      <ul className="mt-1 text-sm">
        {entry.deliveries.map((delivery) => (
          <li key={delivery.key} className="flex flex-wrap gap-x-2">
            <span className="break-all">
              {delivery.account}{" "}
              <span className="text-muted-foreground">
                on {delivery.network}
              </span>
            </span>
            <span className={cn(toneClass[delivery.tone])}>
              {delivery.outcome}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}
