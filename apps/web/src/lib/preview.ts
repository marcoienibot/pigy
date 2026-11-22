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
 * asks each once. It is kept in the memory of the page and nowhere else:
 * not on the device, and not by the service worker.
 *
 * An answer that says "yes", a card or an account, is kept for as long as
 * the editor is there. One that says "no" is kept for some minutes,
 * `noLastsMs`: the page may be up again, the account may have been made,
 * and a lookup that failed at the network is answered as no account too.
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
 * the minute. And the longest that it waits. See `askAgainAfter`.
 */
export const askAgainAfterMs = 60_000;
export const askAgainAtMostMs = 8 * 60_000;

/**
 * How long the editor waits before it asks again, after the server has
 * said `refusals` times in a row that it was asked too often: a minute,
 * then twice as long each time, up to `askAgainAtMostMs`. It goes on
 * asking for as long as the question is there, because what it says in
 * place of a preview promises that. The pause grows because the minute
 * of the server can be used up from elsewhere all the time, by another
 * tab or another device of the person, and every part of a thread that
 * waits asks on its own: they would otherwise use it up together, every
 * minute, for ever.
 */
export const askAgainAfter = (refusals: number) =>
  Math.min(askAgainAfterMs * 2 ** Math.max(0, refusals - 1), askAgainAtMostMs);

/**
 * How long an answer that says "no" is kept, in milliseconds: that a
 * page has no card, that a handle is nobody's.
 */
export const noLastsMs = 5 * 60_000;

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
  limit: `No preview for the moment: pigy makes ${previewsPerMinute} a minute for one person. It is asked for again by itself, in a minute at first.`,
  failed: "No preview: pigy could not ask about the page.",
};

/** What `Answers` is told about its answers. */
export type AnswersOptions<Answer> = {
  /**
   * How long `answer` is kept, in milliseconds, or null for as long as
   * the editor is there. Without it every answer is kept that long.
   */
  lasts?: (answer: Answer) => number | null;
  /** The time, in milliseconds: the device's unless a test says otherwise. */
  now?: () => number;
};

/**
 * The answers to the questions of one editor, by a key that names the
 * question. A question is asked once, however many ask it and however
 * often: while it is on its way, everybody waits for the same answer, and
 * once it is answered, the answer is handed out. A question that failed
 * is not kept, so that it is asked again the next time.
 *
 * An answer can have an end, by `lasts`: from then on it is due, and the
 * next who asks sends the question again. Until that is answered, the
 * answer of before is still handed out by `kept`, so that nothing on
 * screen changes for a question whose answer stays the same.
 */
export class Answers<Answer> {
  readonly #answered = new Map<
    string,
    { answer: Answer; until: number | null }
  >();
  readonly #asking = new Map<string, Promise<Answer>>();
  readonly #lasts: (answer: Answer) => number | null;
  readonly #now: () => number;

  constructor({
    lasts = () => null,
    now = () => Date.now(),
  }: AnswersOptions<Answer> = {}) {
    this.#lasts = lasts;
    this.#now = now;
  }

  /**
   * What was answered for `key`, if it was, and until when that is good,
   * in milliseconds: null for an answer that has no end.
   */
  kept(key: string): { answer: Answer; until: number | null } | undefined {
    return this.#answered.get(key);
  }

