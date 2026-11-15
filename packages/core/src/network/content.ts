import { z } from "zod";

/**
 * What is published to one channel: the text of every part of a post, in
 * order. An ordinary post has one part, a thread several. How the parts
 * become posts on the network is the network's business: a chain of replies
 * on most, one joined post on LinkedIn.
 */
export const postContentSchema = z.object({
  parts: z.array(z.object({ text: z.string() })).min(1),
});

export type PostContent = z.infer<typeof postContentSchema>;
