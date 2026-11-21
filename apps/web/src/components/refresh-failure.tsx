import { Button } from "@/components/ui/button";
import { failureMessage } from "@/lib/fetched";

/**
 * Says that what a screen has fetched could not be fetched again, and
 * that what it shows is therefore from before, with a way to try again.
 * For a screen that has an answer on screen: one that has none says so in
 * its place.
 */
export function RefreshFailure({
  what,
  failure,
  loading,
  onRetry,
}: {
  /** What could not be refreshed, as the sentence begins: "The feeds". */
  what: string;
  /** Why the request failed. */
  failure: unknown;
  /** A request is on its way. */
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
    >
      <p className="min-w-0 flex-1 basis-64">
        {what} could not be refreshed: {failureMessage(failure)} What is shown
        is from before.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>
        Try again
      </Button>
    </div>
  );
}
