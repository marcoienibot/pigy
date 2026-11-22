import { describe, expect, it } from "vitest";
import {
  type DeviceSubscription,
  type PushDevice,
  type PushMemory,
  type PushServer,
  readPushState,
  renewPush,
  type TurnedOn,
  turnOffPush,
  turnOnPush,
} from "./push.ts";

/** The session that the device holds in these tests. */
const session = "ada/1";

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
    /** What the device remembers of notifications that were turned on. */
    turnedOn?: TurnedOn;
    /** What the server refuses a subscription with, if it does. */
    refusal?: Error;
  } = {},
) {
  const log: string[] = [];
  // The answers of the server that a test holds back: each waits here
  // until the test lets it go.
  const held = new Map<"key" | "save", Promise<void>>();
  let permission = options.permission ?? "default";
  let subscription: DeviceSubscription | null = null;
  let made = 0;
  const subscribe = (key: Uint8Array<ArrayBuffer>): DeviceSubscription => {
    // A browser hands out another address with every subscription that
    // it makes: "1" for the first with the key 1, then "1-2".
    made += 1;
    const endpoint = `https://push.example/${key[0]}${made > 1 ? `-${made}` : ""}`;
    return {
      endpoint,
      options: { applicationServerKey: key.buffer },
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
        // A browser keeps one subscription, and hands it out again for
        // as long as it stands.
        subscription ??= subscribe(applicationServerKey);
        return subscription;
      },
    }),
    ...options.device,
  };
  const server: PushServer = {
    key: async () => {
      log.push("ask for the key");
      await held.get("key");
      return options.serverKey === undefined ? key : options.serverKey;
    },
    state: async (endpoint) => known.has(endpoint),
    save: async (saved) => {
      log.push(`save ${JSON.stringify(saved)}`);
      if (options.refusal) throw options.refusal;
      // The server has it from here on, whenever its answer arrives.
      known.add(saved.endpoint);
      await held.get("save");
    },
    remove: async (endpoint) => {
      log.push(`remove ${endpoint}`);
      known.delete(endpoint);
    },
  };
  let turnedOn = options.turnedOn ?? null;
  const memory: PushMemory & { kept(): TurnedOn | null } = {
    read: () => turnedOn,
    write: (value) => {
      turnedOn = value;
    },
    kept: () => turnedOn,
  };
  return {
    device,
    server,
    log,
    memory,
    /** The endpoints that the server sends to. */
    known: () => [...known],
    /** The subscription that the browser has. */
    subscribed: () => subscription?.endpoint ?? null,
    /**
     * Holds the next answers of the server to `what` back, and returns
     * what lets them go.
     */
    hold(what: "key" | "save"): () => void {
      let release = () => {};
      held.set(
        what,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        held.delete(what);
        release();
      };
    },
    /** The browser replaces its subscription, or takes it away. */
    browserChanges(to: "another" | "none") {
      const key = subscription?.options.applicationServerKey;
      subscription = null;
      if (to === "another" && key)
        subscription = subscribe(new Uint8Array(key));
    },
  };
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
    const { device, server, log, memory } = setup();

    expect(await turnOnPush(device, server, memory, session)).toBe("on");

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
    const { device, server, log, memory } = setup({ answer: "denied" });

    expect(await turnOnPush(device, server, memory, session)).toBe("blocked");

    expect(log).toEqual(["ask the person"]);
  });

  it("turns nothing on when the person closes the question", async () => {
    const { device, server, log, memory } = setup({ answer: "default" });

    expect(await turnOnPush(device, server, memory, session)).toBe("dismissed");

    expect(log).toEqual(["ask the person"]);
    // They can be asked again.
    expect(await readPushState(device, server)).toBe("off");
  });

  it("does not ask a person whose browser cannot subscribe", async () => {
    const { device, server, log, memory } = setup({
      device: { supported: false, ios: true },
    });

    expect(await turnOnPush(device, server, memory, session)).toBe(
      "needs-install",
    );

    expect(log).toEqual([]);
  });

  it("subscribes anew when the browser has a subscription of another key", async () => {
    const { device, server, log, memory } = setup({
      permission: "granted",
      subscribedWith: keyOf(2),
    });

    expect(await turnOnPush(device, server, memory, session)).toBe("on");

    expect(log).toContain("unsubscribe https://push.example/2");
    // The second subscription that this browser has made, with the key 1.
    expect(log.at(-1)).toContain('"endpoint":"https://push.example/1-2"');
  });

  it("subscribes anew when the server no longer sends to the subscription that the browser has", async () => {
    // The push service has said that the subscription is gone, and the
    // server has dropped it: the browser still hands it out.
    const { device, server, log, memory } = setup({
      permission: "granted",
      subscribedWith: key,
    });

    expect(await turnOnPush(device, server, memory, session)).toBe("on");

    // Not the dead one again, which would be "on" and never get a
    // message: the browser ends it and makes another.
    expect(log).toEqual([
      "ask the person",
      "ask for the key",
      "unsubscribe https://push.example/1",
      "subscribe",
      'save {"endpoint":"https://push.example/1-2","keys":{"p256dh":"device-key","auth":"device-secret"}}',
    ]);
    expect(await readPushState(device, server)).toBe("on");
  });

  it("keeps the subscription of the browser that the server sends to", async () => {
    const { device, server, log, memory } = setup({
      permission: "granted",
      subscribedWith: key,
      known: ["https://push.example/1"],
    });

    expect(await turnOnPush(device, server, memory, session)).toBe("on");

    expect(log).not.toContain("unsubscribe https://push.example/1");
  });

  it("remembers in which session they were turned on, and with which subscription", async () => {
    const { device, server, memory } = setup();

    await turnOnPush(device, server, memory, session);

    expect(memory.kept()).toEqual({
      session,
      endpoint: "https://push.example/1",
    });
  });

  it("ends the subscription that it made when the server does not take it", async () => {
    // The server sends to the push services that it knows, and this
    // browser has another.
    const refusal = new Error(
      "pigy cannot send notifications to this browser yet.",
    );
    const { device, server, log, memory, subscribed } = setup({ refusal });

    await expect(turnOnPush(device, server, memory, session)).rejects.toBe(
      refusal,
    );

    // The browser is not left subscribed at a push service that nothing
    // will ever come from.
    expect(log.at(-1)).toBe("unsubscribe https://push.example/1");
    expect(subscribed()).toBeNull();
    expect(memory.kept()).toBeNull();
  });

  it("keeps a subscription that the server sends to when it cannot be saved again", async () => {
    // Notifications are on already, and the save fails, as without a
    // connection: what works is not taken away for that.
    const { device, server, memory, subscribed } = setup({
      subscribedWith: key,
      known: ["https://push.example/1"],
      refusal: new Error("No answer"),
    });

    await expect(turnOnPush(device, server, memory, session)).rejects.toThrow(
      "No answer",
    );

    expect(subscribed()).toBe("https://push.example/1");
  });

  it("subscribes nothing for a pigy that is not set up to send", async () => {
    const { device, server, log, memory } = setup({ serverKey: null });

    expect(await turnOnPush(device, server, memory, session)).toBe(
      "not-set-up",
    );

    expect(log).not.toContain("subscribe");
  });
});

