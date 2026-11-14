import {
  createFileRoute,
  type ErrorComponentProps,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PublicPage } from "@/components/page";
import { Button } from "@/components/ui/button";
import { fetchMe } from "@/lib/api";

/**
 * Everything that needs a session. Nothing below this route renders before
 * `beforeLoad` has an answer, so a signed-out visitor sees none of it.
 */
export const Route = createFileRoute("/_app")({
  // Runs on every navigation, so somebody whose session has ended is sent
  // to the sign-in page by the next link they follow.
  beforeLoad: async ({ location, abortController }) => {
    const me = await fetchMe(abortController.signal);
    if (!me) {
      throw redirect({
        to: "/sign-in",
        // Where to come back to after signing in.
        search: location.href === "/" ? {} : { returnTo: location.href },
        replace: true,
      });
    }
    return { me };
  },
  component: App,
  errorComponent: Failed,
});

function App() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * Shown when the session could not be checked, for example without a
 * connection, or when a screen failed and has no error screen of its own.
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
