import {
  apiKeyListResponseSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  grantableApiScopes,
  maxApiKeys,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../auth/guards.ts";
import { clearSessionCookie } from "../auth/session.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { InvalidField, parseJsonBody } from "../errors.ts";
import { ownWorkspace } from "../workspace/workspaces.ts";
import { apiKeysOf, createApiKey, revokeApiKey } from "./keys.ts";

/**
 * Under `/api`: the keys of the public API of a workspace, for whoever is
 * signed in. These routes take the session cookie and no key: a key
 * cannot make keys, list them or revoke one.
 */
export function apiKeyRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { now } = dependencies;
  const app = new Hono<AppEnv>();
  const signedIn = requireUser(dependencies);

  const workspaceOf = async (c: Context<AppEnv>) => {
    const workspace = await ownWorkspace(
      drizzle(c.env.DB),
      c.req.param("workspaceId") ?? "",
      c.var.auth.user.id,
    );
    if (!workspace) {
      throw new HTTPException(404, { message: "There is no such workspace" });
    }
    return workspace;
  };

  app.get("/workspaces/:workspaceId/api-keys", signedIn, async (c) => {
    const workspace = await workspaceOf(c);
    return c.json(
      apiKeyListResponseSchema.parse({
        apiKeys: await apiKeysOf(drizzle(c.env.DB), workspace.id),
      }),
    );
  });

  app.post("/workspaces/:workspaceId/api-keys", signedIn, async (c) => {
    const workspace = await workspaceOf(c);
    const request = await parseJsonBody(c, createApiKeyRequestSchema);
    const time = now();
    const ungrantable = request.scopes.find(
      (scope) => !(grantableApiScopes as readonly string[]).includes(scope),
    );
    if (ungrantable) {
      throw new InvalidField(
        "scopes",
        `No key can have the scope ${ungrantable} yet: uploading media comes with a later version`,
      );
    }
    if (request.expiresAt !== null && request.expiresAt <= time.getTime()) {
      throw new InvalidField("expiresAt", "This time has passed");
    }
    const created = await createApiKey(
      drizzle(c.env.DB),
      workspace,
      c.var.sessionId,
      request,
      time,
    );
    if (created === "signed_out") {
      // The session ended while the request was on its way: answered as
      // `requireUser` answers a request that comes without one.
      clearSessionCookie(c);
      throw new HTTPException(401, { message: "Sign in to continue" });
    }
    if (created === "full") {
      throw new HTTPException(409, {
        message: `A workspace has at most ${maxApiKeys} API keys. Revoke one first.`,
      });
    }
    return c.json(createApiKeyResponseSchema.parse(created), 201);
  });

  app.delete(
    "/workspaces/:workspaceId/api-keys/:keyId",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const revoked = await revokeApiKey(
        drizzle(c.env.DB),
        workspace.id,
        c.req.param("keyId"),
        now(),
      );
      if (!revoked) {
        throw new HTTPException(404, { message: "There is no such API key" });
      }
      return c.body(null, 204);
    },
  );

  return app;
}
