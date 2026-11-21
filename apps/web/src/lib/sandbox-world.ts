import { useEffect, useRef } from "react";
import { useOnline } from "@/lib/online";
import { selectDeliveries } from "@/lib/simulator";
import { useSynced } from "@/sync/react";

/**
 * Calls `refresh` whenever the world of the sandbox may have changed
 * without this screen: a delivery of the workspace has moved on, which
 * posts to a feed and uses up a fault, also one that another window
 * published. And when the connection is back or the person is, for what
 * was missed meanwhile. The world is not synced, so the screens of the
 * simulator ask for it again then.
 *
 * `refresh` has to be the same function on every render, as the one of
 * `useFetched` is.
 */
export function useWorldChanges(refresh: () => void): void {
  const deliveries = useSynced(selectDeliveries);
  const before = useRef(deliveries);
  useEffect(() => {
    if (before.current === deliveries) return;
    before.current = deliveries;
    refresh();
  }, [deliveries, refresh]);

  useOnline(refresh);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
}
