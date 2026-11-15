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
 *    A page reads it with `connectResponseSchemaFor(location.origin)`. A
 *    refusal is a `ConnectError`.
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
   * that ask: the domain of the instance on Mastodon, the handle on
   * Bluesky. Left out on the others. A sandbox has what
   * `sandboxIdentifiers` says.
   */
  identifier: z.string().max(maxConnectIdentifierLength).optional(),
});

export type ConnectRequest = z.infer<typeof connectRequestSchema>;

/**
 * What a `ConnectRequest` is refused with: an error response whose message
 * is written for the person, and whose `field` says which input of a form
 * the message belongs to.
 *
 * - 400 with the field `identifier`: what they typed leads to no server or
 *   account that pigy can connect to. It is not a domain or a handle, the
 *   server is not one that pigy can post to, no account has the handle,
 *   or, in a sandbox, the world of the sandbox does not have it: the
 *   message says what it has. Trying again with the same
 *   text gives the same answer. The message goes next to the field. A
 *   network that asks for nothing has no such field, and a form shows the
 *   message with the form as a whole.
 * - 400 with the field `network`: pigy does not know the network, or
 *   cannot connect its accounts yet.
 * - 400 without a field: the request is not one that pigy's own pages make.
 * - 502: the server of the network cannot be reached, or is in trouble.
 *   Trying again later can work. The message names the server, and goes
 *   with the form as a whole.
 * - 503: this pigy is not set up to connect accounts, or the accounts of
 *   the network: it lacks a key that it needs for them.
 *
 * And the answers of every route: 401 for somebody who is not signed in,
 * 404 for a workspace that is not theirs.
 */
export const connectErrorSchema = errorResponseSchema.extend({
  field: connectRequestSchema.keyof().optional(),
});

export type ConnectError = z.infer<typeof connectErrorSchema>;

/**
 * Whether `value` is an address that a browser may be sent to for a
 * connection, by the app at `origin`: an HTTPS address, which is what the
 * consent page of a network has, or an address of the app itself, which
 * serves the simulated ones and is not reached over HTTPS in development.
 * Anything else is not, such as a `javascript:` address, which a page that
 * navigated to it would run.
 */
function isConsentAddress(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * The answer to a `ConnectRequest`, as the app at `origin` gives it and as
 * a page of that app reads it: `location.origin` there.
 */
export function connectResponseSchemaFor(origin: string) {
  return z.object({
    /**
     * Where to send the browser, as a navigation of the whole page: the
     * network's own consent page, or in a sandbox workspace a simulated one
     * that pigy serves. An HTTPS address, or one of the app at `origin`.
     */
    url: z.string().refine((value) => isConsentAddress(value, origin), {
      error: "Not an address to send a browser to",
    }),
  });
}

export type ConnectResponse = z.infer<
  ReturnType<typeof connectResponseSchemaFor>
>;

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

/**
 * How a connection ended, as `query` says: the parameters of the address
 * that the browser was sent to, by name. Undefined if the address is not
 * one that says how a connection ended.
 *
 * The outcome is `connect`. The rest only says more about it, so a value
 * among them that is not what it should be is left out, and the outcome
 * stands: a page can always say what happened, if not to which account.
 */
export function connectOutcomeOf(query: unknown): ConnectOutcome | undefined {
  const outcome = z
    .object({ connect: connectResultSchema })
    .safeParse(query).data;
  if (!outcome) return undefined;
  const { network, workspace, channel } = connectOutcomeSchema.shape;
  const detail = <Value>(schema: z.ZodType<Value>, name: string) =>
    schema.safeParse((query as Record<string, unknown>)[name]).data;
  const named = {
    network: detail(network, "network"),
    workspace: detail(workspace, "workspace"),
    channel: detail(channel, "channel"),
  };
  return {
    connect: outcome.connect,
    ...(named.network && { network: named.network }),
    ...(named.workspace && { workspace: named.workspace }),
    ...(named.channel && { channel: named.channel }),
  };
}

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
