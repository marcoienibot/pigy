import {
  type PushConfigResponse,
  type PushStateResponse,
  pushEndpointRequestSchema,
  pushSubscriptionRequestSchema,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { InvalidField, parseJsonBody } from "../errors.ts";
import { vapidKeyFor, vapidKeyOf } from "./keys.ts";
import {
  arePushKeys,
  isSubscribed,
  pushEndpoint,
  subscribe,
  unsubscribe,
} from "./subscriptions.ts";
import type { VapidKey } from "./web-push.ts";

/**
 * Under `/api/push`: turning the notifications of a device on and off.
 * `packages/core/src/push.ts` has the requests and the answers.
 *
 * | Route | What it does |
 * | --- | --- |
 * | `GET /` | The public key that a page subscribes with. 503 for a pigy without a key |
 * | `PUT /subscription` | Takes the subscription of this browser for the session, in place of what the session had. 400 about `endpoint` for an address that is not of a push service, 409 for a subscription of somebody else |
 * | `POST /subscription/state` | Whether the server sends to this browser, for this session |
 * | `DELETE /subscription` | Forgets the subscription of this browser |
 *
 * A subscription is named by its endpoint, in the body of a request and
 * never in an address: it is an address that only the browser and pigy
 * should know.
 */
export function pushRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { now, developmentVapidKey } = dependencies;
  const app = new Hono<AppEnv>();
  // Also refuses a request that changes something and comes from another
  // site.
  app.use(requireUser(dependencies));

  /** The key of this pigy, or a 503 that says that it has none. */
  const keyFor = async (c: Context<AppEnv>): Promise<VapidKey> => {
    const key = await vapidKeyOf(
      vapidKeyFor(c.env, developmentVapidKey, new URL(c.req.url).origin),
    );
    if (!key) {
      throw new HTTPException(503, {
        message:
          "Whoever runs this pigy has not set it up to send notifications.",
      });
    }
    return key;
  };

  const session = (c: Context<AppEnv>) => ({
    userId: c.var.auth.user.id,
    sessionId: c.var.sessionId,
  });

  app.get("/", async (c) => {
    const { publicKey } = await keyFor(c);
    return c.json<PushConfigResponse>({ publicKey });
  });

  app.put("/subscription", async (c) => {
    const key = await keyFor(c);
    const { endpoint, keys } = await parseJsonBody(
      c,
      pushSubscriptionRequestSchema,
    );
    const checked = pushEndpoint(endpoint, new URL(c.req.url).host);
    if (checked === null) {
      // Said to a person, in Settings: the one who gets this from a
      // browser is somebody whose browser has a push service that is not
      // in the list, `pushServiceHosts`. The address means nothing to
      // them, and they can do nothing about it.
      throw new InvalidField(
        "endpoint",
        "pigy cannot send notifications to this browser yet. The inbox has what they would say.",
      );
    }
    if (!arePushKeys(keys)) {
      throw new InvalidField(
        "keys",
        "These are not the keys of a push subscription",
      );
    }
    const subscribed = await subscribe(
      drizzle(c.env.DB),
      session(c),
      { endpoint: checked, ...keys },
      {
        vapidKey: key.publicKey,
        origin: new URL(c.req.url).origin,
        at: now(),
      },
    );
    if (!subscribed) {
      // The browser has handed out a subscription that another person
      // turned on in it, or somebody names one that is not theirs. The
      // page unsubscribes the browser and subscribes it anew.
      throw new HTTPException(409, {
        message:
          "This subscription belongs to somebody else who is signed in. Turn notifications on again.",
      });
    }
    return c.json<PushStateResponse>({ subscribed: true });
  });

  app.post("/subscription/state", async (c) => {
    const key = await keyFor(c);
    const { endpoint } = await parseJsonBody(c, pushEndpointRequestSchema);
    const checked = pushEndpoint(endpoint, new URL(c.req.url).host);
    return c.json<PushStateResponse>({
      subscribed:
        checked !== null &&
        (await isSubscribed(
          drizzle(c.env.DB),
          session(c),
          checked,
          key.publicKey,
        )),
    });
  });

  app.delete("/subscription", async (c) => {
    const { endpoint } = await parseJsonBody(c, pushEndpointRequestSchema);
    const checked = pushEndpoint(endpoint, new URL(c.req.url).host);
    if (checked !== null) {
      await unsubscribe(drizzle(c.env.DB), c.var.auth.user.id, checked);
    }
    return c.json<PushStateResponse>({ subscribed: false });
  });

  return app;
}
