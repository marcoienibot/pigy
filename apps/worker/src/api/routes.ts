import {
  type ApiOperation,
  type ApiOperationName,
  type ApiScope,
  apiOperations,
  apiRateLimit,
  apiTime,
  createPostRequestSchema,
  idempotencyKeySchema,
  idSchema,
  listPostsQuerySchema,
  maxApiBodyBytes,
  movePostRequestSchema,
  openApiDocument,
  putPostingScheduleRequestSchema,
  updatePostRequestSchema,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { readAdminEmails } from "../auth/config.ts";
import type { AppDependencies, Bindings } from "../env.ts";
import { InvalidField, parseInput } from "../errors.ts";
import type { ApiCall } from "../workspace/api.ts";
import { callWorkspaceApi } from "../workspace/workspaces.ts";
import { docsPage } from "./docs.ts";
import { type ApiKeyAuth, verifyApiKey } from "./keys.ts";

/**
 * The public API, under `/api/v1`. `@pigy/core` has its routes and their
 * shapes, `apiOperations`, and every route here is registered from that
 * list: the OpenAPI document is made from the same one.
 *
 * - A request is authenticated by its key, `Authorization: Bearer`, and by
 *   nothing else. The session cookie is never read here, so no page, of
 *   pigy or of anybody, can call the API as the person who looks at it.
 *   No answer has a CORS header, and a preflight finds no route: a page of
 *   another site cannot send the header that carries a key.
 * - A key reaches the one workspace that it belongs to. Every route takes
 *   the workspace from the key, and nothing in a request names one.
 * - What a route does in the workspace is one call into its Durable
 *   Object, `callWorkspaceApi`, which carries a write out as a whole or
 *   not at all, and once for an `Idempotency-Key`.
 */

/** The Hono environment of the routes of the API. */
type ApiEnv = {
  Bindings: Bindings;
  Variables: {
    /** Whom the key of the request acts for. Set by `withKey`. */
    api: ApiKeyAuth;
  };
};

type ApiContext = Context<ApiEnv>;

/** A SHA-256 of `text`, as hex. */
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The body of a request as text, read up to `maxApiBodyBytes` and no
 * further: a 413 for one that is longer.
 */
async function bodyText(c: ApiContext): Promise<string> {
  const tooLarge = () =>
    new HTTPException(413, {
      message: `The body is larger than ${maxApiBodyBytes / 1024} KiB`,
    });
  if (Number(c.req.header("Content-Length") ?? 0) > maxApiBodyBytes) {
    throw tooLarge();
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxApiBodyBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new HTTPException(400, { message: "The body must be JSON" });
  }
}

function parseBody<T>(text: string, schema: z.ZodType<T>): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "The body must be JSON" });
  }
  return parseInput(body, schema);
}

/**
 * What names the call of a request that came with `Idempotency-Key`, for
 * the workspace to carry it out once, or undefined for a request without
 * the header. The key is the API key's together with the header: two keys
 * that send the same header name two calls. `fingerprint` says which
 * request it was: the same header with another method, path or body is
 * another request, and is refused.
 */
async function repeatOf(
  c: ApiContext,
  body: string,
): Promise<{ key: string; fingerprint: string } | undefined> {
  const header = c.req.header("Idempotency-Key");
  if (header === undefined) return undefined;
  if (!idempotencyKeySchema.safeParse(header).success) {
    throw new HTTPException(400, {
      message:
        "Idempotency-Key must be 1 to 255 characters of ASCII without spaces",
    });
  }
  return {
    // The header as a digest: of one length whatever was sent.
    key: `api:${c.var.api.key.id}:${await digest(header)}`,
    fingerprint: await digest(
      `${c.req.method} ${new URL(c.req.url).pathname}\n${body}`,
    ),
  };
}

