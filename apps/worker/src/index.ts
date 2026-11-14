import { type ErrorResponse, healthResponseSchema } from "@pigy/core";
import { Hono } from "hono";

const notFound: ErrorResponse = {
  error: "NotFoundError",
  message: "Not found",
};
const unexpected: ErrorResponse = {
  error: "UnexpectedError",
  message: "Something went wrong",
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json(
    healthResponseSchema.parse({ status: "ok", version: c.env.VERSION.id }),
  ),
);

app.notFound((c) => c.json(notFound, 404));

app.onError((error, c) => {
  // The exception goes to the logs, never to the client.
  console.error(error);
  return c.json(unexpected, 500);
});

export default app;
