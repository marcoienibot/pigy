import type { Environment } from "@pigy/core";
import {
  createFileRoute,
  type ErrorComponentProps,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { PublicPage } from "@/components/page";
import { Button } from "@/components/ui/button";
import { checkSession, loadSession } from "@/lib/session";
import { SyncProvider } from "@/sync/react";
import { workspaceSync } from "@/sync/workspace-sync";

/**
 * Which of the person's workspaces the app shows. The switch between live
 * and sandbox comes in phase 3: everything below takes the workspace from
 * the context of this route.
 */
const environment: Environment = "live";

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
  // to the sign-in page by the next link they follow.
  beforeLoad: async ({ location, abortController }) => {
    const session = await loadSession(abortController.signal);
    if (!session) {
      throw redirect({
        to: "/sign-in",
        // Where to come back to after signing in.
        search: location.href === "/" ? {} : { returnTo: location.href },
        replace: true,
      });
    }
    const workspace = session.workspaces.find(
      (candidate) => candidate.environment === environment,
    );
    if (!workspace) throw new Error(`There is no ${environment} workspace`);
    // The same one on every navigation: it is opened once.
    const { store } = await workspaceSync(session.me.user.id, workspace.id);
    return { me: session.me, workspace, store };
  },
  component: App,
  errorComponent: Failed,
});

function App() {
  const { store } = Route.useRouteContext();

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

  return (
    <SyncProvider store={store}>
      <AppShell>
        <Outlet />
      </AppShell>
    </SyncProvider>
  );
}

/**
 * Shown when the session could not be checked, for example without a
 * connection on a device that has not been signed in before, or when a
 * screen failed and has no error screen of its own.
 */
function Failed({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <PublicPage title="Something went wrong">
      <p className="mt-1 text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
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
