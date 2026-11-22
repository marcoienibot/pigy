import {
  type ApiScope,
  chunksOf,
  idSchema,
  maxImageBytes,
  maxUploadChunks,
  uploadChunks,
} from "@pigy/core";
import {
  type ApiOperation,
  type ApiOperationName,
  apiOperations,
  apiRateLimit,
  apiTime,
  assetLimits,
  type CreatePostRequest,
  createPostRequestSchema,
  idempotencyKeySchema,
  listPostsQuerySchema,
  maxApiBodyBytes,
  movePostRequestSchema,
  openApiDocument,
  putPostingScheduleRequestSchema,
  type UpdatePostRequest,
  updatePostRequestSchema,
} from "@pigy/core/api";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { readAdminEmails } from "../auth/config.ts";
import { sha256Hex } from "../digest.ts";
import type { AppDependencies, Bindings } from "../env.ts";
import { InvalidField, parseInput, routeOf } from "../errors.ts";
import { log } from "../log.ts";
import { imagesTransformer } from "../media/transform.ts";
import { countUploads } from "../media/uses.ts";
import { reachOf } from "../network/reach.ts";
import type { ApiAnswer, ApiCall, TakenImages } from "../workspace/api.ts";
import { callWorkspaceApi } from "../workspace/workspaces.ts";
import { docsPage } from "./docs.ts";
import { type ApiKeyAuth, verifyApiKey } from "./keys.ts";
import {
  addressesOf,
  dropImages,
  FileRefused,
  type Intake,
  keepImages,
  takeAddresses,
  takeFile,
} from "./media.ts";

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
    key: `api:${c.var.api.key.id}:${await sha256Hex(header)}`,
    fingerprint: await sha256Hex(
      `${c.req.method} ${new URL(c.req.url).pathname}\n${body}`,
    ),
  };
}

/**
 * The ID in the path, as the parameter `name`, or a 404: no row has an ID
 * that is not one.
 */
function idOf(c: ApiContext, what: string, name = "id"): string {
  const id = idSchema.safeParse(c.req.param(name));
  if (!id.success) {
    throw new HTTPException(404, { message: `There is no such ${what}` });
  }
  return id.data;
}

/**
 * Refuses what the schemas of a post cannot say: which of `mode`, `dueAt`
 * and `saveToDraft` go together.
 */
