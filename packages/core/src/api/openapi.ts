import { z } from "zod";
import { maxImageBytes } from "../media/image.ts";
import {
  maxWorkspaceMediaBytes,
  uploadRequestsPerMinute,
} from "../media/upload.ts";
import { maxImagesPerPart } from "../sync/tables.ts";
import {
  type ApiOperation,
  apiBasePath,
  apiImageWeight,
  apiOperations,
  apiPostSchema,
  apiSchemaNames,
  assetLimits,
  maxApiAnswerTextLength,
  maxApiBodyBytes,
} from "./v1.ts";

/**
 * The OpenAPI document of the public API, made from the schemas and the
 * list of routes in `./v1.ts`: the ones that the Worker parses with and
 * registers its routes from. Nothing here describes a shape a second time.
 */

/** A JSON value, as a document is one. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type JsonObject = { [key: string]: Json };

/** How many requests a key may make in a minute. */
export const apiRateLimit = { limit: 120, periodSeconds: 60 } as const;

const ref = (name: string) => `#/components/schemas/${name}`;

/** What the document says before its routes. Markdown. */
const introduction = `The API of pigy does what the app does: it writes posts, shares them now, schedules them or puts them into the queue, and reads what became of them.

**Keys.** Make a key in the app, under Settings → API, and send it with every request: \`Authorization: Bearer <key>\`. A key belongs to one workspace. One that begins with \`pigy_live_\` posts to the real networks, one that begins with \`pigy_test_\` to the simulated networks of the sandbox, so a script can be tried without posting for real. A key has scopes, and a request that needs another is refused with a 403.

**Errors.** Every answer that is not a success is \`{ "error": name, "message": text }\`. The name follows from the status: \`UnauthorizedError\` for 401 and 403, \`NotFoundError\` for 404, \`LimitReachedError\` for 429, \`InvalidInputError\` for every other 4xx, \`UnexpectedError\` for 5xx. An \`InvalidInputError\` about one field of the request names it in \`field\`. A 409 says that the post is not in a state for what was asked: it has gone out, is being sent, or is not in the queue.

**Repeating a request.** Send an \`Idempotency-Key\` header of your own making with a request that changes something, up to 255 characters. A request that comes again with the same key is not carried out again, for 30 days. If it was carried out, the repeat is answered with the status of the first answer and with the post, or the posting schedule, as it is when the repeat comes, not as it was: a post that was \`sending\` may be \`sent\` by then, and one that was deleted since is a 404. If it was refused, the repeat is answered with the same refusal. Either way the answer has the header \`Idempotent-Replayed: true\`. A key is the API key's own: two API keys that send the same \`Idempotency-Key\` make two requests. The same key with another request is refused with a 422. A request that failed with a 5xx may or may not have been carried out: the answer can be lost after the change was made. Repeat it with the same \`Idempotency-Key\`: it is carried out if it was not, and answered as a repeat if it was. Without the header every request is carried out, so a request that is repeated after a 5xx can be carried out twice.

**For servers and scripts.** The API sends no CORS headers and answers no preflight, so a page in a browser cannot call it from another site: a key is a secret, and a page has no place to keep one. Call it from a server or a command line.

**Images.** A part of a post has up to ${maxImagesPerPart} images, in \`assets\`: the post's \`assets\` for its first part, and \`assets\` of a part of \`metadata.thread\` for that one. Name an image by its address, \`{ "image": { "url": "https://…", "metadata": { "altText": "…" } } }\`, as in Buffer, and pigy fetches it while it takes the request: an address that it cannot read, or a file that is no image, is refused with a 400 that names the field, and nothing of the request is carried out. Or upload the file first, with \`POST /media\`, and name it by the \`id\` of the answer, \`{ "image": { "mediaId": "…" } }\`: for a file that is not on the web, or one that several posts share. Either way the server keeps a copy of the image without what a camera wrote next to the picture, and makes a smaller one for a network that takes no larger, when the post goes out. A post with images does not go to LinkedIn or Threads yet: it is refused like a text that is too long for a channel.

**Limits.** A key may make ${apiRateLimit.limit} requests a minute. Beyond that the answer is a 429 with \`Retry-After\`. A body is at most ${maxApiBodyBytes / 1024} KiB, and the file of \`POST /media\` ${maxImageBytes / 1024 / 1024} MiB. A request names ${assetLimits.perRequest} addresses of images at most. The uploads of a person, in the app and with every key of theirs, are ${uploadRequestsPerMinute} requests of 5 MiB a minute, and the images of a workspace ${maxWorkspaceMediaBytes / 1024 / 1024 / 1024} GiB. An answer carries at most ${maxApiAnswerTextLength} characters of the texts of posts and of the descriptions of their images, each image counting ${apiImageWeight} more: a page of posts ends before the post that would take it past that, and one post leaves out the texts that its channels have of their own once there is no room for more. An entry of \`targets\` whose text was left out says so with \`textOmitted\`, and \`GET /posts/{id}/targets/{channelId}\` has it in full.

**Times** are ISO 8601, in UTC in every answer, and in the year 9999 at the latest.

**Pages.** A list is answered a page at a time, with \`pageInfo\`: pass its \`endCursor\` as \`after\` for the next page while \`hasNextPage\` is true. A page can have fewer posts than were asked for.

**Not there yet.** Video. Engagement: \`metrics\` is null.`;

