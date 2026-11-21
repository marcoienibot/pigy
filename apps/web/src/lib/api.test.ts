import { afterEach, expect, it, vi } from "vitest";
import { answeredInTime, answerWithinMs, fetchMe, unanswered } from "./api.ts";

// What decides whether the app says "pigy cannot reach its server", and
// waits for the connection, or says that something went wrong: the error
// that a call to the API fails with, as `unanswered` reads it.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What `fetchMe` fails with when `fetch` does what `answer` does. */
async function failureOf(answer: () => Promise<Response>): Promise<unknown> {
  vi.stubGlobal("fetch", answer);
  return fetchMe().then(
    (me) => {
      throw new Error(`fetchMe did not fail: ${JSON.stringify(me)}`);
    },
    (error: unknown) => error,
  );
}

it("takes a request that got no answer for a server that cannot be reached", async () => {
  // What `fetch` does without a connection, in every browser.
  const failure = await failureOf(() =>
    Promise.reject(new TypeError("Failed to fetch")),
  );

  expect(unanswered(failure)).toBe(true);
});

it.each([
  [
    "says that something went wrong",
    () =>
      Response.json(
        { error: "UnexpectedError", message: "Something went wrong" },
        { status: 500 },
      ),
  ],
  [
    // What a proxy in front of the server puts in the place of an answer.
    "is a page",
    () =>
      new Response("<html><body>Bad gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  ],
  ["is not what the API sends", () => Response.json({ user: "somebody" })],
])(
  "does not take an answer that %s for a server that cannot be reached",
  async (_name, answer) => {
    const failure = await failureOf(async () => answer());

    expect(unanswered(failure)).toBe(false);
  },
);

it("does not take a mistake in the code of the app for a server that cannot be reached", async () => {
  // An answer that the code reads wrongly, as a bug would: a `TypeError`
  // that is the app's own and not what `fetch` fails with. Taken for a
  // missing connection, it would have the app wait for one for ever.
  const failure = await failureOf(async () => ({ ok: true }) as Response);

  expect(failure).toBeInstanceOf(TypeError);
  expect(unanswered(failure)).toBe(false);
});

/**
 * A network that takes a request and never answers it: `fetch` settles
 * only when the request is given up, as a browser's does. With the timer
 * that `answeredInTime` asked for, which the test runs when it says.
 */
function silentNetwork() {
  const timers: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  const requests: AbortSignal[] = [];
  vi.stubGlobal("fetch", (_path: string, init: RequestInit = {}) => {
    const signal = init.signal;
    if (!signal) throw new Error("A request that nothing can give up");
    requests.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  });
  return {
    timers,
    requests,
    schedule(run: () => void, delayMs: number) {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
}

it("gives a question up that the server has not answered in time, as one that got no answer", async () => {
  const network = silentNetwork();
  const asked = answeredInTime(fetchMe, undefined, network.schedule);
  const failure = asked.catch((error: unknown) => error);
  expect(network.timers.map(({ delayMs }) => delayMs)).toEqual([
    answerWithinMs,
  ]);

  // The time is up.
  network.timers[0]?.run();

  // Which is what the sign-in page and the start of the app say "pigy
  // cannot reach its server" for, and try again by.
  expect(unanswered(await failure)).toBe(true);
  // The request is not left open behind the page.
  expect(network.requests.map(({ aborted }) => aborted)).toEqual([true]);
});

it("does not take a question that the app gave up for a server that cannot be reached", async () => {
  const network = silentNetwork();
  const navigation = new AbortController();
  const asked = answeredInTime(fetchMe, navigation.signal, network.schedule);
  const failure = asked.catch((error: unknown) => error);

  // The router gives a navigation up when the person goes elsewhere.
  navigation.abort();

  // The error is the one of the request, which the router knows.
  const error = await failure;
  expect(unanswered(error)).toBe(false);
  expect(error).toBe(navigation.signal.reason);
  // Nothing is left that would run later.
  expect(network.timers.map(({ cancelled }) => cancelled)).toEqual([true]);
});

it("leaves an answer that comes in time as it is, and stops the clock", async () => {
  const timers: { cancelled: boolean }[] = [];
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { error: "Unauthorized", message: "Not signed in" },
      { status: 401 },
    ),
  );

  const me = await answeredInTime(fetchMe, undefined, () => {
    const timer = { cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  });

  // What `fetchMe` makes of a 401: nobody is signed in.
  expect(me).toBeNull();
  // A timer that ran on would give up nothing, and still keep the page
  // from being put aside by the browser for ten seconds.
  expect(timers).toEqual([{ cancelled: true }]);
});

it("gives the time to all that is asked, and not to each request", async () => {
  const network = silentNetwork();
  // Two requests one after the other, as the check of a session makes:
  // the first is answered, the second never.
  let first = true;
  const { fetch: silent } = globalThis;
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (!first) return silent(path, init);
    first = false;
    return Promise.resolve(
      Response.json(
        { error: "Unauthorized", message: "Not signed in" },
        { status: 401 },
      ),
    );
  });
  const asked = answeredInTime(
    async (signal) => [await fetchMe(signal), await fetchMe(signal)],
    undefined,
    network.schedule,
  );
  const failure = asked.catch((error: unknown) => error);
  // Until the second request is on its way.
  await vi.waitFor(() => expect(network.requests).toHaveLength(1));

  // One timer for both, which gives up the one that is open.
  expect(network.timers).toHaveLength(1);
  network.timers[0]?.run();
  expect(unanswered(await failure)).toBe(true);
});
