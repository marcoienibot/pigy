import { createPushSimulator } from "@pigy/simulators/push";
import { describe, expect, it } from "vitest";
import { parseVapidKey } from "../src/push/keys.ts";
import { pushSubject } from "../src/push/notify.ts";
import {
  encryptPush,
  fromBase64Url,
  maxPushBytes,
  sendPush,
  toBase64Url,
} from "../src/push/web-push.ts";
import { vapidPrivateKey } from "./helpers.ts";

const start = new Date("2026-11-14T10:00:00Z");
const now = () => start;
const text = (value: string) => new TextEncoder().encode(value);
const options = { ttlSeconds: 60, subject: "https://pigy.test" };

/** The bytes of base64url that a test wrote out. */
function bytes(value: string) {
  const decoded = fromBase64Url(value);
  if (!decoded) throw new Error("Not base64url");
  return decoded;
}

it("encrypts the example of RFC 8291 to the bytes that the RFC has", async () => {
  // Section 5 and appendix A: everything that is random in a message is
  // given there, so the result is too.
  const senderPublic = bytes(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  const keys = {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(senderPublic.slice(1, 33)),
        y: toBase64Url(senderPublic.slice(33)),
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        ext: true,
      },
      algorithm,
      true,
      ["deriveBits"],
    ),
    publicKey: await crypto.subtle.importKey(
      "raw",
      senderPublic,
      algorithm,
      true,
      [],
    ),
  };

  const message = await encryptPush(
    {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    text("When I grow up, I want to be a watermelon"),
    { salt: bytes("DGv6ra1nlYgDCS1FRnbzlw"), keys },
  );

  expect(message && toBase64Url(message)).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

it("encrypts every message with a salt and a key of its own", async () => {
  const push = createPushSimulator({ now });
  const key = await parseVapidKey(vapidPrivateKey);
  const { keys } = await push.subscribe({
    applicationServerKey: key.publicKey,
  });

  const first = await encryptPush(keys, text("Hello"));
  const second = await encryptPush(keys, text("Hello"));

  // The same text twice is not the same bytes twice: neither the salt,
  // which is the first 16, nor what follows.
  expect(first?.slice(0, 16)).not.toEqual(second?.slice(0, 16));
  expect(first?.slice(21)).not.toEqual(second?.slice(21));
});

it.each([
  [
    "a key that is too short",
    { p256dh: "abc", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
  ],
  [
    "a key that is no point of the curve",
    {
      p256dh: toBase64Url(new Uint8Array(65).fill(4)),
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  ],
  [
    "a secret of the wrong length",
    {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "abc",
    },
  ],
  ["what is not base64url", { p256dh: "a b", auth: "c d" }],
])("encrypts nothing for %s", async (_what, keys) => {
  expect(await encryptPush(keys, text("Hello"))).toBeUndefined();
});

describe("sending", () => {
  async function setup() {
    const push = createPushSimulator({ now });
    const key = await parseVapidKey(vapidPrivateKey);
    const subscription = await push.subscribe({
      applicationServerKey: key.publicKey,
    });
    const target = { endpoint: subscription.endpoint, ...subscription.keys };
    return { push, key, target };
  }

  it("sends what the push service takes and the device reads", async () => {
    const { push, key, target } = await setup();

    const outcome = await sendPush(
      { fetch: push.fetch, now },
      key,
      target,
      text("Hello, déjà vu 👋"),
      { ...options, topic: "abc" },
    );

    expect(outcome).toEqual({ outcome: "sent" });
    expect(push.received(target.endpoint)).toMatchObject([
      { payload: "Hello, déjà vu 👋", ttl: 60, topic: "abc" },
    ]);
  });

  it("says that a subscription is gone when the push service does", async () => {
    const { push, key, target } = await setup();
    push.unsubscribe(target.endpoint);

    const ended = await sendPush(
      { fetch: push.fetch, now },
      key,
      target,
      text("Hello"),
      options,
    );
    const never = await sendPush(
      { fetch: push.fetch, now },
      key,
      { ...target, endpoint: `${target.endpoint}x` },
      text("Hello"),
      options,
    );

    // 410 and 404.
    expect(ended).toEqual({ outcome: "gone" });
    expect(never).toEqual({ outcome: "gone" });
  });

  it("says what a push service answered that did not take the message", async () => {
    const { push, key, target } = await setup();

    push.arm("rate-limit");
    expect(
      await sendPush(
        { fetch: push.fetch, now },
        key,
        target,
        text("Hello"),
        options,
      ),
    ).toEqual({ outcome: "refused", status: 429 });

    // A sender that the subscription was not made with.
    const other = await parseVapidKey(
      (await import("../src/development-keys.ts")).developmentVapidKey,
    );
    expect(
      await sendPush(
        { fetch: push.fetch, now },
        other,
        target,
        text("Hello"),
        options,
      ),
    ).toEqual({ outcome: "refused", status: 403 });
  });

  it("says that a push service is out of reach when no answer comes", async () => {
    const { push, key, target } = await setup();
    push.arm("lost-response");

    const outcome = await sendPush(
      { fetch: push.fetch, now },
      key,
      target,
      text("Hello"),
      options,
    );

    expect(outcome).toEqual({ outcome: "unreachable" });
  });

  it("passes on what is no failure of a network", async () => {
    const { key, target } = await setup();
    const broken = async () => {
      throw new Error("A bug behind fetch");
    };

    await expect(
      sendPush({ fetch: broken, now }, key, target, text("Hello"), options),
    ).rejects.toThrow("A bug behind fetch");
  });

  it("follows no redirect of a push service", async () => {
    const { key, target } = await setup();
    let asked: RequestInit | undefined;
    const elsewhere = async (_input: RequestInfo | URL, init?: RequestInit) => {
      asked = init;
      return new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.example/" },
      });
    };

    const outcome = await sendPush(
      { fetch: elsewhere, now },
      key,
      target,
      text("Hello"),
      options,
    );

    // The runtime is told not to follow, and the answer counts as a
    // refusal: the message went nowhere.
    expect(asked?.redirect).toBe("manual");
    expect(outcome).toEqual({ outcome: "refused", status: 307 });
  });

  it("refuses to send a message that no push service has to take", async () => {
    const { push, key, target } = await setup();

    await expect(
      sendPush(
        { fetch: push.fetch, now },
        key,
        target,
        new Uint8Array(maxPushBytes),
        options,
      ),
    ).rejects.toThrow("larger than a push service takes");
    expect(push.received(target.endpoint)).toEqual([]);
  });

  it("sends nothing for keys that no browser hands out", async () => {
    const { push, key, target } = await setup();
    const requests: unknown[] = [];

    const outcome = await sendPush(
      {
        fetch: (input, init) => {
          requests.push(input);
          return push.fetch(input, init);
        },
        now,
      },
      key,
      { ...target, auth: "abc" },
      text("Hello"),
      options,
    );

    expect(outcome).toEqual({ outcome: "gone" });
    expect(requests).toEqual([]);
  });
});

describe("the key of the sender", () => {
  it("is read as openssl writes it, with its public half as a browser takes it", async () => {
    const key = await parseVapidKey(vapidPrivateKey);

    const publicKey = bytes(key.publicKey);
    // The uncompressed point: 4, then the two coordinates of the key.
    expect(publicKey).toHaveLength(65);
    expect(publicKey[0]).toBe(4);
    expect(toBase64Url(publicKey.slice(1, 33))).toBe(key.privateKey.x);
    expect(toBase64Url(publicKey.slice(33))).toBe(key.privateKey.y);
  });

  it.each([
    ["nothing", ""],
    ["no base64", "not a key"],
    ["a key for something else", btoa("a".repeat(32))],
  ])(
    "is refused when it is %s, without being repeated",
    async (_what, configured) => {
      const failure = await parseVapidKey(configured).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "VAPID_PRIVATE_KEY is not a key of P-256 in PKCS #8 and base64",
      );
    },
  );
});

it.each([
  ["https://pigy.example", "https://pigy.example"],
  ["https://pigy.example/settings", "https://pigy.example"],
  // A pigy on somebody's machine has no address that a push service
  // could turn to.
  ["http://localhost:4173", "mailto:pigy@localhost"],
])("names %s as who sends with %s", (origin, subject) => {
  expect(pushSubject(origin)).toBe(subject);
});