describe("a subscription that the browser has changed by itself", () => {
  /** Notifications were turned on in this session, and work. */
  const turnedOn = () =>
    setup({
      permission: "granted",
      subscribedWith: key,
      known: ["https://push.example/1"],
      turnedOn: { session, endpoint: "https://push.example/1" },
    });

  it("is handed to the server when the app next looks, without asking anybody", async () => {
    const { device, server, log, memory, browserChanges } = turnedOn();
    browserChanges("another");

    await renewPush(device, server, memory, session);

    expect(log).toEqual([
      "ask for the key",
      'save {"endpoint":"https://push.example/1-2","keys":{"p256dh":"device-key","auth":"device-secret"}}',
    ]);
    expect(memory.kept()).toEqual({
      session,
      endpoint: "https://push.example/1-2",
    });
  });

  it("is made anew when the browser has taken it away", async () => {
    const { device, server, log, memory, browserChanges } = turnedOn();
    browserChanges("none");

    await renewPush(device, server, memory, session);

    expect(log).toContain("subscribe");
    expect(log.at(-1)).toContain('"endpoint":"https://push.example/1-2"');
    expect(await readPushState(device, server)).toBe("on");
  });

  it("is left alone while it is the one that was turned on, and the server is not asked", async () => {
    const { device, server, log, memory } = turnedOn();

    await renewPush(device, server, memory, session);

    expect(log).toEqual([]);
  });

  it("turns nothing on for a session that did not turn notifications on", async () => {
    // Somebody has signed in anew on the device, as the same person or
    // another: what was turned on before is not theirs.
    const { device, server, log, memory, browserChanges } = turnedOn();
    browserChanges("another");

    await renewPush(device, server, memory, "grace/2");
    await renewPush(device, server, memory, null);

    expect(log).toEqual([]);
  });

  it("turns nothing on again once the person has turned notifications off", async () => {
    const { device, server, log, memory } = turnedOn();
    await turnOffPush(device, server, memory);
    log.length = 0;

    await renewPush(device, server, memory, session);

    expect(log).toEqual([]);
    expect(await readPushState(device, server)).toBe("off");
  });

  // A renewal waits for the server, and the person does not: what they
  // choose meanwhile is what counts when the answer comes.

  it("turns nothing on again when the person turns notifications off while the renewal waits for the key", async () => {
    const { device, server, log, memory, browserChanges, hold, subscribed } =
      turnedOn();
    // Taken away: the renewal subscribes anew once it has the key.
    browserChanges("none");
    const release = hold("key");
    const renewal = renewPush(device, server, memory, session);
    await expect.poll(() => log).toContain("ask for the key");

    await turnOffPush(device, server, memory);
    release();
    await renewal;

    expect(log).not.toContain("subscribe");
    expect(subscribed()).toBeNull();
    expect(memory.kept()).toBeNull();
    expect(await readPushState(device, server)).toBe("off");
  });

  it("hands the server no subscription that the person has ended while the renewal waited for the key", async () => {
    const { device, server, log, memory, browserChanges, hold, known } =
      turnedOn();
    // Replaced: the renewal holds the new one while it waits.
    browserChanges("another");
    const release = hold("key");
    const renewal = renewPush(device, server, memory, session);
    await expect.poll(() => log).toContain("ask for the key");

    await turnOffPush(device, server, memory);
    release();
    await renewal;

    expect(log.filter((entry) => entry.startsWith("save"))).toEqual([]);
    expect(known()).not.toContain("https://push.example/1-2");
    expect(memory.kept()).toBeNull();
  });

  it("takes back what it subscribed and saved when the person turns notifications off while the server saves", async () => {
    const {
      device,
      server,
      log,
      memory,
      browserChanges,
      hold,
      known,
      subscribed,
    } = turnedOn();
    browserChanges("none");
    const release = hold("save");
    const renewal = renewPush(device, server, memory, session);
    await expect
      .poll(() => log.some((entry) => entry.startsWith("save")))
      .toBe(true);

    await turnOffPush(device, server, memory);
    release();
    await renewal;

    // Whichever of the two the server heard last, it does not send here.
    expect(known()).not.toContain("https://push.example/1-2");
    expect(subscribed()).toBeNull();
    expect(memory.kept()).toBeNull();
  });

  it("leaves it at what the person turned on anew while the renewal waited", async () => {
    const { device, server, log, memory, browserChanges, hold, subscribed } =
      turnedOn();
    browserChanges("none");
    const release = hold("key");
    const renewal = renewPush(device, server, memory, session);
    await expect.poll(() => log).toContain("ask for the key");

    // Off and on again, in this tab or another: both ask for the key,
    // and the server answers them when it answers the renewal.
    await turnOffPush(device, server, memory);
    const turned = turnOnPush(device, server, memory, session);
    await expect
      .poll(() => log.filter((entry) => entry === "ask for the key").length)
      .toBe(2);
    release();
    expect(await turned).toBe("on");
    const chosen = memory.kept();
    await renewal;

    // The renewal has not subscribed a second time, and has taken
    // nothing away: the choice that is stored is the person's.
    expect(log.filter((entry) => entry === "subscribe")).toHaveLength(1);
    expect(memory.kept()).toEqual(chosen);
    expect(subscribed()).toBe(chosen?.endpoint);
    expect(await readPushState(device, server)).toBe("on");
  });

  it("runs one renewal at a time", async () => {
    const { device, server, log, memory, browserChanges, hold } = turnedOn();
    browserChanges("none");
    const release = hold("key");
    // The app starts, and the service worker says that the subscription
    // has changed: two renewals of the same thing.
    const first = renewPush(device, server, memory, session);
    const second = renewPush(device, server, memory, session);
    await expect.poll(() => log).toContain("ask for the key");
    release();
    await Promise.all([first, second]);

    // The second found the work done, and asked the server nothing.
    expect(log.filter((entry) => entry === "ask for the key")).toHaveLength(1);
    expect(log.filter((entry) => entry === "subscribe")).toHaveLength(1);
    expect(log.filter((entry) => entry.startsWith("save"))).toHaveLength(1);
  });

  it("asks nobody where the person has taken the permission back", async () => {
    const { device, server, log, memory, browserChanges } = turnedOn();
    browserChanges("none");
    device.permission = () => "default";

    await renewPush(device, server, memory, session);

    expect(log).toEqual([]);
  });
});

describe("turning notifications off", () => {
  it("ends the subscription of the browser and has the server forget it", async () => {
    const { device, server, log, memory } = setup({
      permission: "granted",
      subscribedWith: key,
      known: ["https://push.example/1"],
    });

    expect(await turnOffPush(device, server, memory)).toBe("off");

    expect(log).toEqual([
      "unsubscribe https://push.example/1",
      "remove https://push.example/1",
    ]);
    expect(await readPushState(device, server)).toBe("off");
  });

  it("ends the subscription also when the server cannot be told", async () => {
    const { device, server, log, memory } = setup({
      permission: "granted",
      subscribedWith: key,
    });
    server.remove = async () => {
      throw new Error("No answer");
    };

    // The push service refuses the next message, and the server forgets
    // the device then.
    expect(await turnOffPush(device, server, memory)).toBe("off");
    expect(log).toEqual(["unsubscribe https://push.example/1"]);
  });
});
