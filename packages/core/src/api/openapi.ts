import { z } from "zod";
import {
  type ApiOperation,
  apiBasePath,
  apiOperations,
  apiSchemaNames,
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

**Repeating a request.** Send an \`Idempotency-Key\` header of your own making with a request that changes something, up to 255 characters. A request that comes again with the same key is not carried out again: it is answered as the first one was, a refusal included, for 30 days. The same key with another request is refused with a 422. Without the header every request is carried out.

**Limits.** A key may make ${apiRateLimit.limit} requests a minute. Beyond that the answer is a 429 with \`Retry-After\`. A body is at most ${maxApiBodyBytes / 1024} KiB.

**Times** are ISO 8601, in UTC in every answer.

**Pages.** A list is answered a page at a time, with \`pageInfo\`: pass its \`endCursor\` as \`after\` for the next page while \`hasNextPage\` is true.

**Not there yet.** Images: \`POST /media\` and \`assets\` are refused. Engagement: \`metrics\` is null.`;

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
  const hasBody = operation.request !== undefined;
  // What changes something can be named, to be carried out once.
  const writes = operation.method !== "get" && operation.available !== false;
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
              "Names the request, so that it is carried out once however often it is sent.",
            schema: { type: "string", maxLength: 255 },
          } satisfies JsonObject,
        ]
      : []),
  ];
  const success: JsonObject =
    operation.response === null
      ? { description: "Done" }
      : {
          description:
            operation.available === false ? "Not available yet" : "Success",
          content: {
            "application/json": { schema: schemaOf(operation.response) },
          },
        };
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
    responses: {
      [String(operation.status)]: success,
      ...((writes || operation.query) && {
        "400": error("The request is not what the route takes"),
      }),
      "401": error("The key is missing, unknown, revoked or expired"),
      ...(operation.scope && {
        "403": error(`The key lacks the scope ${operation.scope}`),
      }),
      ...(pathParameters.length > 0 && {
        "404": error("There is no such thing in the workspace of the key"),
      }),
      ...(writes && {
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
