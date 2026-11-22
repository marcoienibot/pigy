/**
 * The screen whose name is what was typed into the command palette, in
 * full and in whatever case, or undefined if that names none. The
 * palette lists such a screen first: somebody who types "queue" and
 * presses Enter means the Queue screen, and not a command that has the
 * word in it, such as the one that pauses the queue.
 */
export function namedScreen<Screen extends { label: string }>(
  typed: string,
  screens: readonly Screen[],
): Screen | undefined {
  const name = typed.trim().toLowerCase();
  if (name === "") return undefined;
  return screens.find(({ label }) => label.toLowerCase() === name);
}
