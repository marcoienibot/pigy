import { z } from "zod";

/**
 * What a link shows as where a network shows more than its address: the
 * card of the page. The text is what the page says of itself, which is
 * anybody's to write: it is shown as text and never as markup.
 */
export const linkCardSchema = z.strictObject({
  /** The address of the link, with its scheme. */
  url: z.string().min(1).max(2048),
  title: z.string().max(300),
  description: z.string().max(1000),
});

export type LinkCard = z.infer<typeof linkCardSchema>;

/**
 * What is published to one channel: the text of every part of a post, in
 * order. An ordinary post has one part, a thread several. How the parts
 * become posts on the network is the network's business: a chain of replies
 * on most, one joined post on LinkedIn.
 *
 * A part can come with the card of its first link, where pigy has read
 * the page: `cardLinks` of entities.ts says which link that is. A network
 * that makes its cards itself has no use for it, and a part without one
 * is published all the same.
 */
export const postContentSchema = z.object({
  parts: z
    .array(z.object({ text: z.string(), card: linkCardSchema.optional() }))
    .min(1),
});

export type PostContent = z.infer<typeof postContentSchema>;
