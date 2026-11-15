import { z } from "zod";
import { errorResponseSchema } from "./error.ts";
import { type Network, networkSchema } from "./network/network.ts";

/**
 * Connecting an account of a network to a workspace, and disconnecting it.
 * The account then shows as a row of the synced table `channel`.
 *
 * Connecting takes the person to the network and back:
 *
 * 1. `POST /api/workspaces/<workspace ID>/connect` with a `ConnectRequest`
 *    answers with a `ConnectResponse`: the address to send the browser to.
 *    A refusal is a `ConnectError`.
 * 2. There the person consents, or not, and the network sends the browser
 *    back to pigy, which sends it on to `connectReturnPath` with the
 *    outcome in the query: `connectOutcomeSchema` describes it. That is
 *    where the browser ends whatever went wrong, also for somebody who is
 *    no longer signed in: the app has them sign in before it shows the
 *    page.
 *
 * `DELETE /api/workspaces/<workspace ID>/channels/<channel ID>` disconnects
 * and answers with a `DisconnectResponse`.
 */

/** The longest identifier that a person may type. */
export const maxConnectIdentifierLength = 300;

/** Body of `POST /api/workspaces/<workspace ID>/connect`. */
export const connectRequestSchema = z.strictObject({
  network: networkSchema,
  /**
   * What the person typed to say where their account lives, on the networks
   * that ask: the domain of the instance on Mastodon. Left out on the
   * others.
   */
  identifier: z.string().max(maxConnectIdentifierLength).optional(),
});

export type ConnectRequest = z.infer<typeof connectRequestSchema>;

/**
 * What a `ConnectRequest` is refused with: an error response whose message
 * is written for the person, and whose `field` says which input of a form
 * the message belongs to.
 *
 * - 400 with the field `identifier`: what they typed leads to no server
 *   that pigy can connect to. It is not a domain, the server is not one
 *   that pigy can post to, or, in a sandbox, it is not the simulated server
 *   of the sandbox: the message names that one. Trying again with the same
 *   text gives the same answer. The message goes next to the field. A
 *   network that asks for nothing has no such field, and a form shows the
 *   message with the form as a whole.
 * - 400 with the field `network`: pigy does not know the network, or
 *   cannot connect its accounts yet.
 * - 400 without a field: the request is not one that pigy's own pages make.
 * - 502: the server of the network cannot be reached, or is in trouble.
 *   Trying again later can work. The message names the server, and goes
 *   with the form as a whole.
 * - 503: this pigy is not set up to connect accounts.
 *
 * And the answers of every route: 401 for somebody who is not signed in,
 * 404 for a workspace that is not theirs.
 */
export const connectErrorSchema = errorResponseSchema.extend({
  field: connectRequestSchema.keyof().optional(),
});

export type ConnectError = z.infer<typeof connectErrorSchema>;

/** The answer to a `ConnectRequest`. */
export const connectResponseSchema = z.object({
  /**
   * Where to send the browser, as a navigation of the whole page: the
   * network's own consent page, or in a sandbox workspace a simulated one
   * that pigy serves.
   */
  url: z.string().min(1),
});

export type ConnectResponse = z.infer<typeof connectResponseSchema>;

/**
 * The path that the browser is sent to when a connection has ended, however
 * it ended.
 */
export const connectReturnPath = "/channels";

/** How a connection ended. */
export const connectResultSchema = z.enum([
  /** The account is a channel of the workspace now. */
  "connected",
  /** The person said no at the network. Nothing went wrong. */
  "cancelled",
  /**
   * The answer of the network does not belong to a connection that this
   * browser session began in the last minutes: it took too long, it was
   * used before, it was begun elsewhere, or the person has signed out
   * since. Starting again helps.
   */
  "expired",
  /**
   * The network did not hand over the access, or pigy failed. The reason is
   * in the server's logs. Starting again can help.
   */
  "failed",
]);

export type ConnectResult = z.infer<typeof connectResultSchema>;

/**
 * The query of `connectReturnPath` after a connection. Every value is the
 * word of whoever made the address, which need not be pigy: a page shows it
 * as a fixed text of its own choosing and trusts none of it.
 */
export const connectOutcomeSchema = z.object({
  connect: connectResultSchema,
  /** The network of the callback, if it named one that pigy knows. */
  network: networkSchema.optional(),
  /** The workspace that the connection was for, once that is known. */
  workspace: z.string().min(1).optional(),
  /** With `connected`: the ID of the channel. */
  channel: z.string().min(1).optional(),
});

export type ConnectOutcome = z.infer<typeof connectOutcomeSchema>;

/** The path of pigy that a network sends the browser back to. */
export function connectCallbackPath(network: Network): string {
  return `/connect/${network}/callback`;
}

/** Answer of `DELETE /api/workspaces/<workspace ID>/channels/<channel ID>`. */
export const disconnectResponseSchema = z.object({
  /**
   * Whether the network has taken back the access that pigy had, where it
   * has a way to. The channel is gone either way. If false, the access may
   * still stand at the network, where the person can end it themselves.
   */
  revoked: z.boolean(),
});

export type DisconnectResponse = z.infer<typeof disconnectResponseSchema>;
