import { apiBasePath } from "@pigy/core/api";

/**
 * The page that describes the public API to a person, at `/api/v1/docs`.
 * It is made from the OpenAPI document and from nothing else, on the
 * server, as plain HTML: no script, and nothing that is loaded from
 * another site, which the content security policy of the app would not
 * allow and a device without a connection to that site would not have.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectAt = (value: Json | undefined, key: string): JsonObject => {
  const held = isObject(value) ? value[key] : undefined;
  return isObject(held) ? held : {};
};

const textOf = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

/**
 * The little of Markdown that the texts of the document use: `code` and
 * **bold**. Everything else is text.
 */
function inline(text: string): string {
  return escaped(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${inline(paragraph)}</p>`)
    .join("\n");

const refName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

/** A schema in a few words, with a link where it names another. */
function typeOf(schema: Json | undefined): string {
  if (!isObject(schema)) return "any";
  if (typeof schema.$ref === "string") {
    const name = refName(schema.$ref);
    return `<a href="#schema-${escaped(name)}">${escaped(name)}</a>`;
  }
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeOf).join(" | ");
  if (Array.isArray(schema.enum)) {
    return schema.enum
      .map((value) => `<code>${escaped(JSON.stringify(value))}</code>`)
      .join(" | ");
  }
  if (schema.type === "array") return `list of ${typeOf(schema.items)}`;
  const type = textOf(schema.type) || "any";
  const format = textOf(schema.format);
  const limits = [
    typeof schema.maxLength === "number" && `at most ${schema.maxLength} long`,
    typeof schema.minimum === "number" && `from ${schema.minimum}`,
    typeof schema.maximum === "number" && `to ${schema.maximum}`,
    typeof schema.maxItems === "number" && `at most ${schema.maxItems}`,
  ].filter(Boolean);
  return escaped([format ? `${type} (${format})` : type, ...limits].join(", "));
}

/** The rows of a table for the fields of `schema`, nested ones under dots. */
function fieldRows(schema: JsonObject, prefix = ""): string[] {
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  return Object.entries(objectAt(schema, "properties")).flatMap(
    ([name, field]) => {
      if (!isObject(field)) return [];
      const path = `${prefix}${name}`;
      const row = `<tr><td><code>${escaped(path)}</code>${
        required.has(name) ? "" : " <small>optional</small>"
      }</td><td>${typeOf(field)}</td><td>${inline(textOf(field.description))}</td></tr>`;
      // What a field holds, where it is said in place and not by a name.
      const inner = field.type === "array" ? field.items : field;
      const nested =
        isObject(inner) && isObject(inner.properties)
          ? fieldRows(inner, `${path}${field.type === "array" ? "[]" : ""}.`)
          : [];
      return [row, ...nested];
    },
  );
}

const fieldTable = (schema: JsonObject) => {
  const rows = fieldRows(schema);
  return rows.length === 0
    ? ""
    : `<table><thead><tr><th>Field</th><th>Type</th><th></th></tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table>`;
};

const jsonSchemaOf = (content: Json | undefined) =>
  objectAt(
    objectAt(objectAt(content, "content"), "application/json"),
    "schema",
  );

/**
 * What a route takes as its body: a shape of JSON, or the bytes of a file,
 * which the document says with the types that they may be of.
 */
function bodyOf(body: JsonObject): string {
  const content = objectAt(body, "content");
  if (isObject(content["application/json"])) {
    return typeOf(jsonSchemaOf(body));
  }
  return `${inline(textOf(body.description))} ${Object.keys(content)
    .map((type) => `<code>${escaped(type)}</code>`)
    .join(", ")}`;
}

function operationSection(method: string, path: string, operation: JsonObject) {
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters.filter(isObject)
    : [];
  const responses = objectAt(operation, "responses");
  const scope = textOf(operation["x-scope"]);
  return `<section id="${escaped(textOf(operation.operationId))}">
<h3><span class="method">${escaped(method.toUpperCase())}</span> <code>${escaped(apiBasePath + path)}</code></h3>
<p><strong>${inline(textOf(operation.summary))}.</strong> ${inline(textOf(operation.description))}</p>
<p>${scope ? `Scope: <code>${escaped(scope)}</code>` : "Any key."}</p>
${
  parameters.length === 0
    ? ""
    : `<table><thead><tr><th>Parameter</th><th>Type</th><th></th></tr></thead><tbody>
${parameters
  .map(
    (parameter) =>
      `<tr><td><code>${escaped(textOf(parameter.name))}</code> <small>${escaped(textOf(parameter.in))}${
        parameter.required === true ? "" : ", optional"
      }</small></td><td>${typeOf(parameter.schema)}</td><td>${inline(textOf(parameter.description))}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`
}
${
  isObject(operation.requestBody)
    ? `<p>Body: ${bodyOf(operation.requestBody)}</p>`
    : ""
}
<p>Answers: ${Object.entries(responses)
    .map(([status, response]) => {
      const schema = jsonSchemaOf(response);
      return `<code>${escaped(status)}</code> ${
        status.startsWith("2") && Object.keys(schema).length > 0
          ? typeOf(schema)
          : inline(textOf(objectAt(responses, status).description))
      }`;
    })
    .join(", ")}.</p>
</section>`;
}

/** The page for `document`, which is the OpenAPI document of the API. */
export function docsPage(document: JsonObject): string {
  const info = objectAt(document, "info");
  const title = textOf(info.title);
  const operations = Object.entries(objectAt(document, "paths")).flatMap(
    ([path, methods]) =>
      Object.entries(isObject(methods) ? methods : {}).flatMap(
        ([method, operation]) =>
          isObject(operation)
            ? [operationSection(method, path, operation)]
            : [],
      ),
  );
  const schemas = Object.entries(
    objectAt(objectAt(document, "components"), "schemas"),
  ).flatMap(([name, schema]) =>
    isObject(schema)
      ? [
          `<section id="schema-${escaped(name)}">
<h3>${escaped(name)}</h3>
<p>${inline(textOf(schema.description))}</p>
${fieldTable(schema)}
</section>`,
        ]
      : [],
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)}</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.55 system-ui, sans-serif; }
  body { margin: 0; overflow-wrap: anywhere; padding: 16px; }
  main { margin: 0 auto; max-width: 760px; }
  h1 { font-size: 24px; margin: 16px 0 8px; }
  h2 { border-bottom: 1px solid #8884; font-size: 19px; margin: 40px 0 8px; padding-bottom: 4px; }
  h3 { font-size: 16px; margin: 28px 0 4px; }
  p { margin: 0 0 10px; }
  code { font: 13px ui-monospace, monospace; }
  small { opacity: 0.7; }
  .method { border: 1px solid #8886; border-radius: 4px; font: 600 12px ui-monospace, monospace; padding: 1px 6px; }
  table { border-collapse: collapse; margin: 0 0 10px; width: 100%; }
  th, td { border-top: 1px solid #8884; padding: 5px 8px 5px 0; text-align: left; vertical-align: top; }
  th { border-top: 0; font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>${escaped(title)}</h1>
${paragraphs(textOf(info.description))}
<p>This page is made from the OpenAPI document of the API: <a href="${apiBasePath}/openapi.json">openapi.json</a>.</p>
<h2>Routes</h2>
${operations.join("\n")}
<h2>Shapes</h2>
${schemas.join("\n")}
</main>
</body>
</html>`;
}
