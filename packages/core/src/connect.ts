import { z } from "zod";
import { type Network, networkSchema } from "./network/network.ts";

/**
 * Connecting an account of a network to a workspace, and disconnecting it.
 * The account then shows as a row of the synced table `channel`.
 *
 * Connecting takes the person to the network and back:
 *
 * 1. `POST /api/workspaces/<workspace ID>/connect` with a `ConnectRequest`
 *    answers with a `ConnectResponse`: the address to send the browser to.
 * 2. There the person consents, or not, and the network sends the browser
 *    back to pigy, which sends it on to `connectReturnPath` with the
 *    outcome in the query: `connectOutcome` describes it.
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
 * The answer to a `ConnectRequest`. What it is refused with is an error
 * response whose message is written for the person:
 *
 * - 400: what they typed leads to no server that pigy can connect to. The
 *   message belongs next to the field.
 * - 502: the server of the network cannot be reached, or is in trouble.
 *   Trying again later can work. The message names the server.
 * - 503: this pigy is not set up to connect accounts.
 */
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
   * used before, or it was begun elsewhere. Starting again helps.
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
