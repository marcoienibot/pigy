import { describe, expect, it } from "vitest";
import { accessEnds, handleShown, needsReconnecting } from "@/lib/channels";
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

describe("needsReconnecting", () => {
  it("is so for a channel whose network has refused its access, and for one whose access has ended by its date", () => {
    expect(
      needsReconnecting({ status: "needs_reconnect", expiresAt: null }, now),
    ).toBe(true);
    // No post has been refused yet, so the status says nothing: the row
    // says that the access has ended, and has to offer what it asks for.
    expect(
      needsReconnecting({ status: "connected", expiresAt: now }, now),
    ).toBe(true);
  });

  it("is not so while the access lasts", () => {
    expect(
      needsReconnecting({ status: "connected", expiresAt: null }, now),
    ).toBe(false);
    expect(
      needsReconnecting({ status: "connected", expiresAt: now + 1 }, now),
    ).toBe(false);
  });
});

describe("handleShown", () => {
  const profileUrl = "https://bsky.app/profile/ada.bsky.test";

  it("is the handle with the link to the profile", () => {
    expect(
      handleShown({ handle: "@ada.bsky.test", name: "Ada", profileUrl }),
    ).toEqual({ handle: "@ada.bsky.test", url: profileUrl });
  });

  it("keeps the link of an account whose name is its handle, as a Bluesky account without a display name has it", () => {
    expect(
      handleShown({
        handle: "@ada.bsky.test",
        name: "@ada.bsky.test",
        profileUrl,
      }),
    ).toEqual({ handle: "@ada.bsky.test", url: profileUrl });
  });

  it("is nothing where the handle is the name and leads nowhere, as on LinkedIn", () => {
    expect(
      handleShown({
        handle: "Ada Lovelace",
        name: "Ada Lovelace",
        profileUrl: null,
      }),
    ).toBeNull();
    // A handle that says more than the name is shown without a link.
    expect(
      handleShown({ handle: "@ada@example", name: "Ada", profileUrl: null }),
    ).toEqual({ handle: "@ada@example", url: null });
  });
});
