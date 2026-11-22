import { expect, it } from "vitest";
import {
  authorization,
  b64,
  encrypted,
  newSender,
  type Sender,
  unb64,
} from "../../test/push-client.ts";
import { createPushSimulator, pushHosts } from "./index.ts";

const start = new Date("2026-11-14T10:00:00Z");

/** A push service, a sender, and a device that is subscribed with its key. */
async function setup() {
  const clock = { time: start };
  const service = createPushSimulator({ now: () => clock.time });
  const sender = await newSender();
  const subscription = await service.subscribe({
    applicationServerKey: sender.publicKey,
  });
  return { clock, service, sender, subscription };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Sends "Hello" to the device as a sender should, with `headers` in the
 * place of what it would send: a null leaves a header out.
 */
async function push(
  { service, sender, subscription, clock }: Setup,
  headers: Record<string, string | null> = {},
  body?: Uint8Array<ArrayBuffer>,
  as: Sender = sender,
): Promise<Response> {
  const all = new Headers({
    Authorization: await authorization(as, subscription.endpoint, clock.time),
    "Content-Encoding": "aes128gcm",
    TTL: "60",
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) all.delete(name);
    else all.set(name, value);
  }
  return service.fetch(subscription.endpoint, {
    method: "POST",
    headers: all,
    body: body ?? (await encrypted(subscription.keys, "Hello")),
  });
}

it("takes a message and hands the device what it decrypts", async () => {
  const test = await setup();

  const response = await push(test, { Urgency: "high", Topic: "abc_123-" });

  expect(response.status).toBe(201);
  // RFC 8030 section 5: the answer names the message.
  expect(response.headers.get("Location")).toMatch(
    /^https:\/\/fcm\.googleapis\.com\/message\//,
  );
  expect(test.service.received(test.subscription.endpoint)).toEqual([
    {
      payload: "Hello",
      unreadable: undefined,
      ttl: 60,
      urgency: "high",
      topic: "abc_123-",
      sender: {
        aud: "https://fcm.googleapis.com",
        exp: start.getTime() / 1000 + 3600,
        sub: "mailto:tests@pigy.example",
      },
      receivedAt: start.getTime(),
    },
  ]);
});

it("decrypts the example of RFC 8291", async () => {
  const service = createPushSimulator({ now: () => start });
  // Section 5 and appendix A of RFC 8291: the keys of the user agent, and
  // the message as the application server sends it.
  const publicKey = unb64(
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  );
  const sender = await newSender();
  const subscription = await service.subscribe({
    applicationServerKey: sender.publicKey,
    device: {
      privateKey: {
        kty: "EC",
        crv: "P-256",
        x: b64(publicKey.slice(1, 33)),
        y: b64(publicKey.slice(33)),
        d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
      },
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  });

  const response = await service.fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await authorization(sender, subscription.endpoint, start),
      "Content-Encoding": "aes128gcm",
      TTL: "10",
    },
    body: unb64(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    ),
  });

  expect(response.status).toBe(201);
  expect(service.received(subscription.endpoint)[0]?.payload).toBe(
    "When I grow up, I want to be a watermelon",
  );
});

it("answers on the hosts of the push services, and on no other", async () => {
  const { service, sender } = await setup();

  for (const host of pushHosts) {
    const { endpoint } = await service.subscribe({
      applicationServerKey: sender.publicKey,
      host,
    });
    expect(new URL(endpoint).host).toBe(host);
    expect(service.owns(host)).toBe(true);
  }
  expect(service.owns("push.example.com")).toBe(false);
  // As a `fetch` fails for a host that is not there.
  await expect(
    service.fetch("https://push.example.com/push/abc", { method: "POST" }),
  ).rejects.toBeInstanceOf(TypeError);
});

it("makes endpoints that no real push service could have issued", async () => {
  const { subscription } = await setup();

  expect(subscription.endpoint).toContain("/pigy-sim-");
});

it("answers 404 for a subscription that never was, and 410 for one that has ended", async () => {
  const test = await setup();
  const { service, sender, subscription, clock } = test;

  const unknown = await service.fetch(`${subscription.endpoint}x`, {
    method: "POST",
    headers: {
      Authorization: await authorization(
        sender,
        subscription.endpoint,
        clock.time,
      ),
      TTL: "60",
    },
  });
  expect(unknown.status).toBe(404);

  service.unsubscribe(subscription.endpoint);
  expect((await push(test)).status).toBe(410);
  expect(service.received(subscription.endpoint)).toEqual([]);
});

it("refuses anything but a POST", async () => {
  const { service, subscription } = await setup();

  const response = await service.fetch(subscription.endpoint);

  expect(response.status).toBe(405);
});

it.each([
  ["no Authorization", null, 401],
  ["another scheme", "Bearer abc", 401],
  ["no key", "vapid t=abc", 401],
])("refuses a request with %s", async (_what, value, status) => {
  const test = await setup();

  const response = await push(test, { Authorization: value });

  expect(response.status).toBe(status);
  expect(test.service.received(test.subscription.endpoint)).toEqual([]);
});

it("refuses a sender whose key is not the one that the device subscribed with", async () => {
  const test = await setup();
  const other = await newSender();

  // A token that verifies, with its own key: RFC 8292 section 4.2 has
  // the subscription take messages from the key it was made with alone.
  const response = await push(test, {}, undefined, other);

  expect(response.status).toBe(403);
});

