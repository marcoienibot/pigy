/**
 * The answers that every simulated service gives the same way. What is
 * one service's own, such as the errors of its API, is with that service.
 */

/** An answer with a body of JSON, which nothing may keep. */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/** A page. */
export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** An error of an OAuth endpoint, as RFC 6749 has it. */
export function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error, error_description: description }, headers);
}
