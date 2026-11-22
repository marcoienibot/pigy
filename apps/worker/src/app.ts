import { healthResponseSchema } from "@pigy/core";
import { apiBasePath } from "@pigy/core/api";
import { Hono } from "hono";
import { adminRoutes } from "./admin/routes.ts";
import { apiKeyRoutes } from "./api/key-routes.ts";
import { apiRoutes } from "./api/routes.ts";
import { assetRoutes } from "./assets.ts";
import { accessConfig, isLocal } from "./auth/config.ts";
import { authRoutes } from "./auth/routes.ts";
import { channelRoutes, connectCallbackRoutes } from "./channels/routes.ts";
import type { AppDependencies, AppEnv } from "./env.ts";
import { handleError, handleNotFound } from "./errors.ts";
import { mediaRoutes } from "./media/routes.ts";
import { blueskyClientRoutes } from "./network/bluesky-client.ts";
import { policyReportRoutes } from "./policy-reports.ts";
import { previewRoutes } from "./preview/routes.ts";
import { pushRoutes } from "./push/routes.ts";
import { securityHeaders } from "./security-headers.ts";
import { sandboxRoutes, simRoutes } from "./sim/routes.ts";
import { worldPagesPath } from "./sim/world.ts";
import { syncRoutes, workspaceRoutes } from "./workspace/routes.ts";

/**
 * The Worker's routes. A new path prefix also has to go into
 * `assets.run_worker_first` in wrangler.jsonc, or it never gets here.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const { fetch, simulatedGoogle, simulatedPush } = dependencies;
  const app = new Hono<AppEnv>();

  // What a browser may do with an answer: for every route, the errors
  // and the paths that nothing answers at included.
  app.use(securityHeaders());

  // What these answer depends on who asks and changes at any time. The
  // pages under /sim are one person's too: those of a simulated network
  // show the world of whoever is signed in.
  for (const path of ["/api/*", "/connect/*", "/sim/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  app.get("/api/health", (c) =>
    c.json(
      healthResponseSchema.parse({ status: "ok", version: c.env.VERSION.id }),
    ),
  );
  app.route("/api", authRoutes(dependencies));
  app.route("/api/admin", adminRoutes(dependencies));
  app.route("/api", workspaceRoutes(dependencies));
  app.route("/api", channelRoutes(dependencies));
  app.route("/api", previewRoutes(dependencies));
  app.route("/api", mediaRoutes(dependencies));
  app.route("/api", apiKeyRoutes(dependencies));
  // The public API, which takes a key and never the session.
  app.route(apiBasePath, apiRoutes(dependencies));
  app.route("/api/sandbox", sandboxRoutes(dependencies));
  app.route("/api/push", pushRoutes(dependencies));
  // What browsers report of the content security policy: for anybody,
  // without the session.
  app.route("/api", policyReportRoutes());
  app.route("/sync", syncRoutes(dependencies));
  // The files of the web app that are named after their content.
  app.route("/assets", assetRoutes());
  app.route("/connect", blueskyClientRoutes(dependencies));
  app.route("/connect", connectCallbackRoutes(dependencies));
  // The pages of the simulated networks of a sandbox.
  app.route(worldPagesPath, simRoutes(dependencies));

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

  // What the end-to-end tests ask of the simulated push services. The
  // path exists only in the build that has them, and like the simulated
  // Google it answers only where the app is reached locally.
  app.all("/api/e2e/*", (c) =>
    simulatedPush && isLocal(new URL(c.req.url).origin)
      ? simulatedPush.handle(c.req.raw)
      : handleNotFound(c),
  );

  app.notFound(handleNotFound);
  app.onError(handleError);

  return app;
}
