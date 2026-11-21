import { describe, expect, it } from "vitest";
import { timeAgo, whenAgo } from "@/lib/time";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = Date.UTC(2026, 5, 15, 12);

describe("whenAgo", () => {
  it("reads as the end of a sentence, whatever the time is told in", () => {
    // Each of these follows "Published" on the Sent screen.
    expect(whenAgo(now - 20_000, now)).toBe("just now");
    expect(whenAgo(now - 5 * minute, now)).toBe("5m ago");
    expect(whenAgo(now - 3 * hour, now)).toBe("3h ago");
    expect(whenAgo(now - 2 * day, now)).toBe("2d ago");
    // A date, in the words of the device: "on" and not "ago".
    expect(whenAgo(now - 30 * day, now)).toBe(
      `on ${timeAgo(now - 30 * day, now)}`,
    );
  });

  it("takes a time that is ahead for now: the clocks of two devices differ", () => {
    expect(whenAgo(now + minute, now)).toBe("just now");
  });
});
