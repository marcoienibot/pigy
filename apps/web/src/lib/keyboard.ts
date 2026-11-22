import { useEffect, useEffectEvent } from "react";

/** Whether this is a Mac, where shortcuts use ⌘ in place of Ctrl. */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** The key that shortcuts with a modifier are spelled with here. */
export const modKey = isMac ? "⌘" : "Ctrl";

/** Whether the key was pressed with the modifier of this platform. */
export function withMod(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * Whether a dialog is open that the app waits behind: a question, a form.
 * These are the dialogs of `components/ui`, which mark themselves so. A
 * popover or a menu is not one, and the command palette is. One that is on
 * its way out is not open: it stays on the page while it fades, and the
 * palette does so too after a command, when the keys may well come again.
 */
export function dialogIsOpen(): boolean {
  return (
    document.querySelector(
      "[data-slot='dialog-content'][data-open], [data-slot='alert-dialog-content'][data-open]",
    ) !== null
  );
}

/**
 * Whether a key press is not for the app: it is meant for what has the
 * focus, because the person is typing or is in a dialog or a menu, or a
 * dialog is open and the app waits behind it.
 *
 * A dialog takes the focus when it opens, so a key press comes from inside
 * it. Not always, which is why an open dialog is asked for by itself: a
 * button that is disabled while its request is on its way gives the focus
 * up, and the browser hands it to the page. The next key press comes from
 * there, and a shortcut that it ran would change the app behind the
 * dialog: the question that waits for an answer would be gone, with its
 * screen.
 */
export function isBusy(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    target?.closest(
      "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu']",
    ) != null || dialogIsOpen()
  );
}

/**
 * Calls `handle` with the key presses that are shortcuts of the app:
 * those that reach the page while nobody is typing, no menu has the focus
 * and no dialog is open. Key presses with a modifier are not among them:
 * they belong to the browser, apart from the few that `useKeyDown` is used
 * for.
 */
export function useShortcuts(handle: (event: KeyboardEvent) => void): void {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.defaultPrevented || isBusy(event)) return;
    handle(event);
  });
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Calls `handle` with every key press on the page, typing included. */
export function useKeyDown(handle: (event: KeyboardEvent) => void): void {
  const onKey = useEffectEvent(handle);
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Gives `element` the keyboard, also from a notice. The notice library
 * hands the keyboard back to whatever had it before a notice was reached,
 * in the moment in which the notice loses it: so the first call can end
 * with the keyboard there, and not where it was sent. The second takes it
 * from there, when no notice has it any more.
 */
export function takeFocus(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus();
  if (document.activeElement !== element) element.focus();
}