/** The ID in the path, or a 404: no row has an ID that is not one. */
function idOf(c: ApiContext, what: string): string {
  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) {
    throw new HTTPException(404, { message: `There is no such ${what}` });
  }
  return id.data;
}

/**
 * Refuses what the schemas of a post cannot say: which of `mode`, `dueAt`
 * and `saveToDraft` go together, and that there are no images yet.
 */
function checkSharing(
  body: {
    mode?: string | undefined;
    dueAt?: string | undefined;
    saveToDraft?: boolean | undefined;
    assets?: unknown[] | undefined;
  },
  modeRequired: boolean,
): void {
  if (body.assets && body.assets.length > 0) {
    throw new InvalidField(
      "assets",
      "assets: Images are not available yet: they come with a later version",
    );
  }
  if (modeRequired && !body.saveToDraft && body.mode === undefined) {
    throw new InvalidField(
      "mode",
      "mode: Say how to share the post, or save it as a draft with saveToDraft",
    );
  }
  if (body.mode === "customScheduled" && body.dueAt === undefined) {
    throw new InvalidField(
      "dueAt",
      "dueAt: A post with the mode customScheduled needs a time",
    );
  }
  if (body.dueAt !== undefined && body.mode !== "customScheduled") {
    throw new InvalidField(
      "dueAt",
      "dueAt: Only a post with the mode customScheduled takes a time",
    );
  }
}

/** The query of a request as `listPostsQuerySchema` has it. */
function postsQuery(c: ApiContext) {
  const { status, first, ...rest } = c.req.query();
  return parseInput(
    {
      // What is left is passed on as it is, for the schema to refuse a
      // parameter that the route does not have.
      ...rest,
      ...(status !== undefined && { status: status.split(",") }),
      ...(first !== undefined && {
        first: /^\d{1,6}$/.test(first) ? Number(first) : first,
      }),
    },
    listPostsQuerySchema,
  );
}

/** What a route makes of a request: the call into the workspace. */
type CallOf = (c: ApiContext, body: string) => ApiCall;

/**
 * The routes that do their work in the workspace of the key, by the name
 * of their operation. The compiler asks for every operation of
 * `apiOperations`, here or in `ownRoutes` below.
 */
const workspaceRoutes = {
  listChannels: () => ({ op: "listChannels" }),
  getChannel: (c) => ({ op: "getChannel", id: idOf(c, "channel") }),
  listPosts: (c) => ({ op: "listPosts", query: postsQuery(c) }),
  getPost: (c) => ({ op: "getPost", id: idOf(c, "post") }),
  createPost: (_, text) => {
    const body = parseBody(text, createPostRequestSchema);
    checkSharing(body, true);
    return { op: "createPost", body };
  },
  updatePost: (c, text) => {
    const id = idOf(c, "post");
    const body = parseBody(text, updatePostRequestSchema);
    checkSharing(body, false);
    return { op: "updatePost", id, body };
  },
  deletePost: (c) => ({ op: "deletePost", id: idOf(c, "post") }),
  movePost: (c, text) => ({
    op: "movePost",
    id: idOf(c, "post"),
    body: parseBody(text, movePostRequestSchema),
  }),
  getPostingSchedule: () => ({ op: "getPostingSchedule" }),
  putPostingSchedule: (_, text) => ({
    op: "putPostingSchedule",
    body: parseBody(text, putPostingScheduleRequestSchema),
  }),
} satisfies Partial<Record<ApiOperationName, CallOf>>;

/** The routes that are answered without the workspace. */
const ownRoutes = {
  getAccount: (c) => {
    const { key, owner, workspace } = c.var.api;
    return c.json(
      apiOperations.getAccount.response.parse({
        id: owner.id,
        email: owner.email,
        name: owner.name,
        workspace: { id: workspace.id, environment: workspace.environment },
        apiKey: {
          id: key.id,
          name: key.name,
          scopes: key.scopes,
          expiresAt:
            key.expiresAt === null ? null : apiTime(key.expiresAt.getTime()),
        },
      }),
    );
  },
  // Not thrown: it is no failure of pigy's, and nothing for the log.
  uploadMedia: (c) =>
    c.json(
      apiOperations.uploadMedia.response.parse({
        error: "UnexpectedError",
        message:
          "Uploading media is not available yet: images come with a later version",
      }),
      501,
    ),
} satisfies Record<
  Exclude<ApiOperationName, keyof typeof workspaceRoutes>,
  (c: ApiContext) => Response
