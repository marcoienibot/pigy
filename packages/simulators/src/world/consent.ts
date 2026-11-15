import type { Fetch } from "@pigy/core";

/**
 * Answers the consent page of a simulated network the way a person would,
 * without a browser: connects the account with the ID `account`, or
 * declines. `authorizationUrl` is where an adapter would send the browser,
 * `fetch` the simulator's.
 *
 * Returns where the network sends the browser back to: the callback address
 * with its parameters.
 */
export async function answerConsent(
  fetch: Fetch,
  authorizationUrl: string | URL,
  answer: { account: string } | "deny",
): Promise<URL> {
  const response = await fetch(authorizationUrl, {
    method: "POST",
    body: new URLSearchParams(
      answer === "deny" ? { action: "deny" } : { account: answer.account },
    ),
  });
  const location = response.headers.get("Location");
  if (response.status !== 302 || !location) {
    throw new Error(
      `The simulated network did not send the browser back. It answered ${response.status}: ${await response.text()}`,
    );
  }
  return new URL(location);
}
