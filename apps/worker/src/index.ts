import { healthResponseSchema } from "@pigy/core";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json(
    healthResponseSchema.parse({ status: "ok", version: c.env.VERSION.id }),
  ),
);

app.notFound((c) =>
  c.json({ error: "NotFoundError", message: "Not found" }, 404),
);

export default app;
