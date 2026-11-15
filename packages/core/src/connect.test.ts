import { expect, it } from "vitest";
import { connectErrorSchema } from "./connect.ts";

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
