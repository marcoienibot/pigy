import { z } from "zod";
import { idSchema } from "./id.ts";
import { networkSchema } from "./network/network.ts";
import { environmentSchema } from "./workspace.ts";

/**
 * Push messages: what pigy sends to the devices that a person has turned
 * notifications on for, and how a device is subscribed. `PLAN.md` section
 * 13 has the design.
 */

/** What a push message tells of. */
export const pushKinds = [
  /** A post has ended, and a delivery of it has failed. */
  "post_failed",
  /** A post has ended, and nobody knows how a delivery of it ended. */
  "post_uncertain",
  /** A network no longer takes the access of a channel. */
  "channel_needs_reconnect",
  /** The access of a channel ends within a week. */
  "channel_expiring",
] as const;

/**
 * A push message as it travels, encrypted for one browser: JSON of this
 * form. It says what happened and where in pigy to look, and nothing
 * else. It shows on a lock screen and waits at a push service, so it has
 * no text of a post and no name of an account: the service worker of the
 * app makes the words from it, `apps/web/src/sw/push.ts`.
 *
 * A contract between the Worker and the service workers that devices
 * have, which can be older than the Worker. A service worker shows a
 * message of a kind that it does not know in general words, and reads no
 * message of another `v`.
 */
export const pushMessageSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(pushKinds),
  /** The workspace that it is about, and which of the two that is. */
  workspaceId: z.string().min(1).max(100),
  environment: environmentSchema,
  /** The post that it is about, if it is about one. */
  postId: idSchema.optional(),
  /** The channel that it is about, if it is about one, and its network. */
  channelId: idSchema.optional(),
  network: networkSchema.optional(),
  /**
   * When the access of the channel ends, in milliseconds since the epoch,
   * for a message that tells of that: it can be days away or hours, and a
   * device shows the message whenever it gets it.
   */
  expiresAt: z.number().int().optional(),
});

export type PushMessage = z.infer<typeof pushMessageSchema>;

/** `GET /api/push`: what a page subscribes with. */
export const pushConfigResponseSchema = z.strictObject({
  /**
   * The public key of this pigy as a sender of push messages: 65 bytes
   * in base64url, the `applicationServerKey` of a subscription.
   */
  publicKey: z.string().min(1).max(200),
});

export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;

/** The longest address of a push service that pigy keeps. */
export const maxPushEndpointLength = 2000;

const endpointSchema = z.string().min(1).max(maxPushEndpointLength);

/**
 * `PUT /api/push/subscription`: what a browser hands out when it
 * subscribes, as `PushSubscription.toJSON()` has it, without what pigy has
 * no use for.
 */
export const pushSubscriptionRequestSchema = z.strictObject({
  endpoint: endpointSchema,
  keys: z.strictObject({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export type PushSubscriptionRequest = z.infer<
  typeof pushSubscriptionRequestSchema
>;

/**
 * `POST /api/push/subscription/state` and `DELETE /api/push/subscription`:
 * the subscription of this browser, named by its endpoint.
 */
export const pushEndpointRequestSchema = z.strictObject({
  endpoint: endpointSchema,
});

/** Whether the server sends push messages to a browser. */
export const pushStateResponseSchema = z.strictObject({
  subscribed: z.boolean(),
});

export type PushStateResponse = z.infer<typeof pushStateResponseSchema>;
