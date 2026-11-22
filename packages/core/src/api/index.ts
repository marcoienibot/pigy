/**
 * The public API: its shapes, the list of its routes and its OpenAPI
 * document. An entry point of its own, `@pigy/core/api`, because only the
 * Worker has a use for it: the web app takes `./keys.ts` from the package
 * itself and carries none of this.
 */
export * from "./openapi.ts";
export * from "./v1.ts";
