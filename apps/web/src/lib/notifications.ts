import {
  deletePushSubscription,
  fetchPushKey,
  fetchPushState,
  savePushSubscription,
} from "@/lib/api";
import { isInstalled, isIos } from "@/lib/install";
import {
  type PushDevice,
  type PushMemory,
  type PushServer,
  type PushState,
  readPushState,
  renewPush,
  turnOffPush,
  turnOnPush,
} from "@/lib/push";
import { sessionOnDevice } from "@/lib/session";

/**
 * The notifications of this device, for Settings: `lib/push.ts` with the
 * browser and the server that the app has.
 */
const device: PushDevice = {
  // Safari on an iPhone has none of the three in a tab.
  supported:
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window,
  ios: isIos,
  get installed() {
    return isInstalled();
  },
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  // The worker that is registered, not the one that is ready: without a
  // service worker, as in development, that one never comes.
  manager: async () =>
    (await navigator.serviceWorker.getRegistration())?.pushManager,
};

const server: PushServer = {
  key: fetchPushKey,
  state: fetchPushState,
  save: savePushSubscription,
  remove: deletePushSubscription,
};

/**
 * Where the device keeps what `lib/push.ts` remembers: in `localStorage`,
 * next to the session that it names. It is nobody's secret, and of no use
 * to another session, so signing out leaves it.
 */
const memoryKey = "pigy-push";

const memory: PushMemory = {
  read() {
    try {
      const kept: unknown = JSON.parse(
        localStorage.getItem(memoryKey) ?? "null",
      );
      if (typeof kept !== "object" || kept === null) return null;
      const { session, endpoint } = kept as Record<string, unknown>;
      return typeof session === "string" && typeof endpoint === "string"
        ? { session, endpoint }
        : null;
    } catch {
      return null;
    }
  },
  write(turnedOn) {
    try {
      if (turnedOn) localStorage.setItem(memoryKey, JSON.stringify(turnedOn));
      else localStorage.removeItem(memoryKey);
    } catch {
      // A device that cannot keep it does without the renewal.
    }
  },
};

/** How the notifications of this device stand: for `useFetched`. */
export const readNotifications = (signal: AbortSignal): Promise<PushState> =>
  readPushState(device, server, signal);

/** Turns them on. To be called from a click: it asks the person. */
export const turnOnNotifications = () =>
  turnOnPush(device, server, memory, sessionOnDevice());

export const turnOffNotifications = () => turnOffPush(device, server, memory);

/**
 * Has the server send to the subscription that the browser has now, if
 * that is another than the one that was turned on in this session: when
 * the app starts, and when the service worker says that the browser has
 * changed it. It asks nobody anything, and what goes wrong is tried the
 * next time.
 */
export const renewNotifications = (): Promise<void> =>
  renewPush(device, server, memory, sessionOnDevice()).catch(() => undefined);

/** What Settings say of each state, under "Notifications on this device". */
export const notificationWords: Record<PushState, string> = {
  on: "On. pigy tells this device when a post could not be sent, when an account has to be connected again, and a week before the access to an account ends, also while pigy is closed.",
  off: "Off. Turned on, pigy tells this device when a post could not be sent, when an account has to be connected again, and a week before the access to an account ends, also while pigy is closed.",
  blocked:
    "Blocked in the settings of the browser. Allow notifications for this site there, then turn them on here.",
  "needs-install":
    "On an iPhone or iPad, notifications work once pigy is on the Home Screen. Open the Share menu of the browser, choose “Add to Home Screen”, and turn them on in the app that this adds. Until then the inbox has what they would say.",
  unsupported:
    "This browser does not show notifications. The inbox has what they would say.",
  "no-app":
    "Not available here: notifications need the built app, which development does not serve.",
  "not-set-up":
    "Whoever runs this pigy has not set it up to send notifications. The inbox has what they would say.",
};
