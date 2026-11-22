import { z } from "zod/v4";

/**
 * What the builds of the app get when they import "zod": the same, told
 * not to compile its schemas into functions. `vite.config.ts` puts this
 * file in the place of the package.
 *
 * Zod compiles a schema with `new Function` where the browser lets it,
 * and finds out whether it does by trying, when the schema of an object
 * is made. The content security policy of the app lets no page do that,
 * `public/_headers`, so every start of the app would be a report of a
 * broken policy. Told so, Zod checks the same things step by step, which
 * is what it does in the Worker, where the runtime refuses the same.
 *
 * It has to be told before the first schema is made, and the schemas of
 * @pigy/core are made as their modules load. Here it is told before
 * anybody who imports "zod" has got it, however the build cuts the app
 * into files.
 */
z.config({ jitless: true });

export * from "zod/v4";
