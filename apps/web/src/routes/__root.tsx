import { createRootRoute, Outlet } from "@tanstack/react-router";
import { SessionEnded } from "@/components/session-ended";

// The screens are in two groups. Those under `_app` need a session and
// share the app shell. The others, such as the sign-in page, are public.
export const Route = createRootRoute({ component: Root });

function Root() {
  return (
    <>
      <Outlet />
      {/* Over whatever screen the window shows when its session ends. */}
      <SessionEnded />
    </>
  );
}
