import { pushSubscriptionRequestSchema } from "@pigy/core";

/**
 * The notifications of this device: whether the browser can show them,
 * whether it may, and whether the server sends them here. Settings turn
 * them on and off with this.
 *
 * It takes the browser and the server as parameters, so that its tests
 * need neither: `browserDevice` and the calls of `lib/api.ts` are what the
 * app passes.
 */

/**
 * How the notifications of this device stand:
 *
 * - `unsupported`: this browser cannot show any.
 * - `needs-install`: an iPhone or iPad, where a page in the browser gets
 *   no push messages and an app on the Home Screen does.
 * - `no-app`: the page has no service worker, as in development.
 * - `blocked`: the person has refused the site, in the browser.
 * - `not-set-up`: this pigy has no key to send with.
 * - `off` and `on`.
 */
export type PushState =
  | "unsupported"
  | "needs-install"
  | "no-app"
  | "blocked"
  | "not-set-up"
  | "off"
  | "on";

/** What a subscription of the browser is to this module. */
export type DeviceSubscription = {
  endpoint: string;
  /** The key that it was made with, as bytes, where the browser says. */
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
};

/** What this module takes from the browser. */
export type PushDevice = {
  /** Whether the browser has push messages and notifications at all. */
  supported: boolean;
  /** An iPhone or iPad. */
  ios: boolean;
  /** pigy as an installed app, not a page in a browser. */
  installed: boolean;
  /** What the person has said about notifications of this site. */
  permission(): NotificationPermission;
  /** Asks them. To be called from a click, and from nothing else. */
  requestPermission(): Promise<NotificationPermission>;
  /** The push manager of the service worker, or undefined without one. */
  manager(): Promise<
    | {
        getSubscription(): Promise<DeviceSubscription | null>;
        subscribe(options: {
          userVisibleOnly: true;
          applicationServerKey: Uint8Array<ArrayBuffer>;
        }): Promise<DeviceSubscription>;
      }
    | undefined
  >;
};

/**
 * What the device remembers of the notifications that were turned on in
 * it: in which session, and with which subscription of the browser. A
 * browser can replace a subscription by itself, or lose it, and tells
 * only the service worker, if anybody. With this the app sees at its next
 * start that the subscription is no longer the one that was turned on,
 * and hands the server the new one: `renewPush`.
 *
 * It names the session, so that nothing is turned on by it for a session
 * that did not ask: somebody who signs in anew turns notifications on
 * again, as before.
 */
export type TurnedOn = { session: string; endpoint: string };

export type PushMemory = {
  read(): TurnedOn | null;
  write(turnedOn: TurnedOn | null): void;
};

/** What this module takes from the server: `lib/api.ts`. */
export type PushServer = {
  key(signal?: AbortSignal): Promise<string | null>;
  state(endpoint: string, signal?: AbortSignal): Promise<boolean>;
  save(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<void>;
  remove(endpoint: string): Promise<void>;
};

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
}

/** Whether `subscription` was made with the public key `key`. */
function madeWith(subscription: DeviceSubscription, key: string): boolean {
  const made = subscription.options.applicationServerKey;
  return made !== null && toBase64Url(made) === key;
}

/** What stands in the way of notifications on this device, if anything. */
function obstacle(
  device: PushDevice,
): Extract<PushState, "unsupported" | "needs-install" | "blocked"> | undefined {
  if (!device.supported) {
    // Safari on an iPhone has neither in a tab, and both in an app that
    // was added to the Home Screen.
    return device.ios && !device.installed ? "needs-install" : "unsupported";
  }
  return device.permission() === "denied" ? "blocked" : undefined;
}

/**
 * How the notifications of this device stand, without asking the person
 * anything. It asks the server, and fails as that request does when the
 * server cannot be reached.
 */
export async function readPushState(
  device: PushDevice,
  server: PushServer,
  signal?: AbortSignal,
): Promise<PushState> {
  const inTheWay = obstacle(device);
  if (inTheWay) return inTheWay;
  const manager = await device.manager();
  if (!manager) return "no-app";
  const key = await server.key(signal);
  if (key === null) return "not-set-up";
  const subscription = await manager.getSubscription();
  // A subscription that was made with another key than this pigy has now
  // is of no use: its push service takes no message from the new one.
  if (!subscription || !madeWith(subscription, key)) return "off";
  // The browser has a subscription. Whether the server sends to it is the
  // server's to say: the subscription may be from a session that is over,
  // or somebody else's who used this browser before.
  return (await server.state(subscription.endpoint, signal)) ? "on" : "off";
}

