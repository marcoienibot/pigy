import { describe, expect, it } from "vitest";
import {
  type DeviceSubscription,
  type PushDevice,
  type PushServer,
  readPushState,
  turnOffPush,
  turnOnPush,
} from "./push.ts";

/** A key of a sender as the server hands it out: 65 bytes in base64url. */
const keyOf = (fill: number) =>
  btoa(String.fromCharCode(...new Uint8Array(65).fill(fill)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const key = keyOf(1);

/**
 * A browser and a server, for a person who answers the question about
 * notifications with `answer`. Both note what was asked of them.
 */
function setup(
  options: {
    device?: Partial<PushDevice>;
    permission?: NotificationPermission;
    answer?: NotificationPermission;
    /** The key that the browser's subscription was made with, if it has one. */
    subscribedWith?: string;
    serverKey?: string | null;
    /** The endpoints that the server sends to. */
    known?: string[];
  } = {},
) {
  const log: string[] = [];
  let permission = options.permission ?? "default";
  let subscription: DeviceSubscription | null = null;
  const subscribe = (made: Uint8Array<ArrayBuffer>): DeviceSubscription => {
    const endpoint = `https://push.example/${made[0]}`;
    return {
      endpoint,
      options: { applicationServerKey: made.buffer },
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: { p256dh: "device-key", auth: "device-secret" },
      }),
      unsubscribe: async () => {
        log.push(`unsubscribe ${endpoint}`);
        subscription = null;
        return true;
      },
    };
  };
  if (options.subscribedWith) {
    subscription = subscribe(
      Uint8Array.from(
        atob(options.subscribedWith.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      ),
    );
  }
  const known = new Set(options.known ?? []);
  const device: PushDevice = {
    supported: true,
    ios: false,
    installed: false,
    permission: () => permission,
    requestPermission: async () => {
      log.push("ask the person");
      permission = options.answer ?? "granted";
      return permission;
    },
    manager: async () => ({
      getSubscription: async () => subscription,
      subscribe: async ({ applicationServerKey }) => {
        log.push("subscribe");
        subscription = subscribe(applicationServerKey);
        return subscription;
      },
    }),
    ...options.device,
  };
  const server: PushServer = {
    key: async () => {
      log.push("ask for the key");
      return options.serverKey === undefined ? key : options.serverKey;
    },
    state: async (endpoint) => known.has(endpoint),
    save: async (saved) => {
      log.push(`save ${JSON.stringify(saved)}`);
      known.add(saved.endpoint);
    },
    remove: async (endpoint) => {
      log.push(`remove ${endpoint}`);
      known.delete(endpoint);
    },
  };
  return { device, server, log };
}

describe("how the notifications of a device stand", () => {
  it("is off for a browser that has never been asked", async () => {
    const { device, server, log } = setup();

    expect(await readPushState(device, server)).toBe("off");
    // Reading asks the person nothing.
    expect(log).not.toContain("ask the person");
  });

  it("is on when the browser is subscribed and the server sends to it", async () => {
    const { device, server } = setup({
      permission: "granted",
      subscribedWith: key,
      known: ["https://push.example/1"],
    });

    expect(await readPushState(device, server)).toBe("on");
  });

  it("is off when the browser is subscribed and the server does not send to it", async () => {
    // The subscription is from a session that is over, or somebody else's.
    const { device, server } = setup({
      permission: "granted",
      subscribedWith: key,
    });

    expect(await readPushState(device, server)).toBe("off");
  });

  it("is off when the browser subscribed with a key that this pigy no longer has", async () => {
    const { device, server } = setup({
      permission: "granted",
      subscribedWith: keyOf(2),
      // The server still has the row: it is asked about the key first.
      known: ["https://push.example/2"],
    });

    expect(await readPushState(device, server)).toBe("off");
  });

  it("says that the person has blocked the site", async () => {
    const { device, server } = setup({ permission: "denied" });

    expect(await readPushState(device, server)).toBe("blocked");
  });

  it("says that this pigy is not set up to send", async () => {
    const { device, server } = setup({ serverKey: null });

    expect(await readPushState(device, server)).toBe("not-set-up");
  });

  it("says that an iPhone needs pigy on its Home Screen", async () => {
    const tab = setup({ device: { supported: false, ios: true } });
    expect(await readPushState(tab.device, tab.server)).toBe("needs-install");
    // Nothing is asked of a server for a browser that cannot subscribe.
    expect(tab.log).toEqual([]);

    // Installed, the same phone can: the browser has what it takes there.
    const app = setup({ device: { ios: true, installed: true } });
    expect(await readPushState(app.device, app.server)).toBe("off");
  });

  it("says that a browser has no notifications, and that a page has no service worker", async () => {
    const old = setup({ device: { supported: false } });
    expect(await readPushState(old.device, old.server)).toBe("unsupported");

    const development = setup({ device: { manager: async () => undefined } });
    expect(await readPushState(development.device, development.server)).toBe(
      "no-app",
    );
  });

  it("fails as the request does when the server cannot be asked", async () => {
    const { device, server } = setup();
    server.key = async () => {
      throw new Error("No answer");
    };

    await expect(readPushState(device, server)).rejects.toThrow("No answer");
  });
});

describe("turning notifications on", () => {
  it("asks the person first, subscribes, and hands the server the endpoint and the keys", async () => {
    const { device, server, log } = setup();

    expect(await turnOnPush(device, server)).toBe("on");

    expect(log).toEqual([
      // Before anything that waits for the server: a browser lets a page
      // ask only while the click still counts.
      "ask the person",
      "ask for the key",
      "subscribe",
      // Without what else a browser writes into a subscription.
      'save {"endpoint":"https://push.example/1","keys":{"p256dh":"device-key","auth":"device-secret"}}',
    ]);
    expect(await readPushState(device, server)).toBe("on");
  });

  it("turns nothing on when the person refuses", async () => {
    const { device, server, log } = setup({ answer: "denied" });

    expect(await turnOnPush(device, server)).toBe("blocked");

    expect(log).toEqual(["ask the person"]);
  });

  it("turns nothing on when the person closes the question", async () => {
    const { device, server, log } = setup({ answer: "default" });

    expect(await turnOnPush(device, server)).toBe("dismissed");

    expect(log).toEqual(["ask the person"]);
    // They can be asked again.
    expect(await readPushState(device, server)).toBe("off");
  });

  it("does not ask a person whose browser cannot subscribe", async () => {
    const { device, server, log } = setup({
      device: { supported: false, ios: true },
    });

    expect(await turnOnPush(device, server)).toBe("needs-install");

    expect(log).toEqual([]);
  });

  it("subscribes anew when the browser has a subscription of another key", async () => {
    const { device, server, log } = setup({
      permission: "granted",
      subscribedWith: keyOf(2),
    });

    expect(await turnOnPush(device, server)).toBe("on");

    expect(log).toContain("unsubscribe https://push.example/2");
    expect(log.at(-1)).toContain('"endpoint":"https://push.example/1"');
  });

  it("subscribes nothing for a pigy that is not set up to send", async () => {
    const { device, server, log } = setup({ serverKey: null });

    expect(await turnOnPush(device, server)).toBe("not-set-up");

    expect(log).not.toContain("subscribe");
  });
});

describe("turning notifications off", () => {
  it("ends the subscription of the browser and has the server forget it", async () => {
    const { device, server, log } = setup({
      permission: "granted",
      subscribedWith: key,
      known: ["https://push.example/1"],
    });

    expect(await turnOffPush(device, server)).toBe("off");

    expect(log).toEqual([
      "unsubscribe https://push.example/1",
      "remove https://push.example/1",
    ]);
    expect(await readPushState(device, server)).toBe("off");
  });

  it("ends the subscription also when the server cannot be told", async () => {
    const { device, server, log } = setup({
      permission: "granted",
      subscribedWith: key,
    });
    server.remove = async () => {
      throw new Error("No answer");
    };

    // The push service refuses the next message, and the server forgets
    // the device then.
    expect(await turnOffPush(device, server)).toBe("off");
    expect(log).toEqual(["unsubscribe https://push.example/1"]);
  });
});
