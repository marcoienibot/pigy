import { describe, expect, it } from "vitest";
import { accessEnds } from "@/lib/channels";
import { dayOf } from "@/lib/time";

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 15, 12);

describe("accessEnds", () => {
  it("says nothing of an access that lasts or is renewed", () => {
    expect(accessEnds({ expiresAt: null }, now)).toBeNull();
  });

  it("names the day on which an access ends, as LinkedIn's does after 60 days", () => {
    const expiresAt = now + 60 * day;
    // In the words of the device, and with the year: it is the next one.
    expect(accessEnds({ expiresAt }, now)).toBe(
      `Its access ends on ${dayOf(expiresAt, now)}: connect the account again before then.`,
    );
    expect(dayOf(expiresAt, now)).toContain("2027");
  });

  it("says that an access has ended once its time is up", () => {
    expect(accessEnds({ expiresAt: now }, now)).toBe(
      "Its access has ended: connect the account again.",
    );
  });
});
