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
  /**
   * Asks again, in place of a request that is on its way. While a change
   * is on its way, it asks once the change has been answered.
   */
  refresh: () => void;
  /**
   * Makes `request`, which changes what was fetched and answers with what
   * it left, and takes that for the answer. Fails as the request does.
   */
  change: (request: () => Promise<Data>) => Promise<void>;
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
 * What is on screen is never older than an answer that was on screen
 * before, also where the screen changes what it fetched, with `change`.
 * The answers of a change and of a read that are on their way together
 * can arrive in either order, and nobody can tell which of them the
 * server made last. So the two are never on their way together: a read
 * that is asked for during a change waits for its answer, and a read that
 * a change finds on its way is given up and made again after it.
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
  // The read that is on its way, if one is.
  const reading = useRef<AbortController>(null);
  // How many changes are on their way, and whether a read is owed once
  // they have been answered.
  const changing = useRef(0);
  const owed = useRef(false);
  // The component has gone: nothing is asked for it any more.
  const gone = useRef(false);

  const refresh = useCallback(() => {
    if (gone.current) return;
    if (changing.current > 0) {
      owed.current = true;
      return;
    }
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setState((before) => ({ ...before, loading: true }));
    request(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        reading.current = null;
        setState({ data, failure: null, loading: false });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        reading.current = null;
        checkSignedOut(failure);
        setState((before) => ({ ...before, failure, loading: false }));
      },
    );
  }, [request]);

  useEffect(() => {
    gone.current = false;
    refresh();
    return () => {
      gone.current = true;
      reading.current?.abort();
      reading.current = null;
    };
  }, [refresh]);

  const change = useCallback(
    async (request: () => Promise<Data>) => {
      if (reading.current) {
        // Its answer could be from before the change or from after it.
        reading.current.abort();
        reading.current = null;
        owed.current = true;
      }
      changing.current += 1;
      try {
        const data = await request();
        if (!gone.current) {
          setState((before) => ({ ...before, data, failure: null }));
        }
      } finally {
        changing.current -= 1;
        if (changing.current === 0 && owed.current) {
          owed.current = false;
          refresh();
        }
      }
    },
    [refresh],
  );

  return { ...state, refresh, change };
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
