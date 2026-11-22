/** What the handlers of the simulated LinkedIn answer with. */

import { json } from "../world/index.ts";

export { html, json, oauthError } from "../world/index.ts";

/** An answer without a body, as a post that was made or deleted gets. */
export function empty(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

/**
 * An error of the API, as LinkedIn's "Error handling" has it: the status
 * again, a message, and for some a number of the service.
 */
export function apiError(
  status: number,
  message: string,
  more: Record<string, unknown> = {},
): Response {
  return json(status, { ...more, message, status });
}

/**
 * The parameters of a form in the body of a request, or undefined if the
 * body is no form: LinkedIn's OAuth endpoints take
 * `application/x-www-form-urlencoded` and nothing else.
 */
export async function formParams(
  request: Request,
): Promise<URLSearchParams | undefined> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  const params = new URLSearchParams();
  for (const [name, value] of await request.formData()) {
    if (typeof value === "string") params.append(name, value);
  }
  return params;
}
