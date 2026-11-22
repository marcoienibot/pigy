import { Validator } from "@seriousme/openapi-schema-validator";
import { expect, it } from "vitest";
import { z } from "zod";
import { openApiDocument } from "./openapi.ts";
import {
  type ApiOperation,
  apiOperations,
  apiSchemaNames,
  createPostRequestSchema,
} from "./v1.ts";

type Document = {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

const document = openApiDocument() as unknown as Document;

/** Every `$ref` in `value`, wherever it is. */
function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, held]) =>
    key === "$ref" && typeof held === "string" ? [held] : refsIn(held),
  );
}

it("is an OpenAPI 3.1 document, by the schema of the specification", async () => {
  // The validator has the schemas of the specification with it, and asks
  // nobody: it checks the document against the one of version 3.1, and
  // that every reference leads somewhere.
  const validator = new Validator();
  const result = await validator.validate(structuredClone(document));
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(validator.version).toBe("3.1");
});

it("refuses a document that is none, so that the check above can fail", async () => {
  const withParameter = structuredClone(document) as unknown as {
    paths: Record<string, Record<string, { parameters: { in: string }[] }>>;
  };
  // A parameter is in the path, the query, a header or a cookie.
  const [parameter] = withParameter.paths["/posts"]?.get?.parameters ?? [];
  if (!parameter) throw new Error("The route has no parameter");
  parameter.in = "body";
  expect((await new Validator().validate(withParameter)).valid).toBe(false);

  // A shape that is referred to has to be there.
  const withoutShape = structuredClone(document);
  delete withoutShape.components.schemas.Post;
  expect((await new Validator().validate(withoutShape)).valid).toBe(false);
});

it("has one operation for every route of the list, under its name", () => {
  const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => [
      operation.operationId,
      { method, path },
    ]),
  );
  expect(Object.fromEntries(operations)).toEqual(
    Object.fromEntries(
      Object.entries<ApiOperation>(apiOperations).map(
        ([name, { method, path }]) => [name, { method, path }],
      ),
    ),
  );
});

it("names every shape that it refers to, and refers to every shape that it names", () => {
  const named = Object.keys(document.components.schemas).sort();
  expect(named).toEqual([...apiSchemaNames].sort());
  const referred = new Set(
    refsIn(document).map((ref) => ref.replace("#/components/schemas/", "")),
  );
  expect([...referred].sort()).toEqual(named);
});

it("describes a body by the schema that the route parses it with", () => {
  // The shape in the document is made from the schema, not written next
  // to it: a field that the schema has is in the document, with its
  // limits, and a body with a field that the schema lacks is refused by
  // both.
  const shape = document.components.schemas.CreatePostRequest;
  expect(shape).toEqual(
    expect.objectContaining({
      type: "object",
      required: ["text"],
      additionalProperties: false,
    }),
  );
  expect(Object.keys(shape?.properties ?? {}).sort()).toEqual(
    Object.keys(createPostRequestSchema.shape).sort(),
  );
  expect(shape?.properties).toMatchObject({
    text: { type: "string", maxLength: 10_000 },
    mode: {
      enum: ["addToQueue", "shareNext", "shareNow", "customScheduled"],
    },
    dueAt: { type: "string", format: "date-time" },
    metadata: { $ref: "#/components/schemas/PostMetadataInput" },
  });
  expect(
    createPostRequestSchema.safeParse({ text: "x", schedulingType: "y" })
      .success,
  ).toBe(false);
});

it("says of every route which scope it takes, and what a write can be refused with", () => {
  for (const [name, operation] of Object.entries<ApiOperation>(apiOperations)) {
    const documented = document.paths[operation.path]?.[operation.method] as {
      "x-scope"?: string;
      responses: Record<string, unknown>;
      parameters?: { name: string; in: string }[];
      requestBody?: unknown;
    };
    expect(documented["x-scope"] ?? null, name).toBe(operation.scope);
    expect(Object.keys(documented.responses), name).toEqual(
      expect.arrayContaining([String(operation.status), "401", "429"]),
    );
    const takesKey = (documented.parameters ?? []).some(
      (parameter) =>
        parameter.name === "Idempotency-Key" && parameter.in === "header",
    );
    expect(takesKey, name).toBe(
      operation.method !== "get" && operation.available !== false,
    );
    expect(documented.requestBody !== undefined, name).toBe(
      operation.request !== undefined,
    );
    // The parameters of the path are the ones that the path has.
    expect(
      (documented.parameters ?? [])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => `{${parameter.name}}`),
      name,
    ).toEqual(operation.path.match(/\{\w+\}/g) ?? []);
  }
  // A route that names something can answer that there is none, and so
  // can the write that makes a post and names none: its repeat is
  // answered with the post that it made, which can be gone. The posting
  // schedule cannot.
  const withNotFound = Object.entries<ApiOperation>(apiOperations)
    .filter(
      ([, { path, method }]) =>
        "404" in ((document.paths[path]?.[method]?.responses ?? {}) as object),
    )
    .map(([name]) => name);
  expect(withNotFound.sort()).toEqual(
    [
      "createPost",
      "deletePost",
      "getChannel",
      "getPost",
      "getPostTarget",
      "movePost",
      "updatePost",
    ].sort(),
  );
  // What is not there yet says so.
  expect(document.paths["/media"]?.post?.responses).toHaveProperty("501");
});

it("leaves nothing in Zod's registry under a name that is not a shape of the API", () => {
  // The names are looked up in the registry that every schema of the app
  // shares. One of another module under the same name would take its place.
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    uri: (id) => id,
  }) as unknown as { schemas: Record<string, unknown> };
  expect(Object.keys(schemas).sort()).toEqual([...apiSchemaNames].sort());
});