/**
 * Turns the notifications of this device on: asks the person, subscribes
 * the browser at its push service, and hands the server what it got. To
 * be called from a click: a browser lets a page ask only then, and pigy
 * asks at no other time.
 *
 * `dismissed` when the person has closed the question without an answer:
 * nothing is on, and they can be asked again.
 */
export async function turnOnPush(
  device: PushDevice,
  server: PushServer,
  memory: PushMemory,
  session: string | null,
): Promise<PushState | "dismissed"> {
  const inTheWay = obstacle(device);
  if (inTheWay) return inTheWay;
  // First, while the click still counts: some browsers do not ask once a
  // page has waited for something else.
  const permission = await device.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "dismissed";
  const manager = await device.manager();
  if (!manager) return "no-app";
  const key = await server.key();
  if (key === null) return "not-set-up";
  const before = await manager.getSubscription();
  // A browser keeps one subscription, and hands the same one out again
  // for as long as it stands. So one that is of no use has to go first:
  // one of another key, with which the browser makes no other, and one
  // that the server does not send to. The server has dropped that one
  // because its push service said that it is gone, or it is from a
  // session that is over, or of somebody else who used this browser.
  // Saved again as it is, the first would be turned "on" and never get
  // a message.
  if (
    before &&
    (!madeWith(before, key) || !(await server.state(before.endpoint)))
  ) {
    await before.unsubscribe();
  }
  const subscription = await manager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(key),
  });
  await save(server, subscription);
  memory.write(
    session === null ? null : { session, endpoint: subscription.endpoint },
  );
  return "on";
}

/** Hands the server what the browser got when it subscribed. */
async function save(
  server: PushServer,
  subscription: DeviceSubscription,
): Promise<void> {
  await server.save(
    pushSubscriptionRequestSchema.parse(
      // The form that a browser writes a subscription in has more than
      // pigy keeps: the time at which it ends, which no browser sets.
      pick(subscription.toJSON()),
    ),
  );
}

/**
 * Hands the server the subscription that the browser has now, if it is
 * no longer the one that was turned on in `session`: the browser has
 * replaced it, or lost it, in which case it subscribes anew. Nobody is
 * asked anything: the person has turned notifications on here, in this
 * session, and the browser still may show them.
 *
 * Does nothing for a session that turned nothing on, and nothing where
 * Settings would say something else than "on" or "off": there the person
 * has to do something first.
 */
export async function renewPush(
  device: PushDevice,
  server: PushServer,
  memory: PushMemory,
  session: string | null,
): Promise<void> {
  const turnedOn = memory.read();
  if (!turnedOn || turnedOn.session !== session) return;
  if (obstacle(device) || device.permission() !== "granted") return;
  const manager = await device.manager();
  if (!manager) return;
  const now = await manager.getSubscription();
  // As it was turned on: nothing to do, and nothing to ask the server.
  if (now?.endpoint === turnedOn.endpoint) return;
  const key = await server.key();
  if (key === null) return;
  // Of another key: this pigy has a new one, and Settings say "off".
  if (now && !madeWith(now, key)) return;
  const subscription =
    now ??
    (await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(key),
    }));
  await save(server, subscription);
  memory.write({ session: turnedOn.session, endpoint: subscription.endpoint });
}

/** The endpoint and the keys of what `PushSubscription.toJSON()` returns. */
function pick(json: unknown): unknown {
  const { endpoint, keys } = (json ?? {}) as Record<string, unknown>;
  const { p256dh, auth } = (keys ?? {}) as Record<string, unknown>;
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Turns the notifications of this device off: the browser ends its
 * subscription, and the server is told to forget it. The first works
 * without a connection, and is what counts: a push service refuses a
 * message for a subscription that has ended, and the server forgets it
 * then if it could not be told now.
 */
export async function turnOffPush(
  device: PushDevice,
  server: PushServer,
  memory: PushMemory,
): Promise<PushState> {
  // First: nothing is to turn them on again behind the person's back.
  memory.write(null);
  const manager = await device.manager();
  const subscription = await manager?.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
    await server.remove(subscription.endpoint).catch(() => undefined);
  }
  return obstacle(device) ?? (manager ? "off" : "no-app");
}
