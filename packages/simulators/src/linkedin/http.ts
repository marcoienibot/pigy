/** What the handlers of the simulated LinkedIn answer with. */

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

/** An error of the OAuth endpoints. */
export function oauthError(
  status: number,
  error: string,
  description: string,
): Response {
  return json(status, { error, error_description: description });
}

export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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
  return new URLSearchParams(await request.text());
}
