import {
  createFileRoute,
  type ErrorComponentProps,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { AppShell } from "@/components/app-shell";
import { PublicPage } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useOnline } from "@/lib/online";
import { checkForUpdate } from "@/lib/service-worker";
import { checkSession, loadSession, SessionUnknown } from "@/lib/session";
import { chosenWorkspace } from "@/lib/workspace";
import { SyncProvider } from "@/sync/react";
import { syncUnsent, workspaceSync } from "@/sync/workspace-sync";

/**
 * Everything that needs a session. Nothing below this route renders before
 * `beforeLoad` knows who is signed in, so a signed-out visitor sees none of
 * it.
 *
 * On a device that has been signed in before, `beforeLoad` does not wait
 * for the server: it takes the word of the device, opens the local copy of
 * the workspace and lets the screens render from it. The server is asked
 * at the same time, and if the session has ended, the app leaves for the
 * sign-in page when the answer is in.
 */
export const Route = createFileRoute("/_app")({
  // Runs on every navigation, so somebody whose session has ended is sent
  // to the sign-in page by the next link they follow. It also runs for a
  // link that is only hovered or focused, which the router loads ahead of
  // a click that may never come: that is no reason to ask the server.
  beforeLoad: async ({ location, abortController, preload }) => {
    const session = await loadSession(abortController.signal, {
      check: !preload,
    });
    if (!session) {
      throw redirect({
        to: "/sign-in",
        // Where to come back to after signing in.
        search: location.href === "/" ? {} : { returnTo: location.href },
        replace: true,
      });
    }
    // Live or sandbox, as this tab has it: see `lib/workspace.ts`. Asked on
    // every navigation, which is how the switch between the two takes
    // effect.
    const workspace = chosenWorkspace(session.workspaces);
    // The same one on every navigation: it is opened once.
    const { store } = await workspaceSync(session.me.user.id, workspace.id);
    syncUnsent(session.me.user.id, session.workspaces);
    // The workspace and its data are handed to the screens together, so
    // none of them can show one under the name of the other.
    return {
      me: session.me,
      workspaces: session.workspaces,
      workspace,
      store,
    };
  },
  component: App,
  errorComponent: Failed,
});

function App() {
  const { store, workspace } = Route.useRouteContext();

  // A socket that is refused is how the app learns soonest that the
  // session has ended, or that somebody else has signed in.
  useEffect(() => {
    const check = () => {
      const { connection } = store.getState();
      if (connection === "signed-out" || connection === "no-access") {
        void checkSession();
      }
    };
    check();
    return store.subscribe(check);
  }, [store]);

  // This window is too old for the server or for the local copy, and says
  // "Reload to update". The version that the reload is to bring is fetched
  // now, so that it is there when the person reloads.
  const outdated = useSyncExternalStore(
    store.subscribe,
    () => store.getState().outdated,
  );
  useEffect(() => {
    if (outdated) void checkForUpdate();
  }, [outdated]);

  return (
    <SyncProvider store={store}>
      <AppShell>
        {/* A screen starts anew when the workspace changes: what it holds
            of the one that was shown, a dialog that is open or a draft
            that can be brought back, is not carried into the other. */}
        <Outlet key={workspace.id} />
      </AppShell>
    </SyncProvider>
  );
}

/**
 * Shown when the app cannot start: nobody is signed in on this device and
 * the server cannot be asked, as without a connection, or a screen failed
 * and has no error screen of its own.
 */
function Failed({ error }: ErrorComponentProps) {
  const router = useRouter();
  const unreachable = error instanceof SessionUnknown;
  // When the connection is back, there is no need to press the button.
  useOnline(() => {
    if (unreachable) void router.invalidate();
  });

  return (
    <PublicPage
      title={
        unreachable ? "pigy cannot reach its server" : "Something went wrong"
      }
    >
      <p className="mt-1 text-muted-foreground">
        {unreachable
          ? "Nobody is signed in on this device, and signing in takes a connection. Once you have signed in, pigy also starts without one."
          : error instanceof Error
            ? error.message
            : String(error)}
      </p>
      <Button
        variant="outline"
        className="mt-6"
        onClick={() => router.invalidate()}
      >
        Try again
      </Button>
    </PublicPage>
  );
}
