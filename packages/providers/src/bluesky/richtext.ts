import {
  detectEntities,
  type LinkCard,
  lookedUpMentions,
  utf8Range,
} from "@pigy/core";
import { z } from "zod";

/**
 * What a post of Bluesky has besides its text: the facets that mark its
 * links, mentions and tags, the lexicon `app.bsky.richtext.facet`, and
 * the card of its first link, `app.bsky.embed.external`. Bluesky finds
 * none of them in a text by itself: what a client does not mark is text.
 *
 * What is a link, a mention or a tag is decided in one place, for the
 * editor and for this: `detectEntities` of `@pigy/core`. A facet names
 * its stretch of the text by the bytes of its UTF-8, which is not where
 * it stands in a string: `utf8Range`.
 *
 * The text is published as it is written. Bluesky's own app shortens a
 * long address in the text and keeps the whole of it in the facet. pigy
 * does not: the text that a step looks for is then the text of the part,
 * and what is counted is what is published.
 */

/**
 * A facet, as a record holds one and as a step notes it for the step
 * that writes: public, like everything in a record.
 */
export const facetSchema = z.strictObject({
  index: z.strictObject({
    byteStart: z.number().int().nonnegative(),
    byteEnd: z.number().int().nonnegative(),
  }),
  features: z.tuple([
    z.union([
      z.strictObject({
        $type: z.literal("app.bsky.richtext.facet#link"),
        uri: z.string(),
      }),
      z.strictObject({
        $type: z.literal("app.bsky.richtext.facet#mention"),
        did: z.string().min(1),
      }),
      z.strictObject({
        $type: z.literal("app.bsky.richtext.facet#tag"),
        tag: z.string(),
      }),
    ]),
  ]),
});

export type Facet = z.infer<typeof facetSchema>;

/**
 * The handles that `text` mentions and that are looked up, each once, in
 * the order of the text: `lookedUpMentions` of `@pigy/core`, which is
 * also what the editor asks about. A mention of a handle beyond them is
 * text.
 */
export function mentionedHandles(text: string): string[] {
  return lookedUpMentions(detectEntities("bluesky", text));
}

/**
 * The facets of `text`, in its order. `dids` has the account of every
 * handle that was found to be one: a mention of a handle that is not in
 * it gets no facet, and is the text that it is.
 */
export function facetsOf(
  text: string,
  dids: ReadonlyMap<string, string>,
): Facet[] {
  const facets: Facet[] = [];
  for (const entity of detectEntities("bluesky", text)) {
    const index = utf8Range(text, entity);
    if (entity.kind === "link") {
      facets.push({
        index,
        features: [{ $type: "app.bsky.richtext.facet#link", uri: entity.url }],
      });
    } else if (entity.kind === "hashtag") {
      facets.push({
        index,
        // Without its sign: "Posts" of docs.bsky.app.
        features: [{ $type: "app.bsky.richtext.facet#tag", tag: entity.tag }],
      });
    } else {
      const did = dids.get(entity.name);
      if (did !== undefined) {
        facets.push({
          index,
          features: [{ $type: "app.bsky.richtext.facet#mention", did }],
        });
      }
    }
  }
  return facets;
}

/** The first link of `text`, or undefined. */
export function firstLink(text: string): string | undefined {
  const link = detectEntities("bluesky", text).find(
    (entity) => entity.kind === "link",
  );
  return link?.kind === "link" ? link.url : undefined;
}

/** The card of a link, as a record embeds one: without a picture. */
export const externalSchema = z.strictObject({
  $type: z.literal("app.bsky.embed.external"),
  external: z.strictObject({
    uri: z.string(),
    title: z.string(),
    description: z.string(),
  }),
});

export type External = z.infer<typeof externalSchema>;

/**
 * The embed that a part with `text` is published with, or undefined: the
 * card that came with the part, if it is that of the first link of the
 * text. A card of anything else is not this part's, and is left out.
 */
export function embedOf(
  text: string,
  card: LinkCard | undefined,
): External | undefined {
  if (!card || card.url !== firstLink(text)) return undefined;
  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: card.url,
      title: card.title,
      description: card.description,
    },
  };
}
