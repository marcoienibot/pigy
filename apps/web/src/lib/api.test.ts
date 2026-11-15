import { afterEach, expect, it, vi } from "vitest";
import { fetchMe, unanswered } from "./api.ts";

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
