import type { SimWorld } from "../world/index.ts";

/** What the handlers of the simulated Threads answer with. */

export function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

/** What makes an error of the Graph API. */
export type GraphError = {
  /** The HTTP status. 400 unless given, as most errors of the API have. */
  status?: number;
  message: string;
  /** `OAuthException` unless given. */
  type?: string;
  code: number;
  subcode?: number;
  /** Whether the API says that the same request may work later. */
  transient?: boolean;
};

/**
 * An error as the Graph API answers with: `error`, with a message, a type,
 * a code, for some a subcode, and an ID to trace the request by.
 */
export function graphError(
  world: SimWorld,
  {
    status = 400,
    message,
    type = "OAuthException",
    code,
    subcode,
    transient,
  }: GraphError,
): Response {
  return json(status, {
    error: {
      message,
      type,
      code,
      ...(subcode !== undefined && { error_subcode: subcode }),
      ...(transient && { is_transient: true }),
      // An ID that says nothing, in the form of Meta's.
      fbtrace_id: `A${world.nextNumber().toString(36).padStart(21, "x")}`,
    },
  });
}

/**
 * An error of `POST /oauth/access_token`, which is not in the form of the
 * rest of the API. GUESS: this form is that of the same endpoint of
 * Instagram's API, which the Threads API was made after.
 */
export function oauthError(message: string, code = 400): Response {
  return json(code, {
    error_type: "OAuthException",
    code,
    error_message: message,
  });
}

/**
 * The parameters of a request: those of its address and, for a request
 * with a form as its body, those of the form, as the Graph API reads them.
 * Undefined if the request has a body that is no form.
 */
export async function parameters(
  request: Request,
): Promise<URLSearchParams | undefined> {
  const params = new URLSearchParams(new URL(request.url).search);
  const type = request.headers.get("Content-Type");
  if (type === null || request.method === "GET") return params;
  // GUESS: the Graph API takes JSON and multipart forms too. They are not
  // simulated, and refused.
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  for (const [name, value] of await request.formData()) {
    if (typeof value === "string") params.set(name, value);
  }
  return params;
}
