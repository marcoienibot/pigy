import { previewsPerMinute } from "@pigy/core";
import { useEffect, useState } from "react";
import { ApiError, unanswered } from "@/lib/api";
import { useOnline } from "@/lib/online";

/**
 * What the editor of a draft asks the server about a text before it goes
 * out: the card of a link, and which handles are accounts. Something to
 * see before publishing, and nothing that publishing waits for.
 *
 * The parts of a text ask on their own, and a thread asks the same thing
 * many times: its parts lead to the same page, and mention the same
 * people. So the questions of an editor go through one `Answers`, which
 * asks each once and keeps what was answered for as long as the editor
 * is there. It is kept in the memory of the page and nowhere else: not on
 * the device, and not by the service worker.
 */

/**
 * How long the editor waits after the last change before it asks the
 * server about what is typed, in milliseconds: an address is typed letter
 * by letter, and each letter makes another address of it.
 */
export const askAfterMs = 500;

/**
 * How long the editor waits before it asks again after the server has
 * said that it was asked too often, in milliseconds: the server counts by
 * the minute.
 */
export const askAgainAfterMs = 60_000;

/** Why a question got no answer. */
export type Unasked =
  /** No answer came: the device has no connection, or the server is away. */
  | "offline"
  /** The server makes no more previews for this person this minute. */
  | "limit"
  /** The server answered that something went wrong. */
  | "failed";

/** Why the question that failed with `error` got no answer. */
export function whyUnasked(error: unknown): Unasked {
  // What `fetch` fails with when no answer comes, and what the app makes
  // of a request that it gave up waiting for.
  if (error instanceof TypeError || unanswered(error)) return "offline";
  if (error instanceof ApiError && error.status === 429) return "limit";
  return "failed";
}

/**
 * What a question that got no answer says in place of a preview. That
 * the page could not be read is not among these: nobody has tried.
 */
export const unaskedNote: Record<Unasked, string> = {
  offline:
    "No preview without a connection to pigy. It is asked for again when the connection is back.",
  limit: `No preview for the moment: pigy makes ${previewsPerMinute} a minute for one person. It is asked for again in a minute.`,
  failed: "No preview: pigy could not ask about the page.",
};

/**
 * The answers to the questions of one editor, by a key that names the
 * question. A question is asked once, however many ask it and however
 * often: while it is on its way, everybody waits for the same answer, and
 * once it is answered, the answer is handed out. A question that failed
 * is not kept, so that it is asked again the next time.
 */
export class Answers<Answer> {
  readonly #answered = new Map<string, Answer>();
  readonly #asking = new Map<string, Promise<Answer>>();

  /** What was answered for `key`, if it was. */
  kept(key: string): { answer: Answer } | undefined {
    return this.#answered.has(key)
      ? { answer: this.#answered.get(key) as Answer }
      : undefined;
  }

  /** Keeps `answer` for `key`, as if it had been asked for. */
  keep(key: string, answer: Answer): void {
    this.#answered.set(key, answer);
  }

  /** The answer for `key`: the one that is kept or on its way, or `ask`'s. */
  ask(key: string, ask: () => Promise<Answer>): Promise<Answer> {
    const kept = this.kept(key);
    if (kept) return Promise.resolve(kept.answer);
    let asking = this.#asking.get(key);
    if (!asking) {
      asking = ask().then(
        (answer) => {
          this.#answered.set(key, answer);
          this.#asking.delete(key);
          return answer;
        },
        (error: unknown) => {
          this.#asking.delete(key);
          throw error;
        },
      );
      this.#asking.set(key, asking);
    }
    return asking;
  }
}

/** What the editor has of a question that it asked the server. */
export type Asked<Answer> =
  /** Not asked yet, or on its way: there is nothing to show. */
  | { state: "waiting" }
  | { state: "answered"; answer: Answer }
  /** It got no answer. Not the same as an answer that says "nothing". */
  | { state: "unasked"; why: Unasked };

const waiting = { state: "waiting" } as const;

/**
 * Asks the server with `ask` about what `key` names, through `answers`,
 * and hands out what came of it for as long as `key` stays. Null for
 * `key` asks nothing.
 *
 * An answer that `answers` keeps is handed out at once. Otherwise the
 * question is asked a moment after `key` has last changed, `askAfterMs`.
 * One that got no answer says why, and is asked again when there is
 * reason to think that it would get one: when the browser says that the
 * connection is back, and a minute after the server has said that it was
 * asked too often.
 */
export function useAsked<Answer>(
  answers: Answers<Answer>,
  key: string | null,
  ask: () => Promise<Answer>,
): Asked<Answer> {
  const [outcome, setOutcome] = useState<{ key: string } & Asked<Answer>>();
  // Counts the times that the question is asked again.
  const [again, setAgain] = useState(0);
  const failed =
    outcome?.key === key && outcome?.state === "unasked" ? outcome.why : null;
  useOnline(() => {
    if (failed !== null) setAgain((count) => count + 1);
  });
  useEffect(() => {
    if (failed !== "limit") return;
    const timer = setTimeout(
      () => setAgain((count) => count + 1),
      askAgainAfterMs,
    );
    return () => clearTimeout(timer);
  }, [failed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ask` closes over what `key` stands for and is another function at every render, and `again` is there to ask once more.
  useEffect(() => {
    if (key === null || answers.kept(key)) return;
    let gone = false;
    const timer = setTimeout(() => {
      answers.ask(key, ask).then(
        (answer) => {
          if (!gone) setOutcome({ key, state: "answered", answer });
        },
        (error: unknown) => {
          if (!gone) {
            setOutcome({ key, state: "unasked", why: whyUnasked(error) });
          }
        },
      );
    }, askAfterMs);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [answers, key, again]);

  if (key === null) return waiting;
  // What another part has asked for by now is this part's answer too.
  const kept = answers.kept(key);
  if (kept) return { state: "answered", answer: kept.answer };
  // An answer is that of the key that it was asked for, and of no other.
  return outcome && outcome.key === key ? outcome : waiting;
}
