/**
 * The text of a post as LinkedIn wants it written: in its "little text
 * format", which marks mentions and hashtags with characters that it
 * reserves. A text that means one of those characters writes it after a
 * backslash. Left as they are, LinkedIn takes them for the beginning of
 * something else, and has been seen to cut a post short at one.
 *
 * pigy posts plain text so far, so every reserved character is escaped
 * and shows as it was written: a "#" does not begin a hashtag of
 * LinkedIn's, and an "@" mentions nobody. Those come with phase 4.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[|{}@[\]()<>#\\*_~]/g, "\\$&");
}
