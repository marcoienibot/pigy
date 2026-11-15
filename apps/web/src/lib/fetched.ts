import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, unanswered } from "@/lib/api";
import { checkSession } from "@/lib/session";

/** What a screen has of something that it asks the server for. */
export type Fetched<Data> = {
  /** The last answer, or null before the first one. */
  data: Data | null;
  /** Why the last request failed, or null if it did not. */
  failure: unknown;
  /** A request is on its way. */
  loading: boolean;
  /** Asks again, in place of a request that is on its way. */
  refresh: () => void;
  /** Takes `data` for the answer, as from a request that changed it. */
  replace: (data: Data) => void;
};

/**
 * Asks the server with `request` when the component is shown, and again
 * whenever `refresh` is called. For what is not synced, such as the world
 * of a sandbox: a screen that reads synced data reads the local copy.
 *
 * A request that a newer one takes the place of, or that is still on its
 * way when the component goes, is given up, and its answer is not used:
 * a screen that is made anew for the other workspace holds nothing of the
 * one before.
 *
 * `request` has to be the same function on every render: one that is
 * declared outside the component.
 */
export function useFetched<Data>(
  request: (signal: AbortSignal) => Promise<Data>,
): Fetched<Data> {
  const [state, setState] = useState<{
    data: Data | null;
    failure: unknown;
    loading: boolean;
  }>({ data: null, failure: null, loading: true });
  const current = useRef<AbortController>(null);

  const refresh = useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState((before) => ({ ...before, loading: true }));
    request(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ data, failure: null, loading: false });
        }
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        checkSignedOut(failure);
        setState((before) => ({ ...before, failure, loading: false }));
      },
    );
  }, [request]);

  useEffect(() => {
    refresh();
    return () => current.current?.abort();
  }, [refresh]);

  const replace = useCallback((data: Data) => {
    // An answer that is on its way is from before the change.
    current.current?.abort();
    setState({ data, failure: null, loading: false });
  }, []);

  return { ...state, refresh, replace };
}

/**
 * What to tell the person of a request to the API that failed: that the
 * server cannot be reached, or what it answered.
 */
export function failureMessage(failure: unknown): string {
  if (unanswered(failure)) {
    return "pigy cannot reach its server. Check your connection and try again.";
  }
  if (failure instanceof ApiError) return failure.message;
  return "Something went wrong. Try again.";
}

/**
 * Has the app find out whether the session has ended, when `failure` says
 * that nobody is signed in: it leaves for the sign-in page once the server
 * has said so.
 */
export function checkSignedOut(failure: unknown): void {
  if (failure instanceof ApiError && failure.status === 401) {
    void checkSession();
  }
}
