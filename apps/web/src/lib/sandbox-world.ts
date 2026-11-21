import { useEffect, useEffectEvent, useRef } from "react";
import { useOnline } from "@/lib/online";
import { selectDeliveries, selectSending } from "@/lib/simulator";
import { useSynced } from "@/sync/react";

/**
 * How often the world is asked for again while a delivery is under way,
 * in milliseconds.
 */
const watchEvery = 3_000;

/**
 * Calls `refresh` whenever the world of the sandbox may have changed
 * without this screen: a delivery of the workspace has moved on, which
 * posts to a feed and uses up a fault, also one that another window
 * published. And when the connection is back or the person is, for what
 * was missed meanwhile. The world is not synced, so the screens of the
 * simulator ask for it again then.
 *
 * A delivery does not always say what it has done in the world: a network
 * that asks to be tried again has used up a fault, or has taken a post
 * and lost its answer, and the workflow then waits a minute or more
 * without a change of the workspace. So while a delivery is being sent,
 * and only then, the world is also asked for every few seconds, unless a
 * request is on its way already, which `busy` says, or nobody could see
 * the answer or get one.
 *
 * `refresh` has to be the same function on every render, as the one of
 * `useFetched` is.
 */
export function useWorldChanges(refresh: () => void, busy: boolean): void {
  const deliveries = useSynced(selectDeliveries);
  const before = useRef(deliveries);
  useEffect(() => {
    if (before.current === deliveries) return;
    before.current = deliveries;
    refresh();
  }, [deliveries, refresh]);

  const sending = useSynced(selectSending);
  const watch = useEffectEvent(() => {
    // A window that comes back and a connection that does ask by
    // themselves, below.
    if (busy || document.visibilityState !== "visible" || !navigator.onLine) {
      return;
    }
    refresh();
  });
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(watch, watchEvery);
    return () => clearInterval(timer);
  }, [sending]);

  useOnline(refresh);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
}
