import type {
  MutatorArgs,
  MutatorName,
  StoredRejection,
  SyncState,
  SyncStore,
  Tables,
} from "@pigy/core";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";

const StoreContext = createContext<SyncStore | null>(null);

/** Gives the screens below it the workspace that `store` holds. */
export function SyncProvider({
  store,
  children,
}: {
  store: SyncStore;
  children: ReactNode;
}) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

function useStore(): SyncStore {
  const store = use(StoreContext);
  if (!store) throw new Error("useStore must be used within SyncProvider");
  return store;
}

/**
 * Reads the workspace: `select` is given the synced tables as they are to
 * be shown, with the changes of this device that the server has not
 * confirmed. The component renders again when a row changes, never for the
 * network.
 *
 * `select` has to be the same function from one render to the next: one
 * that is declared outside the component, or made with `useCallback`.
 */
export function useSynced<Result>(select: (tables: Tables) => Result): Result {
  const store = useStore();
  const tables = useSyncExternalStore(store.subscribe, store.getView);
  return useMemo(() => select(tables), [select, tables]);
}

/**
 * Returns a function that reads the workspace as it is when it is called.
 * For event handlers: unlike `useSynced`, it does not make the component
 * render again when a row changes.
 */
export function useSyncedNow(): () => Tables {
  return useStore().getView;
}

/**
 * Returns the function that changes the workspace, by the name of a
 * mutator and its arguments. The change shows at once, in every tab.
 */
export function useMutate() {
  const store = useStore();
  return useCallback(
    <Name extends MutatorName>(name: Name, args: MutatorArgs<Name>) =>
      store.mutate(name, args),
    [store],
  );
}

/** How sync is getting on. */
export function useSyncState(): SyncState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** The rejected changes that the person has not dismissed, and how to. */
export function useRejections(): {
  rejections: readonly StoredRejection[];
  dismiss: (key: string) => void;
} {
  const store = useStore();
  const rejections = useSyncExternalStore(store.subscribe, store.getRejections);
  const dismiss = useCallback((key: string) => store.dismiss(key), [store]);
  return { rejections, dismiss };
}
