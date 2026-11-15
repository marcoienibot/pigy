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
 * Whether a key press is meant for what has the focus and not for the
 * app: the person is typing, or is in a dialog or a menu. Those take the
 * focus when they open, so a key press comes from inside them.
 */
export function isBusy(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    target?.closest(
      "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu']",
    ) != null
  );
}

/**
 * Calls `handle` with the key presses that are shortcuts of the app:
 * those that reach the page while nobody is typing and no dialog or menu
 * has the focus. Key presses with a modifier are not among them: they belong
 * to the browser, apart from the few that `useKeyDown` is used for.
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
