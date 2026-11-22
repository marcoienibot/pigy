import {
  type ApiPost,
  type ApiScope,
  apiPostSchema,
  type CreateApiKeyResponse,
  createApiKeyResponseSchema,
  type ErrorResponse,
  errorResponseSchema,
  grantableApiScopes,
} from "@pigy/core";
import { expect, vi } from "vitest";
import type { Browser, TestSetup } from "./helpers.ts";
import { patience, started } from "./publishing.ts";

/**
 * What the tests of the public API share: making a key as a person does in
 * the settings, and calling the API with it as a script does.
 */

/**
 * A limiter that lets everything through, for `rateLimiter` of `setup()`.
 * A test that waits for a delivery asks the API many times in a second,
 * which is not what it is about: the tests of the limit count for
 * themselves.
 */
export const unlimited: RateLimit = {
  limit: async () => ({ success: true }),
};

/** `started()`, with keys that are not held to a number of requests. */
export const startedApi = (options: Parameters<typeof started>[0] = {}) =>
  started({ rateLimiter: unlimited, ...options });

/** Makes a key of `workspaceId` as `browser`, which has to be signed in. */
export async function makeKey(
  browser: Browser,
  workspaceId: string,
  options: {
    name?: string;
    scopes?: ApiScope[];
    expiresAt?: number | null;
  } = {},
): Promise<CreateApiKeyResponse> {
  const response = await browser.fetch(
    `/api/workspaces/${workspaceId}/api-keys`,
    {
      method: "POST",
      json: {
        name: options.name ?? "A script",
        scopes: options.scopes ?? [...grantableApiScopes],
        expiresAt: options.expiresAt ?? null,
      },
    },
  );
  expect(response.status).toBe(201);
  return createApiKeyResponseSchema.parse(await response.json());
}

export type ApiRequest = {
  method?: string;
  json?: unknown;
  /** Replace or add headers. Null leaves one out. */
  headers?: Record<string, string | null>;
};

/**
 * A client of the API that sends `secret` as its key, the way a script
 * does: with no cookie and no `Origin`.
 */
export function apiClient(test: Pick<TestSetup, "browser">, secret: string) {
  const call = (path: string, init: ApiRequest = {}) =>
    // A browser of its own every time: it has no cookies, and keeps none.
    test.browser().fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        Origin: null,
        ...init.headers,
      },
    });
  /** Makes a call that has to succeed with `status`, and returns its body. */
  const ok = async (path: string, init: ApiRequest = {}, status = 200) => {
    const response = await call(path, init);
    const body: unknown = await response.json();
    expect(body, JSON.stringify(body)).not.toHaveProperty("error");
    expect(response.status).toBe(status);
    return body;
  };
  /** Makes a call that has to be refused with `status`, and returns why. */
  const refused = async (
    path: string,
    init: ApiRequest,
    status: number,
  ): Promise<ErrorResponse> => {
    const response = await call(path, init);
    const body = errorResponseSchema.strict().parse(await response.json());
    expect(response.status, body.message).toBe(status);
    return body;
  };
  /** The post `id`, in the strict shape that the document promises. */
  const post = async (id: string): Promise<ApiPost> =>
    apiPostSchema.parse(await ok(`/posts/${id}`));
  return {
    call,
    ok,
    refused,
    post,
    /** Creates a post, which has to be taken. */
    create: async (json: unknown, headers: ApiRequest["headers"] = {}) =>
      apiPostSchema.parse(
        await ok("/posts", { method: "POST", json, headers }, 201),
      ),
    /** Asks for the post `id` until it has left `sending`. */
    ended: (id: string): Promise<ApiPost> =>
      vi.waitFor(async () => {
        const found = await post(id);
        expect(["sending", "scheduled"]).not.toContain(found.status);
        return found;
      }, patience),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
