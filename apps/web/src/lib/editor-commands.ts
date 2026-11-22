import { useSyncExternalStore } from "react";

/**
 * What can be done with the draft that is open, for the command palette,
 * which is not part of the editor: the editor says what it offers while
 * it does, and the palette lists that.
 */
export type EditorCommands = {
  /** Opens the dialog that asks for a time. */
  schedule: () => void;
  /** Adds the draft to the queue. */
  enqueue: () => void;
  /** Puts the draft at the front of the queue. */
  shareNext: () => void;
};

let offered: EditorCommands | null = null;
const listeners = new Set<() => void>();

/**
 * Says what the editor offers for the draft that is open, or null when it
 * offers nothing: no draft is open, or the one that is cannot go out yet.
 */
export function offerEditorCommands(commands: EditorCommands | null): void {
  offered = commands;
  for (const listener of listeners) listener();
}

/** What the editor offers now, or null. */
export function useEditorCommands(): EditorCommands | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offered,
  );
}