>;

let document: ReturnType<typeof openApiDocument> | undefined;

/** Under `/api/v1`. */
export function apiRoutes(dependencies: AppDependencies): Hono<ApiEnv> {
  const { now, simulatedGoogle } = dependencies;
  const app = new Hono<ApiEnv>();

  // What the API is, for anybody: nothing of anybody's is in either.
  app.get("/openapi.json", (c) => {
    document ??= openApiDocument();
    return c.json(document);
  });
  app.get("/docs", (c) => {
    document ??= openApiDocument();
    return c.html(docsPage(document));
  });

  /**
   * Lets a request through that comes with a key which is good and has
   * `scope`, and sets `c.var.api`. A key that has made too many requests
   * is told when to come again.
   */
  const withKey =
    (scope: ApiScope | null): MiddlewareHandler<ApiEnv> =>
    async (c, next) => {
      const [, key] =
        /^Bearer +(\S+)$/i.exec(c.req.header("Authorization") ?? "") ?? [];
      const auth = key
        ? await verifyApiKey(
            drizzle(c.env.DB),
            key,
            readAdminEmails(c.env, simulatedGoogle, new URL(c.req.url).origin),
            now(),
          )
        : { refused: "Send an API key: Authorization: Bearer <key>" };
      if ("refused" in auth) {
        c.header("WWW-Authenticate", "Bearer");
        throw new HTTPException(401, { message: auth.refused });
      }
      // Counted per key, by its ID, which is no secret.
      const { success } = await c.env.API_RATE_LIMITER.limit({
        key: auth.key.id,
      });
      if (!success) {
        c.header("Retry-After", String(apiRateLimit.periodSeconds));
        throw new HTTPException(429, {
          message: `This API key has made more than ${apiRateLimit.limit} requests in a minute. Try again later.`,
        });
      }
      if (scope !== null && !auth.key.scopes.includes(scope)) {
        throw new HTTPException(403, {
          message: `This API key does not have the scope ${scope}`,
        });
      }
      c.set("api", auth);
      await next();
    };

  const inWorkspace =
    (operation: ApiOperation, callOf: CallOf) => async (c: ApiContext) => {
      const text = operation.request ? await bodyText(c) : "";
      const call = callOf(c, text);
      const answer = await callWorkspaceApi(
        c.env.WORKSPACE,
        c.var.api.workspace,
        call,
        operation.method === "get" ? undefined : await repeatOf(c, text),
      );
      if (!answer.ok) {
        const status = answer.status as ContentfulStatusCode;
        throw answer.field === undefined
          ? new HTTPException(status, { message: answer.message })
          : new InvalidField(answer.field, answer.message, status);
      }
      return operation.response === null
        ? c.body(null, 204)
        : c.json(
            operation.response.parse(answer.body),
            answer.status as ContentfulStatusCode,
          );
    };

  for (const name of Object.keys(apiOperations) as ApiOperationName[]) {
    const operation: ApiOperation = apiOperations[name];
    const handler =
      name in workspaceRoutes
        ? inWorkspace(
            operation,
            workspaceRoutes[name as keyof typeof workspaceRoutes],
          )
        : ownRoutes[name as keyof typeof ownRoutes];
    app.on(
      operation.method.toUpperCase(),
      operation.path.replace(/\{(\w+)\}/g, ":$1"),
      withKey(operation.scope),
      handler,
    );
  }

  return app;
}
