/** What the handlers of the simulated Mastodon answer with. */

import { json } from "../world/index.ts";

export { html, json, oauthError } from "../world/index.ts";

/** An error of the API: entities/Error. */
export function apiError(status: number, error: string): Response {
  return json(status, { error });
}

/** The parameters of a request: a value, or a list of values. */
export type Params = Record<string, unknown>;

/**
 * The parameters in the body of a request. Mastodon reads JSON and both
 * kinds of form, and so does this. Anything else has no parameters.
 */
export async function bodyParams(request: Request): Promise<Params> {
  const type = request.headers.get("Content-Type") ?? "";
  if (type.startsWith("application/json")) {
    try {
      const body: unknown = await request.json();
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Params)
        : {};
    } catch {
      return {};
    }
  }
  if (
    type.startsWith("application/x-www-form-urlencoded") ||
    type.startsWith("multipart/form-data")
  ) {
    const params: Params = {};
    for (const [name, value] of await request.formData()) {
      if (typeof value !== "string") continue;
      // A name that ends in "[]" is a list.
      if (name.endsWith("[]")) {
        const key = name.slice(0, -2);
        const list = params[key];
        params[key] = Array.isArray(list) ? [...list, value] : [value];
      } else {
        params[name] = value;
      }
    }
    return params;
  }
  return {};
}

/** A parameter as text, or undefined if it is absent or empty. */
export function text(params: Params, name: string): string | undefined {
  const value = params[name];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}
