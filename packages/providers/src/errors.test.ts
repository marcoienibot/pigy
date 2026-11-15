import { describe, expect, it } from "vitest";
import { ProviderError, quotable } from "./errors.ts";

describe("quotable", () => {
  it("takes the secrets out, wherever and however often they are", () => {
    expect(
      quotable("token abc123 is bad, abc123! And so is s3cr3t.", [
        "abc123",
        "s3cr3t",
      ]),
    ).toBe("token [removed] is bad, [removed]! And so is [removed].");
  });

  it("leaves a text alone when there is no secret to look for", () => {
    // An empty secret would match everywhere.
    expect(quotable("Text can't be blank", [""])).toBe("Text can't be blank");
  });

  it("cuts a long text after the secrets are out", () => {
    const secret = "s".repeat(40);
    // The secret straddles the place where the text is cut. Cutting first
    // would leave half of it behind.
    const quoted = quotable("a".repeat(280) + secret + "b".repeat(100), [
      secret,
    ]);
    expect(quoted).not.toContain("s");
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBe(301);
  });

  it("puts what a network sent on one line", () => {
    // A line break could make one entry of a log look like two.
    expect(quotable("first\r\nsecond\tthird\u0000", [])).toBe(
      "first second third",
    );
  });
});

describe("ProviderError", () => {
  it("says what to do, and when, and what the network answered", () => {
    const retryAt = new Date("2026-11-15T10:05:00Z");
    const error = new ProviderError("retry", "Busy", { retryAt, status: 429 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      kind: "retry",
      message: "Busy",
      retryAt,
      status: 429,
    });
  });
});
