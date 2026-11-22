import { z } from "zod";
import { imageTypes } from "../media/image.ts";

/**
 * What a link shows as where a network shows more than its address: the
 * card of the page. The text is what the page says of itself, which is
 * anybody's to write: it is shown as text and never as markup.
 *
 * A field that this does not know is left out and refuses nothing: a card
 * is part of an answer that a client fetches, and the client of one
 * release reads the answers of the next.
 */
export const linkCardSchema = z.object({
  /** The address of the link, with its scheme. */
  url: z.string().min(1).max(2048),
  title: z.string().max(300),
  description: z.string().max(1000),
});

export type LinkCard = z.infer<typeof linkCardSchema>;

/**
 * An image of a part, as it is published.
 *
 * `id` names the image to whoever hands out its bytes, and says nothing
 * else. What the fields say of the image is of the bytes that the
 * network gets: of the image as the workspace keeps it before a delivery
 * has begun, which is what `validateContent` looks at, and of the smaller
 * one that was made for a network where the delivery made one.
 */
export const contentImageSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(imageTypes),
  /** In bytes. */
  size: z.number().int().positive(),
  /** In pixels, as the picture is shown. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  animated: z.boolean().optional(),
  /** What the picture shows, for whoever cannot see it. May be empty. */
  alt: z.string(),
  /**
   * There if the image cannot be published as things are: the server
   * does not have it yet, `uploading`, did not take it, `failed`, or has
   * let go of it since, `gone`. Left out for an image that is there.
   */
  missing: z.enum(["uploading", "failed", "gone"]).optional(),
});

export type ContentImage = z.infer<typeof contentImageSchema>;

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
 *
 * A part can have images, `media`, in the order they are shown in. Left
 * out for a part without any.
 */
export const postContentSchema = z.object({
  parts: z
    .array(
      z.object({
        text: z.string(),
        card: linkCardSchema.optional(),
        media: z.array(contentImageSchema).optional(),
      }),
    )
    .min(1),
});

export type PostContent = z.infer<typeof postContentSchema>;