  /** Whether `key` is to be asked: it has no answer, or one whose time is over. */
  due(key: string): boolean {
    const kept = this.#answered.get(key);
    return !kept || (kept.until !== null && kept.until <= this.#now());
  }

  /** Keeps `answer` for `key`, as if it had been asked for. */
  keep(key: string, answer: Answer): void {
    const lasts = this.#lasts(answer);
    this.#answered.set(key, {
      answer,
      until: lasts === null ? null : this.#now() + lasts,
    });
  }

  /**
   * Says which questions are there to be asked now: the keys that the
   * texts of the editor hold. An answer with an end is forgotten when
   * its key is not among them. So a link or a handle that has left the
   * text and is typed anew is asked about anew, and not answered with
   * the "no" of before, which whoever types it again does not believe.
   */
  present(keys: Iterable<string>): void {
    const present = new Set(keys);
    for (const [key, { until }] of this.#answered) {
      if (until !== null && !present.has(key)) this.#answered.delete(key);
    }
  }

  /** The answer for `key`: the one that is kept or on its way, or `ask`'s. */
  ask(key: string, ask: () => Promise<Answer>): Promise<Answer> {
    const kept = this.#answered.get(key);
    if (kept && !this.due(key)) return Promise.resolve(kept.answer);
    return this.#asking.get(key) ?? this.#begin(key, ask());
  }

  /**
   * Has every one of `keys` answered: with one question, `ask`, for those
   * that have neither an answer nor a question on its way. `ask` is
   * handed those keys, and answers with what says the answer of each.
   * So two that ask at once about lists that share a key ask about that
   * key once. Fails if a question fails that one of `keys` waits for.
   */
  async askAll(
    keys: readonly string[],
    ask: (keys: string[]) => Promise<(key: string) => Answer>,
  ): Promise<void> {
    const missing = keys.filter(
      (key) => this.due(key) && !this.#asking.has(key),
    );
    if (missing.length > 0) {
      const asked = ask(missing);
      for (const key of missing) {
        this.#begin(
          key,
          asked.then((answerOf) => answerOf(key)),
        );
      }
    }
    await Promise.all(keys.map((key) => this.#asking.get(key)));
  }

  /** Takes `asking` for the question about `key` that is on its way. */
  #begin(key: string, asking: Promise<Answer>): Promise<Answer> {
    const answered = asking.then(
      (answer) => {
        this.keep(key, answer);
        this.#asking.delete(key);
        return answer;
      },
      (error: unknown) => {
        this.#asking.delete(key);
        // An answer whose time is over is not handed out in place of a
        // question that got none: what is said then is that nobody
        // answered.
        if (this.due(key)) this.#answered.delete(key);
        throw error;
      },
    );
    this.#asking.set(key, answered);
    // Somebody waits for it, or it is one of several whose failure
    // another of them reports.
    answered.catch(() => {});
    return answered;
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

/** A question as `useQuestion` asks it. */
type Question = {
  /** Whether there is anything to ask. */
  due: () => boolean;
  /** When what is answered is to be asked again, or null for never. */
  until: () => number | null;
  /** Asks. Fails if no answer came. */
  ask: () => Promise<unknown>;
};

/**
 * Asks `question` for as long as `key` stays, which names it, and says
 * why it got no answer, or null. Null for `key` asks nothing.
 *
 * A question that is due is asked a moment after `key` has last changed,
 * `askAfterMs`. One that got no answer is asked again when there is
 * reason to think that it would get one: when the browser says that the
 * connection is back, and some time after the server has said that it
 * was asked too often, every time that it says so: `askAgainAfter`. And
 * one that was answered is asked again when the time of its answer is
 * over.
 */
function useQuestion(key: string | null, question: Question): Unasked | null {
  const [outcome, setOutcome] = useState<{
    key: string;
    why: Unasked | null;
    /** How often in a row the server has said that it was asked too often. */
    refusals: number;
  }>();
  // Counts the times that the question is asked again.
  const [again, setAgain] = useState(0);
  const failed = outcome?.key === key ? outcome.why : null;
  const refusals = outcome?.key === key ? outcome.refusals : 0;
  useOnline(() => {
    if (failed !== null) setAgain((count) => count + 1);
  });
  // After every refusal, and not only after the first: `refusals` grows
  // with each, where `failed` stays what it is.
  useEffect(() => {
    if (failed !== "limit") return;
    const timer = setTimeout(
      () => setAgain((count) => count + 1),
      askAgainAfter(refusals),
    );
    return () => clearTimeout(timer);
  }, [failed, refusals]);

  const until = key === null ? null : question.until();
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(
      () => setAgain((count) => count + 1),
      Math.max(0, until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [until]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `question` closes over what `key` stands for and is another object at every render, and `again` is there to ask once more.
  useEffect(() => {
    if (key === null || !question.due()) return;
    let gone = false;
    const timer = setTimeout(() => {
      question.ask().then(
        () => {
          if (!gone) setOutcome({ key, why: null, refusals: 0 });
        },
        (error: unknown) => {
          if (gone) return;
          const why = whyUnasked(error);
          setOutcome((before) => ({
            key,
            why,
            refusals:
              why !== "limit"
                ? 0
                : before?.key === key
                  ? before.refusals + 1
                  : 1,
          }));
        },
      );
    }, askAfterMs);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [key, again]);

  return failed;
}

/**
 * Asks the server with `ask` about what `key` names, through `answers`,
 * and hands out what came of it for as long as `key` stays. Null for
 * `key` asks nothing.
 *
 * An answer that `answers` keeps is handed out at once, also what
 * another part has asked for. When and how often the question is asked
 * is `useQuestion`'s.
 */
export function useAsked<Answer>(
  answers: Answers<Answer>,
  key: string | null,
  ask: () => Promise<Answer>,
): Asked<Answer> {
  const failed = useQuestion(key, {
    due: () => key !== null && answers.due(key),
    until: () => (key === null ? null : (answers.kept(key)?.until ?? null)),
    ask: () => (key === null ? Promise.resolve() : answers.ask(key, ask)),
  });
  if (key === null) return waiting;
  const kept = answers.kept(key);
  if (kept) return { state: "answered", answer: kept.answer };
  return failed === null ? waiting : { state: "unasked", why: failed };
}

/**
 * Has the server asked with `ask` about each of `keys` that `answers`
 * has no answer for and no question on its way, with one question for
 * all of those: see `Answers.askAll`. The answers are read from
 * `answers`, by whoever calls this, which renders again when one came.
 */
export function useAskedAll<Answer>(
  answers: Answers<Answer>,
  keys: readonly string[],
  ask: (keys: string[]) => Promise<(key: string) => Answer>,
): void {
  useQuestion(keys.length > 0 ? keys.join(" ") : null, {
    due: () => keys.some((key) => answers.due(key)),
    // The first of them that is to be asked again.
    until: () => {
      const ends = keys.flatMap((key) => answers.kept(key)?.until ?? []);
      return ends.length > 0 ? Math.min(...ends) : null;
    },
    ask: () => answers.askAll(keys, ask),
  });
}