it("refuses a token that is signed with another key than it names", async () => {
  const test = await setup();
  const other = await newSender();
  const forged = await authorization(other, test.subscription.endpoint, start);

  const response = await push(test, {
    // The token of somebody else under the key of the subscription.
    Authorization: forged.replace(/k=.*$/, `k=${test.sender.publicKey}`),
  });

  expect(response.status).toBe(403);
});

it.each([
  [
    "for another push service",
    { aud: "https://updates.push.services.mozilla.com" },
    403,
  ],
  ["that has run out", { exp: start.getTime() / 1000 - 1 }, 403],
  [
    "that is good for more than a day",
    { exp: start.getTime() / 1000 + 86_401 },
    400,
  ],
  ["without a contact", { sub: undefined }, 403],
  ["with a contact that is no address", { sub: "pigy" }, 403],
])("refuses a token %s", async (_what, claims, status) => {
  const test = await setup();

  const response = await push(test, {
    Authorization: await authorization(
      test.sender,
      test.subscription.endpoint,
      start,
      claims,
    ),
  });

  expect(response.status).toBe(status);
  expect(test.service.received(test.subscription.endpoint)).toEqual([]);
});

it("goes by its own clock for the time of a token", async () => {
  const test = await setup();
  const token = await authorization(
    test.sender,
    test.subscription.endpoint,
    start,
  );
  expect((await push(test, { Authorization: token })).status).toBe(201);

  // The token was good for an hour.
  test.clock.time = new Date(start.getTime() + 61 * 60 * 1000);

  expect((await push(test, { Authorization: token })).status).toBe(403);
});

it.each([
  ["without TTL", { TTL: null }, 400],
  ["with a TTL that is no number", { TTL: "soon" }, 400],
  ["with an urgency that there is not", { Urgency: "urgent" }, 400],
  ["with a topic of more than 32 characters", { Topic: "a".repeat(33) }, 400],
  ["with a topic outside base64url", { Topic: "a topic" }, 400],
  ["in another encoding", { "Content-Encoding": "aesgcm" }, 415],
])("refuses a message %s", async (_what, headers, status) => {
  const test = await setup();

  const response = await push(test, headers);

  expect(response.status).toBe(status);
  expect(test.service.received(test.subscription.endpoint)).toEqual([]);
});

it("refuses a message of more than 4096 bytes, and takes one of exactly that", async () => {
  const test = await setup();
  // The header is 86 bytes, and the encryption adds the byte that ends the
  // record and 16 of its tag.
  const fits = "a".repeat(4096 - 86 - 17);

  const most = await push(
    test,
    {},
    await encrypted(test.subscription.keys, fits),
  );
  const over = await push(
    test,
    {},
    await encrypted(test.subscription.keys, `${fits}a`),
  );

  expect(most.status).toBe(201);
  expect(over.status).toBe(413);
  expect(test.service.received(test.subscription.endpoint)).toHaveLength(1);
});

it("takes a message that its device cannot read, as a push service does, and says why the device dropped it", async () => {
  const test = await setup();
  const { service, sender, subscription } = test;
  // Encrypted for another device: the service has no way to know.
  const other = await service.subscribe({
    applicationServerKey: sender.publicKey,
  });

  const response = await push(test, {}, await encrypted(other.keys, "Hello"));

  expect(response.status).toBe(201);
  expect(service.received(subscription.endpoint)).toMatchObject([
    {
      payload: undefined,
      unreadable: "The message does not decrypt with the keys",
    },
  ]);
});

it.each([
  [
    "does not end as the last record",
    { padding: Uint8Array.of(1) },
    "The record does not end as a last record",
  ],
  [
    "is longer than the record size that it names",
    { recordSize: 18 },
    "The message is more than one record",
  ],
])("has the device drop a message that %s", async (_what, bend, why) => {
  const test = await setup();

  await push(test, {}, await encrypted(test.subscription.keys, "Hello", bend));

  expect(test.service.received(test.subscription.endpoint)[0]?.unreadable).toBe(
    why,
  );
});

it("reads a message that is padded", async () => {
  const test = await setup();

  // RFC 8188 section 2: zeros may follow the byte that ends the record.
  await push(
    test,
    {},
    await encrypted(test.subscription.keys, "Hello", {
      padding: Uint8Array.of(2, 0, 0, 0),
    }),
  );

  expect(test.service.received(test.subscription.endpoint)[0]?.payload).toBe(
    "Hello",
  );
});

it("fails the next request as it is armed to, once", async () => {
  const test = await setup();
  const { service, subscription } = test;

  service.arm("rate-limit");
  const limited = await push(test);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");

  service.arm("server-error");
  expect((await push(test)).status).toBe(500);
  expect(service.received(subscription.endpoint)).toEqual([]);

  // The message arrives, and the sender never hears of it.
  service.arm("lost-response");
  await expect(push(test)).rejects.toBeInstanceOf(TypeError);
  expect(service.received(subscription.endpoint)).toHaveLength(1);

  expect((await push(test)).status).toBe(201);
});

it("refuses to subscribe a device with something that is no key of a sender", async () => {
  const { service } = await setup();

  await expect(
    service.subscribe({ applicationServerKey: "abc" }),
  ).rejects.toThrow("not a public key of P-256");
});