/** The schemas that have a name, as JSON Schema, by their names. */
function namedSchemas(): { [name: string]: JsonObject } {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    target: "draft-2020-12",
    uri: ref,
  }) as unknown as { schemas: { [name: string]: JsonObject } };
  return Object.fromEntries(
    Object.entries(schemas)
      .filter(([name]) => apiSchemaNames.has(name))
      .map(([name, schema]) => {
        // What a schema says of itself as a document of its own, which it
        // is not here.
        const { $schema: _, $id: __, ...rest } = schema;
        return [name, tidy(rest) as JsonObject];
      }),
  );
}

/** `schema` as the document refers to it: by its name if it has one. */
function schemaOf(schema: z.ZodType): JsonObject {
  const id = z.globalRegistry.get(schema)?.id;
  if (id !== undefined && apiSchemaNames.has(id)) return { $ref: ref(id) };
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as JsonObject;
  return tidy(rest) as JsonObject;
}

/**
 * `schema` without the pattern that Zod writes next to the format of a
 * time: the format says it, and the pattern is two lines of noise.
 */
function tidy(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(tidy);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(key === "pattern" && schema.format === "date-time"))
      .map(([key, value]) => [key, tidy(value)]),
  );
}

const errorContent = {
  "application/json": { schema: { $ref: ref("Error") } },
};

const error = (description: string): JsonObject => ({
  description,
  content: errorContent,
});

function operationOf(name: string, operation: ApiOperation): JsonObject {
  const pathParameters = [...operation.path.matchAll(/\{(\w+)\}/g)].map(
    ([, parameter = ""]): JsonObject => ({
      name: parameter,
      in: "path",
      required: true,
      schema: { type: "string" },
    }),
  );
  const queryParameters = Object.entries(operation.query?.shape ?? {}).map(
    ([parameter, schema]): JsonObject => {
      const { description, ...rest } = schemaOf(schema as z.ZodType);
      return {
        name: parameter,
        in: "query",
        required: false,
        ...(typeof description === "string" && { description }),
        schema: rest,
        // A list is written with commas: `status=draft,scheduled`.
        ...(rest.type === "array" && { style: "form", explode: false }),
      };
    },
  );
  const hasBody =
    operation.request !== undefined || operation.upload !== undefined;
  // What changes something can be named, to be carried out once.
  const writes = operation.method !== "get";
  const parameters = [
    ...pathParameters,
    ...queryParameters,
    ...(writes
      ? [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description:
              "Names the request, so that it is carried out once however often this API key sends it. The answer to a repeat has the header `Idempotent-Replayed: true`.",
            schema: { type: "string", maxLength: 255 },
          } satisfies JsonObject,
        ]
      : []),
  ];
  const success: JsonObject =
    operation.response === null
      ? { description: "Done" }
      : {
          description: "Success",
          content: {
            "application/json": { schema: schemaOf(operation.response) },
          },
        };
  if (writes) {
    success.headers = {
      "Idempotent-Replayed": {
        description:
          "`true` if the request was not carried out now: it came with an `Idempotency-Key` that this API key had sent before.",
        schema: { type: "string", enum: ["true"] },
      },
    };
  }
  return {
    operationId: name,
    summary: operation.summary,
    ...(operation.description && { description: operation.description }),
    ...(operation.scope && { "x-scope": operation.scope }),
    ...(parameters.length > 0 && { parameters }),
    ...(operation.request && {
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: schemaOf(operation.request) },
        },
      },
    }),
    ...(operation.upload && {
      requestBody: {
        required: true,
        description: `The bytes of the file, ${operation.upload.maxBytes / 1024 / 1024} MiB at most, with any \`Content-Type\`: what the file is, is read from them.`,
        content: Object.fromEntries(
          [...operation.upload.types, "application/octet-stream"].map(
            (type): [string, JsonObject] => [
              type,
              { schema: { type: "string", contentMediaType: type } },
            ],
          ),
        ),
      },
    }),
    responses: {
      [String(operation.status)]: success,
      ...((writes || operation.query) && {
        "400": error("The request is not what the route takes"),
      }),
      "401": error("The key is missing, unknown, revoked or expired"),
      ...(operation.scope && {
        "403": error(`The key lacks the scope ${operation.scope}`),
      }),
      // A route that names something can find that it is not there. So
      // can the repeat of a write that names nothing and is answered
      // with a post, as `POST /posts`: the repeat is answered with the
      // post that the first request made, which can have been deleted
      // since.
      ...(pathParameters.length > 0
        ? {
            "404": error("There is no such thing in the workspace of the key"),
          }
        : writes &&
          operation.response === apiPostSchema && {
            "404": error(
              "Only for a repeat, with `Idempotent-Replayed: true`: the post that the request made the first time has been deleted since",
            ),
          }),
      ...(writes &&
        !operation.upload && {
          "409": error("The post is not in a state for this"),
        }),
      ...(hasBody && { "413": error("The body is too large") }),
      ...(writes && {
        "422": error("The idempotency key was used for another request"),
      }),
      "429": {
        ...error("The key has made too many requests"),
        headers: {
          "Retry-After": {
            description: "After how many seconds to try again.",
            schema: { type: "integer" },
          },
        },
      },
    },
  };
}

/** The OpenAPI 3.1 document of the API. */
export function openApiDocument(): JsonObject {
  const paths: { [path: string]: JsonObject } = {};
  for (const [name, operation] of Object.entries<ApiOperation>(apiOperations)) {
    paths[operation.path] = {
      ...paths[operation.path],
      [operation.method]: operationOf(name, operation),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "pigy API",
      version: "1",
      description: introduction,
    },
    servers: [{ url: apiBasePath }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key from Settings → API.",
        },
      },
      schemas: namedSchemas(),
    },
  };
}
