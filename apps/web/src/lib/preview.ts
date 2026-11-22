import { useEffect, useRef, useState } from "react";

/**
 * How long the editor waits after the last change before it asks the
 * server about what is typed, in milliseconds: an address is typed letter
 * by letter, and each letter makes another address of it.
 */
export const askAfterMs = 500;

/** What the editor has of a question that it asked the server. */
export type Asked<Answer> = {
  /** The answer, or null while there is none: not asked, or asked in vain. */
  answer: Answer | null;
  /** The question was asked and answered, or failed: nothing is on its way. */
  settled: boolean;
};

const unasked = { answer: null, settled: false };

/**
 * Asks the server with `ask` about what `key` names, a moment after `key`
 * has last changed, and hands out the answer for as long as `key` stays.
 * Null for `key` asks nothing. For what the editor shows of a text before
 * it goes out, such as the card of a link: the answer is kept nowhere but
 * in the component, and goes with it.
 *
 * A question that cannot be asked or is refused has no answer, and says
 * so nowhere: the device is offline, or it has asked too often. What it
 * was asked for is something to see before publishing, and nothing that
 * publishing waits for.
 */
export function useAsked<Answer>(
  key: string | null,
  ask: (signal: AbortSignal) => Promise<Answer>,
): Asked<Answer> {
  const [state, setState] = useState<{ key: string } & Asked<Answer>>();
  // The newest `ask`: it closes over what `key` stands for.
  const asking = useRef(ask);
  asking.current = ask;
  useEffect(() => {
    if (key === null) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      asking.current(request.signal).then(
        (answer) => {
          if (!request.signal.aborted) {
            setState({ key, answer, settled: true });
          }
        },
        () => {
          if (!request.signal.aborted) {
            setState({ key, answer: null, settled: true });
          }
        },
      );
    }, askAfterMs);
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [key]);
  // An answer is that of the key that it was asked for, and of no other.
  return state && state.key === key ? state : unasked;
}
