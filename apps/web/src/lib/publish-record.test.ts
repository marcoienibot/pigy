import type { PublishRequest } from "@pigy/core";
import { expect, it } from "vitest";
import {
  outcomeWords,
  recordEntries,
  selectRecorded,
  selectRecordNames,
  sourceWords,
} from "./publish-record.ts";
import { channel, post, tablesOf, target } from "./rows.test-support.ts";

const keyId = "0123456789abcdef";

const request = (fields: Partial<PublishRequest> = {}): PublishRequest => ({
  postId: "post",
  requestedAt: 1000,
  source: "app",
  apiKeyId: null,
  deliveries: [],
  ...fields,
});

it("names the key of a request of the API as the API screen does, by how it begins", () => {
  const words = sourceWords({ source: "api", apiKeyId: keyId }, "sandbox");
  expect(words).toBe("Published with the API key pigy_test_01234567…");
  // The ID is no secret, but the screen shows no more of it than the list
  // of keys does, where the person recognises it.
  expect(words).not.toContain(keyId);
  expect(sourceWords({ source: "queue", apiKeyId: null }, "live")).toBe(
    "Sent from the queue",
  );
  // A source that a later release of pigy has added.
  expect(sourceWords({ source: "other", apiKeyId: null }, "live")).toBe(
    "Published",
  );
});

it("tells a delivery that went wrong from one that is under way or was called off", () => {
  expect(outcomeWords("error").tone).toBe("failed");
  expect(outcomeWords("uncertain").tone).toBe("failed");
  expect(outcomeWords(null)).toEqual({ words: "On its way", tone: "open" });
  // The person disconnected the account: nothing to fix.
  expect(outcomeWords("disconnected").tone).toBe("open");
  expect(outcomeWords("sent").tone).toBe("done");
});

it("names the accounts that are still there, and leads to a post that the Sent screen has", () => {
  const connected = channel({ handle: "@ada@mastodon.test" });
  const sent = post({ status: "sent" });
  const names = selectRecordNames(
    tablesOf({
      channel: [connected],
      post: [sent, post({ id: "draft", status: "draft" })],
    }),
  );

  const [published, deleted, takenBack] = recordEntries(
    [
      request({
        postId: sent.id,
        deliveries: [
          {
            targetId: "a",
            channelId: connected.id,
            network: "mastodon",
            outcome: "sent",
            endedAt: 2000,
          },
          {
            targetId: "b",
            channelId: "gone",
            network: "bluesky",
            outcome: "error",
            endedAt: 2000,
          },
        ],
      }),
      // A post that was deleted since, and one that was taken back to the
      // drafts after it failed: the Sent screen has neither.
      request({ postId: "deleted", requestedAt: 900 }),
      request({ postId: "draft", requestedAt: 800 }),
    ],
    names,
    "live",
  );

  expect(published).toMatchObject({
    key: 1000,
    source: "Published in the app",
    postId: sent.id,
    deliveries: [
      { account: "@ada@mastodon.test", network: "Mastodon", outcome: "Sent" },
      {
        account: "An account that was disconnected",
        network: "Bluesky",
        tone: "failed",
      },
    ],
  });
  expect(deleted?.postId).toBeNull();
  expect(takenBack?.postId).toBeNull();
});

it("changes what the record goes by when a delivery is asked for or ends, and not when a draft changes", () => {
  const draft = target("post", "channel", { id: "a" });
  const before = selectRecorded(tablesOf({ post_target: [draft] }));
  // Choosing an account for a draft asks for nothing.
  expect(
    selectRecorded(
      tablesOf({
        post_target: [draft, target("post", "other", { id: "b" })],
      }),
    ),
  ).toBe(before);

  const queued = { ...draft, status: "queued" as const, queuedAt: 1000 };
  const asked = selectRecorded(tablesOf({ post_target: [queued] }));
  expect(asked).not.toBe(before);
  const ended = selectRecorded(
    tablesOf({ post_target: [{ ...queued, status: "error" }] }),
  );
  expect(ended).not.toBe(asked);
  // Tried again: the same target, asked for anew.
  expect(
    selectRecorded(
      tablesOf({
        post_target: [{ ...queued, status: "queued", queuedAt: 3000 }],
      }),
    ),
  ).not.toBe(asked);
});
