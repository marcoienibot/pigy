/** `text`, cut to at most `length` and never in the middle of a character. */
export function clipped(text: string, length: number): string {
  let clip = "";
  for (const character of text) {
    if (clip.length + character.length > length) break;
    clip += character;
  }
  return clip;
}
