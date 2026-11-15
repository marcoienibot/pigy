import { useEffect, useEffectEvent } from "react";

/**
 * Calls `handle` when the browser says that the device has a connection
 * again. For a screen that has said that it cannot reach the server, to
 * try once more without being asked.
 */
export function useOnline(handle: () => void): void {
  const onOnline = useEffectEvent(handle);
  useEffect(() => {
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);
}
