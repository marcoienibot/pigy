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
import { renewNotifications } from "@/lib/notifications";
import { useOnline } from "@/lib/online";
import { checkForUpdate, onSubscriptionChanged } from "@/lib/service-worker";
import { checkSession, loadSession, SessionUnknown } from "@/lib/session";
import { dropShared, forgetOldShares, keepShared } from "@/lib/share";
import { chosenWorkspace, keepsAddress, showWorkspace } from "@/lib/workspace";
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
/** Whether this page has deleted the files of shares that are old. */
let prunedShares = false;

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
      // Where to come back to after signing in: the address as the
      // browser has it, which is this one by now, and not as the router
      // would write it. The two differ where a value of the query reads
      // like JSON, as a text can that was shared to pigy, and it has to
      // come back as it went.
      let here = preload
        ? location.href
        : window.location.pathname +
          window.location.search +
          window.location.hash;
      // What was shared to pigy does not go that way: it can be longer
      // than any address that the server keeps through a sign-in, and the
      // person would come back to their drafts without it. The tab keeps
      // it, and the share screen takes it up: `keepShared`. A tab that
      // can keep nothing sends it with the address, as far as that goes.
      if (
        !preload &&
        keepsAddress(window.location.pathname) &&
        keepShared(window.location.search)
      ) {
        here = window.location.pathname;
      }
      throw redirect({
        to: "/sign-in",
        search: here === "/" ? {} : { returnTo: here },
        replace: true,
      });
    }
    // What a tab has kept of a share, for the sign-in, is for the share
    // screen. Somebody who goes to another screen without deciding there
    // has left it, as they leave a share that the address holds, and its
    // files go from the device.
    if (!preload && !keepsAddress(location.pathname)) dropShared();
    // The files of shares that no screen took up, once a page load.
    if (!preload && !prunedShares) {
      prunedShares = true;
      void forgetOldShares();
    }
    // An address can name the workspace that it is about: the one that a
    // notification leads to, which the person has pressed on a device
    // whose tab may show the other one. A post of the sandbox is not in
    // the live workspace, so the tab shows the one that is named, as it
    // does for a connection that ends: this tab alone, and the device
    // goes on remembering what the person chose. The name is taken out
    // of the address, so that the tab is not held to it from then on.
    const named = (location.search as Record<string, unknown>).inWorkspace;
    if (named !== undefined && !preload) {
      const workspace = session.workspaces.find(({ id }) => id === named);
      // A name that is none of this person's is somebody else's, who
      // used the device before: it counts as none.
      if (workspace) showWorkspace(workspace);
      const { inWorkspace: _, ...search } = location.search as Record<
        string,
        unknown
      >;
      throw redirect({
        to: location.pathname,
        search,
        replace: true,
        // The address is the app's own, of whichever screen: the router
        // cannot check it against the type of one.
      } as never);
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

  // Notifications that were turned on in this session go on when the
  // browser has replaced its subscription since: seen when the app
  // starts, and when the service worker hears of it. Beside everything
  // else, and for nobody who has not turned them on.
  useEffect(() => {
    void renewNotifications();
    return onSubscriptionChanged(() => void renewNotifications());
  }, []);

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
 * the server cannot be asked, as without a connection, or answers with an
 * error. Or a screen failed and has no error screen of its own.
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
