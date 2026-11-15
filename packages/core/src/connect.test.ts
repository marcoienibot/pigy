import { expect, it } from "vitest";
import {
  connectErrorSchema,
  connectOutcomeOf,
  connectResponseSchemaFor,
} from "./connect.ts";

const refusal = { error: "InvalidInputError", message: "Not a server" };

// A form shows the message of a refusal next to the input that the
// refusal names, and has one input for each field of the request.
it.each(["network", "identifier"])(
  "keeps the field of a refusal that is about the %s",
  (field) => {
    expect(connectErrorSchema.parse({ ...refusal, field })).toEqual({
      ...refusal,
      field,
    });
  },
);

it("accepts a refusal that is about no field", () => {
  // What a server out of reach is answered with.
  const unreachable = { error: "UnexpectedError", message: "Not reachable" };

  expect(connectErrorSchema.parse(unreachable)).toEqual(unreachable);
});

it("rejects a refusal that names a field which the request does not have", () => {
  // A form would have no place for the message, and would show none.
  expect(
    connectErrorSchema.safeParse({ ...refusal, field: "password" }).success,
  ).toBe(false);
});

// Where `pnpm dev` serves the app, and where a deployment does.
const local = "http://localhost:5173";
const deployed = "https://pigy.example";

it.each([
  [
    "the consent page of a network",
    deployed,
    "https://mastodon.social/oauth/authorize?state=x",
  ],
  [
    "a simulated consent page of the app",
    deployed,
    `${deployed}/sim/network/mastodon.example/oauth/authorize?state=x`,
  ],
  [
    "a simulated consent page of an app in development",
    local,
    `${local}/sim/network/mastodon.example/oauth/authorize?state=x`,
  ],
])("accepts %s as where to send the browser", (_name, origin, url) => {
  expect(connectResponseSchemaFor(origin).parse({ url })).toEqual({ url });
});

// A page navigates to this address. Each of these would run a script in the
// page, or take the person somewhere over a connection that anybody can
// read and change.
it.each([
  ["a script", deployed, "javascript:alert(document.cookie)"],
  [
    "a page in the address itself",
    deployed,
    "data:text/html,<script>alert(1)</script>",
  ],
  [
    "a network without HTTPS",
    deployed,
    "http://mastodon.social/oauth/authorize",
  ],
  [
    "another site without HTTPS, for an app in development",
    local,
    "http://localhost:4173/sim/network/mastodon.example/oauth/authorize",
  ],
  [
    "a path, which names no site",
    deployed,
    "/sim/network/mastodon.example/oauth/authorize",
  ],
  ["an empty text", deployed, ""],
  ["something that is not text", deployed, 5],
  ["nothing", deployed, undefined],
])("rejects %s as where to send the browser", (_name, origin, url) => {
  expect(connectResponseSchemaFor(origin).safeParse({ url }).success).toBe(
    false,
  );
});

it("reads how a connection ended from the query that the callback sends", () => {
  const query = {
    connect: "connected",
    network: "mastodon",
    workspace: "0192f3a0-0000-7000-8000-000000000001",
    channel: "0192f3a0-0000-7000-8000-000000000002",
  };

  expect(connectOutcomeOf(query)).toEqual(query);
});

it("reads an outcome that comes with nothing else", () => {
  // What somebody gets whose connection is not found: the callback knows
  // neither the workspace nor a channel then.
  expect(connectOutcomeOf({ connect: "expired" })).toEqual({
    connect: "expired",
  });
});

it.each([
  ["a query without an outcome", { network: "mastodon" }],
  ["an outcome that is not one of the four", { connect: "hacked" }],
  // What a router makes of "?connect=1".
  ["an outcome that is not text", { connect: 1 }],
  ["no query", undefined],
])(
  "takes %s for an address that says nothing of a connection",
  (_name, query) => {
    expect(connectOutcomeOf(query)).toBeUndefined();
  },
);

it("keeps the outcome and leaves out what else is not as it should be", () => {
  // Anybody can make up the address. A network that pigy does not know, or
  // an ID that a router has read as a number, must not cost the person the
  // word on what happened.
  expect(
    connectOutcomeOf({
      connect: "failed",
      network: "myspace",
      workspace: 12,
      channel: "",
      more: "ignored",
    }),
  ).toEqual({ connect: "failed" });
});