function checkSharing(
  body: {
    mode?: string | undefined;
    dueAt?: string | undefined;
    saveToDraft?: boolean | undefined;
  },
  modeRequired: boolean,
): void {
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

/**
 * What a route makes of a request: the call into the workspace, and the
 * images that it has put into the bucket for it, which the call makes the
 * rows of.
 */
type CallOf = (
  c: ApiContext,
  body: string,
  dependencies: AppDependencies,
) => ApiCall | Promise<{ call: ApiCall; images: TakenImages }>;

/**
 * The call of a post, with the images that its assets name by their
 * addresses fetched and taken in before: the workspace is not asked
 * while the files are on their way. The `fetch` is that of the workspace,
 * `reachOf`: a sandbox fetches from its simulated web, and from nowhere
 * else.
 */
function withImages(
  c: ApiContext,
  { fetch, now, assetTimeoutMs = assetLimits.timeoutMs }: AppDependencies,
  body: CreatePostRequest | UpdatePostRequest,
  call: (images: TakenImages | undefined) => ApiCall,
): ApiCall | Promise<{ call: ApiCall; images: TakenImages }> {
  const named = new Set(addressesOf(body).map(({ url }) => url));
  if (named.size === 0) return call(undefined);
  return (async () => {
    const at = now();
    // Counted before anything is fetched, each as the largest file that
    // the app would upload: what a file has is known when it is there.
    await countedUploads(
      c,
      at,
      Math.min(named.size, assetLimits.perRequest + 1) * (maxUploadChunks + 2),
    );
    const images = await takeAddresses(
      intakeOf(c, at),
      reachOf(c.var.api.workspace, c.env, fetch).fetch,
      body,
      { ...assetLimits, timeoutMs: assetTimeoutMs },
      [new URL(c.req.url).host],
    );
    return { call: call(images), images };
  })();
}

/** What the routes take an image in with, for the workspace of the key. */
function intakeOf(c: ApiContext, now: Date): Intake {
  return {
    bucket: c.env.MEDIA,
    transformer: imagesTransformer(c.env.IMAGES),
    workspaceId: c.var.api.workspace.id,
    now,
  };
}

/**
 * Counts what the person whose key it is uploads, `weight` requests of
 * the app's, and refuses beyond what they may in a minute: the API and
 * the app share it.
 */
async function countedUploads(c: ApiContext, now: Date, weight: number) {
  if (await countUploads(drizzle(c.env.DB), c.var.api.owner.id, now, weight)) {
    return;
  }
  c.header("Retry-After", String(apiRateLimit.periodSeconds));
  throw new HTTPException(429, {
    message:
      "This person has uploaded more images in the last minute than pigy takes, in the app and with their API keys together. Try again later.",
  });
}

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
  getPostTarget: (c) => ({
    op: "getPostTarget",
    id: idOf(c, "post"),
    channelId: idOf(c, "channel", "channelId"),
  }),
  createPost: (c, text, dependencies) => {
    const body = parseBody(text, createPostRequestSchema);
    checkSharing(body, true);
    return withImages(c, dependencies, body, (images) => ({
      op: "createPost",
      body,
      images,
    }));
  },
  updatePost: (c, text, dependencies) => {
    const id = idOf(c, "post");
    const body = parseBody(text, updatePostRequestSchema);
    checkSharing(body, false);
    return withImages(c, dependencies, body, (images) => ({
      op: "updatePost",
      id,
      body,
      images,
    }));
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
} satisfies Record<
  Exclude<ApiOperationName, keyof typeof workspaceRoutes | "uploadMedia">,
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

  /**
   * Carries `call` out in the workspace of the key, and answers as the
   * workspace says. `images` are what the request has put into the
   * bucket for the call: what the rows of a call that was carried out
   * need of them is kept, and all of them go when it was refused or was
   * a repeat, whose rows were made by the request before. Nothing goes
   * when the workspace could not be asked or its answer was lost: the
   * change may have been made.
   */
  const answered = async (
    c: ApiContext,
    operation: ApiOperation,
    call: ApiCall,
    repeat: { key: string; fingerprint: string } | undefined,
    images: readonly string[],
  ) => {
    const { workspace } = c.var.api;
    const answer: ApiAnswer = await callWorkspaceApi(
      c.env.WORKSPACE,
      workspace,
      call,
      repeat,
    );
    if (images.length > 0) {
      const made = answer.ok && !answer.replayed;
      // For the log, read while the request is at its route.
      const where = { route: routeOf(c), workspaceId: workspace.id };
      c.executionCtx.waitUntil(
        (made ? keepImages : dropImages)(
          c.env.MEDIA,
          workspace.id,
          images,
        ).catch((error) => {
          log.error(
            "media",
            "What the bucket had of an image of the API was not deleted",
            where,
            error,
          );
        }),
      );
    }
    // What the call was answered with before, said again: it was not
    // carried out now.
    if (answer.replayed) c.header("Idempotent-Replayed", "true");
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

  const inWorkspace =
    (operation: ApiOperation, callOf: CallOf) => async (c: ApiContext) => {
      const text = operation.request ? await bodyText(c) : "";
      const prepared = await callOf(c, text, dependencies);
      const { call, images } =
        "op" in prepared ? { call: prepared, images: undefined } : prepared;
      let repeat: Awaited<ReturnType<typeof repeatOf>>;
      try {
        repeat =
          operation.method === "get" ? undefined : await repeatOf(c, text);
      } catch (error) {
        if (images) {
          await dropImages(
            c.env.MEDIA,
            c.var.api.workspace.id,
            images.taken.map(({ id }) => id),
          );
        }
        throw error;
      }
      return answered(
        c,
        operation,
        call,
        repeat,
        images?.taken.map(({ id }) => id) ?? [],
      );
    };

  /**
   * `POST /media`: the body is the file. It is written into the bucket as
   * it comes and read there, `takeFile`, and only then is the workspace
   * asked to make its row. The file is whole in one request, so that
   * repeating the request is the way to go on after a broken connection,
   * with the same `Idempotency-Key`: a script has its file, where a page
   * on a phone has to take it up again in chunks, as the app does.
   */
  const uploadMedia = async (c: ApiContext) => {
    const at = now();
    const header = c.req.header("Content-Length");
    const declared =
      header === undefined || !/^\d{1,12}$/.test(header)
        ? undefined
        : Number(header);
    if (declared !== undefined && declared > maxImageBytes) {
      throw new HTTPException(413, {
        message: `The file is larger than ${maxImageBytes / 1024 / 1024} MiB.`,
      });
    }
    // A key that is refused is refused before the file is read.
    const key = c.req.header("Idempotency-Key");
    if (key !== undefined && !idempotencyKeySchema.safeParse(key).success) {
      await repeatOf(c, "");
    }
    await countedUploads(
      c,
      at,
      (declared === undefined ? maxUploadChunks : uploadChunks(declared)) + 2,
    );
    const body = c.req.raw.body;
    // The request is told by the digest of its file, for its repeats.
    const digest = new crypto.DigestStream("SHA-256");
    const hashing = digest.getWriter();
    let image: Awaited<ReturnType<typeof takeFile>>;
    try {
      image = await takeFile(intakeOf(c, at), async (write) => {
        if (!body) return;
        for await (const piece of chunksOf(body)) {
          await hashing.write(piece);
          await write(piece);
        }
      });
    } catch (error) {
      if (!(error instanceof FileRefused)) throw error;
      throw new HTTPException(error.status, { message: error.message });
    }
    await hashing.close();
    const hex = [...new Uint8Array(await digest.digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return answered(
      c,
      apiOperations.uploadMedia,
      { op: "createMedia", image },
      await repeatOf(c, `SHA-256 ${hex}`),
      [image.id],
    );
  };

  for (const name of Object.keys(apiOperations) as ApiOperationName[]) {
    const operation: ApiOperation = apiOperations[name];
    const handler =
      name === "uploadMedia"
        ? uploadMedia
        : name in workspaceRoutes
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
