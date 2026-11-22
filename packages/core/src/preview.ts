import { z } from "zod";
import { linkCardSchema } from "./network/content.ts";
import { maxLookedUpMentions } from "./network/entities.ts";
import { networkSchema } from "./network/network.ts";

/**
 * What the editor of a draft asks the server before a post goes out, to
 * show what the post will look like: the card of a link, and which of the
 * accounts that a text mentions there are. Neither is synced, and neither
 * changes anything. Both routes are for whoever is signed in, about a
 * workspace of their own, which decides where the answer comes from: the
 * internet for the live one, its simulated world for a sandbox.
 *
 * - `POST /api/workspaces/<workspace ID>/link-card` takes a
 *   `LinkCardRequest` and answers with a `LinkCardResponse`: the card that
 *   pigy would send with a post that leads with this link, or null if the
 *   page cannot be read or says nothing of itself. That it cannot be read
 *   is no error: the post goes out without a card.
 * - `POST /api/workspaces/<workspace ID>/mentions` takes a
 *   `MentionsRequest` and answers with a `MentionsResponse`: which of the
 *   names are accounts on the network, where pigy has to look an account
 *   up to mark a mention up, which is on Bluesky.
 *
 * A person may ask `previewsPerMinute` times a minute, both routes
 * together. After that the answer is a 429, and the editor shows no
 * preview until the minute is over.
 */

/** How often a person may ask for a preview in a minute. */
export const previewsPerMinute = 60;

/** Body of `POST /api/workspaces/<workspace ID>/link-card`. */
export const linkCardRequestSchema = z.strictObject({
  /** The address of the link, with its scheme. */
  url: z.string().min(1).max(2048),
});

export type LinkCardRequest = z.infer<typeof linkCardRequestSchema>;

/** Response of `POST /api/workspaces/<workspace ID>/link-card`. */
export const linkCardResponseSchema = z.strictObject({
  card: linkCardSchema.nullable(),
});

export type LinkCardResponse = z.infer<typeof linkCardResponseSchema>;

/**
 * How many names a `MentionsRequest` asks about at most: as many as a
 * post looks up for one part.
 */
export const maxMentionNames = maxLookedUpMentions;

/** Body of `POST /api/workspaces/<workspace ID>/mentions`. */
export const mentionsRequestSchema = z.strictObject({
  network: networkSchema,
  /**
   * The mentions to ask about, without the "@", as `detectEntities` reads
   * them for the network.
   */
  names: z.array(z.string().min(1).max(300)).min(1).max(maxMentionNames),
});

export type MentionsRequest = z.infer<typeof mentionsRequestSchema>;

/** Response of `POST /api/workspaces/<workspace ID>/mentions`. */
export const mentionsResponseSchema = z.strictObject({
  /**
   * The names that are accounts, of the ones that were asked about. Null
   * where nothing is looked up: on a network that finds the accounts of a
   * text itself, or that has no mentions that pigy could write.
   */
  known: z.array(z.string()).nullable(),
});

export type MentionsResponse = z.infer<typeof mentionsResponseSchema>;
