import { html, json } from "../world/index.ts";
import type { Operation, State } from "./state.ts";

export { html, json, oauthError } from "../world/index.ts";

/** What the handlers of the simulated Bluesky answer with. */

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

/** What `fetch` does when the connection breaks after the work is done. */
export function lose(): never {
  throw new TypeError("The simulated Bluesky lost its answer on the way back");
}

/**
 * The header with which a server refuses a request for its proof of DPoP
 * or its token, RFC 9449 section 7.1.
 */
export function dpopChallenge(error: string, description: string): string {
  return `DPoP error="${error}", error_description="${description.replaceAll('"', "'")}"`;
}

/** What a server that is not one of the HTTP API says to a client that asks too often. */
const tooManyRequests = () =>
  json(429, { message: "Too Many Requests" }, { "Retry-After": "60" });

/**
 * Answers a request that carries no token, with what such a request can
 * suffer from: the page of the proxy of a server that is down, `limited`
 * for a client that asks too often, and an answer that is lost on its way
 * back after the work is done.
 */
export async function withFaults(
  state: State,
  operation: Operation,
  respond: () => Response | Promise<Response>,
  limited: () => Response = tooManyRequests,
): Promise<Response> {
  const fault = state.takeFault(
    operation,
    ["rate-limit", "server-error", "lost-response"],
    false,
  );
  if (fault === "server-error") return gatewayError();
  if (fault === "rate-limit") return limited();
  const response = await respond();
  if (fault === "lost-response") lose();
  return response;
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
