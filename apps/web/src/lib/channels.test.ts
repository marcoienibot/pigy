import { describe, expect, it } from "vitest";
import {
  accessEnds,
  disconnectNotice,
  disconnectQuestion,
  handleShown,
  needsReconnecting,
} from "@/lib/channels";
import { dayOf } from "@/lib/time";

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 15, 12);

describe("accessEnds", () => {
  it("says nothing of an access that lasts or is renewed", () => {
    expect(
      accessEnds({ network: "mastodon", expiresAt: null }, now),
    ).toBeNull();
  });

  it("says nothing of the end of an access that pigy renews, as that of Threads, while it is far", () => {
    // The end moves with every renewal, which comes weeks before it.
    expect(
      accessEnds({ network: "threads", expiresAt: now + 60 * day }, now),
    ).toBeNull();
    expect(
      accessEnds({ network: "threads", expiresAt: now + 14 * day }, now),
    ).toBeNull();
  });

  it("names the day on which an access ends that pigy has not renewed for weeks, while the person can still connect again", () => {
    // Less than two weeks are left of the 60 days, of which the first
    // was to be the only one without a renewal.
    const expiresAt = now + 14 * day - 1;
    expect(accessEnds({ network: "threads", expiresAt }, now)).toBe(
      `pigy could not renew its access, which ends on ${dayOf(expiresAt, now)}: connect the account again before then.`,
    );
    // And when it has ended.
    expect(accessEnds({ network: "threads", expiresAt: now }, now)).toBe(
      "Its access has ended: connect the account again.",
    );
  });

  it("names the day on which an access ends, as LinkedIn's does after 60 days", () => {
    const expiresAt = now + 60 * day;
    // In the words of the device, and with the year: it is the next one.
    expect(accessEnds({ network: "linkedin", expiresAt }, now)).toBe(
      `Its access ends on ${dayOf(expiresAt, now)}: connect the account again before then.`,
    );
    expect(dayOf(expiresAt, now)).toContain("2027");
  });

  it("says that an access has ended once its time is up", () => {
    expect(accessEnds({ network: "linkedin", expiresAt: now }, now)).toBe(
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

describe("a disconnect", () => {
  const grace = { network: "threads", handle: "@grace" } as const;

  it("promises to give the access back where the network takes it back", () => {
    expect(disconnectQuestion("mastodon")).toBe(
      "pigy stops posting to this account, and gives the access that it has back to Mastodon. What is published there stays. You can connect the account again at any time.",
    );
  });

  it("says before the click what Threads cannot do, and where the person ends the access themselves", () => {
    const question = disconnectQuestion("threads");
    expect(question).not.toContain("gives the access");
    expect(question).toBe(
      "pigy stops posting to this account. Threads offers no way to hand back the access that pigy has: it ends by itself within 60 days. To end it sooner, remove pigy in the settings of the account at Threads, under Settings → Account → Website permissions. What is published there stays. You can connect the account again at any time.",
    );
  });

  it("says the same afterwards, and not as something that went wrong", () => {
    expect(disconnectNotice(grace, false)).toEqual({
      tone: "plain",
      text: "@grace is disconnected. Threads offers no way to hand back the access that pigy had: it ends by itself within 60 days. To end it sooner, remove pigy in the settings of the account at Threads, under Settings → Account → Website permissions.",
    });
  });

  it("says that it went wrong where a network that takes an access back did not", () => {
    expect(
      disconnectNotice({ network: "mastodon", handle: "@grace@m.test" }, false),
    ).toMatchObject({ tone: "bad" });
  });
});
