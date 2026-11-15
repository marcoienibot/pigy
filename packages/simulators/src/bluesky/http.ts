/** What the handlers of the simulated Bluesky answer with. */

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

/**
 * An error of the HTTP API, as the specification of XRPC has it: the name
 * of the error and a description for people.
 */
export function xrpcError(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error, message }, headers);
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

export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * What the proxy in front of a server that is down answers: a page, not
 * the JSON of the API. The specification of XRPC warns clients of it.
 */
export function gatewayError(): Response {
  return html(
    502,
    "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>",
  );
}

/**
 * The parameters in the body of a request to an OAuth endpoint: a form, or
 * JSON. Anything else has none.
 */
export async function bodyParams(
  request: Request,
): Promise<Record<string, string>> {
  const type = request.headers.get("Content-Type") ?? "";
  const params: Record<string, string> = {};
  if (type.startsWith("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return params;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return params;
    }
    for (const [name, value] of Object.entries(body)) {
      if (typeof value === "string") params[name] = value;
    }
    return params;
  }
  if (type.startsWith("application/x-www-form-urlencoded")) {
    for (const [name, value] of new URLSearchParams(await request.text())) {
      params[name] = value;
    }
  }
  return params;
}

/** The JSON object in the body of a request, or undefined. */
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  if (
    !(request.headers.get("Content-Type") ?? "").startsWith("application/json")
  ) {
    return undefined;
  }
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
