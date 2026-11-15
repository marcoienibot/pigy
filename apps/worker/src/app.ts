import { healthResponseSchema } from "@pigy/core";
import { Hono } from "hono";
import { adminRoutes } from "./admin/routes.ts";
import { accessConfig } from "./auth/config.ts";
import { authRoutes } from "./auth/routes.ts";
import type { AppDependencies, AppEnv } from "./env.ts";
import { handleError, handleNotFound } from "./errors.ts";
import { workspaceRoutes } from "./workspace/routes.ts";

/**
 * The Worker's routes. A new path prefix also has to go into
 * `assets.run_worker_first` in wrangler.jsonc, or it never gets here.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const { fetch, simulatedGoogle } = dependencies;
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    await next();
    // What the API answers depends on who asks and changes at any time.
    c.header("Cache-Control", "no-store");
  });

  app.get("/api/health", (c) =>
    c.json(
      healthResponseSchema.parse({ status: "ok", version: c.env.VERSION.id }),
    ),
  );
  app.route("/api", authRoutes(dependencies));
  app.route("/api/admin", adminRoutes(dependencies));
  app.route("/api", workspaceRoutes(dependencies));

  // The pages of the simulated Google. The path exists only while sign-in is
  // simulated.
  app.all("/sim/google/*", (c) => {
    const config = accessConfig(
      c.env,
      fetch,
      simulatedGoogle,
      new URL(c.req.url).origin,
    );
    return config.simulatedGoogle
      ? config.simulatedGoogle.handle(c.req.raw, config.adminEmails)
      : handleNotFound(c);
  });

  app.notFound(handleNotFound);
  app.onError(handleError);

  return app;
}
