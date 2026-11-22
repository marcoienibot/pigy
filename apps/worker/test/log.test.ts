import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { log } from "../src/log.ts";
import { entriesOf, expectErrors, expectWarnings } from "./helpers.ts";

it("writes one line of JSON with what happened, where, and the error", () => {
  const errors = expectErrors();
  const cause = new TypeError("The network is gone");
  const error = new Error("The step failed", { cause });

  log.error(
    "delivery",
    "A step of a delivery failed",
    { workspaceId: "w-1", targetId: "t-1", step: "publish-1" },
    error,
  );

  expect(errors).toHaveBeenCalledOnce();
  const [line] = errors.mock.calls[0] ?? [];
  // One line: a log that is searched has one entry for one event, and a
  // stack has line breaks, which JSON escapes.
  expect(typeof line).toBe("string");
  expect(line).not.toContain("\n");
  expect(JSON.parse(String(line))).toEqual({
    level: "error",
    kind: "delivery",
    message: "A step of a delivery failed",
    workspaceId: "w-1",
    targetId: "t-1",
    step: "publish-1",
    error: {
      name: "Error",
      message: "The step failed",
      stack: error.stack,
      cause: {
        name: "TypeError",
        message: "The network is gone",
        stack: cause.stack,
      },
    },
  });
});

it("writes a warning to the level of warnings, without an error where there is none", () => {
  const warnings = expectWarnings();
  const errors = expectErrors();

  log.warn("renewal", "The access of a channel was not renewed", {
    channelId: "c-1",
  });

  expect(errors).not.toHaveBeenCalled();
  expect(entriesOf(warnings)).toEqual([
    {
      level: "warn",
      kind: "renewal",
      message: "The access of a channel was not renewed",
      channelId: "c-1",
    },
  ]);
});

it("logs no error without passing it through `loggable`", () => {
  const errors = expectErrors();
  // A query that failed, as Drizzle reports it, beneath what was caught:
  // nobody who logs has to think of it.
  const failed = new Error("The channel was not stored", {
    cause: new DrizzleQueryError(
      'update "channel" set "credentials" = ?',
      ["1.sealed-credentials"],
      new Error("D1_ERROR: The database is in trouble"),
    ),
  });

  log.error("connection", "A channel was not stored", {}, failed);

  const line = String(errors.mock.calls[0]?.[0]);
  expect(line).toContain('update \\"channel\\"');
  expect(line).toContain("The database is in trouble");
  expect(line).not.toContain("1.sealed-credentials");
});

it("says of an error what it says of itself, and not what it holds", () => {
  const errors = expectErrors();
  const error = Object.assign(new Error("The network refused"), {
    kind: "reconnect",
    status: 401,
    // What an error carries along is somebody's data: a body, a request.
    body: { access_token: "a-token" },
    sent: ["a-token"],
  });

  log.error("delivery", "A step of a delivery failed", {}, error);

  const [entry] = entriesOf(errors);
  expect(entry?.error).toEqual({
    name: "Error",
    message: "The network refused",
    kind: "reconnect",
    status: 401,
    stack: error.stack,
  });
});

it("does not throw for what JSON cannot hold", () => {
  const errors = expectErrors();
  const circle: { self?: unknown; count: bigint } = { count: 3n };
  circle.self = circle;

  // Where an error is handled, nothing may throw: a log least of all.
  expect(() =>
    log.error("sync", "A mutation failed", {}, circle),
  ).not.toThrow();

  const [entry] = entriesOf(errors);
  expect(entry).toMatchObject({
    message: "A mutation failed",
    error: { count: "3", self: "[circular]" },
  });
});
