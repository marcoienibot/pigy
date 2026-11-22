import { uuidv7 } from "@pigy/core";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { keepOnDeviceOnce } from "@/lib/device-storage";
import { sharedFrom, sharedText } from "@/lib/share";

/**
 * Where what another app shares to pigy arrives: the share target of the
 * manifest, `apps/web/public/manifest.webmanifest`. The system opens
 * `/share?title=…&text=…&url=…` in the installed app, and this makes a
 * draft of it and goes on to the draft, in the workspace that the device
 * showed last: a window that the system opens has no choice of its own.
 *
 * It has no screen. It is under the route that needs a session, so
 * somebody who is signed out signs in first and is brought back here, and
 * the draft is there then. It asks nothing of the server: the draft is a
 * change like any other, made on the device, also without a connection.
 *
 * The address is a path of the app's own, and not one of the Worker's:
 * the service worker answers it with the app shell.
 */
export const Route = createFileRoute("/_app/share")({
  beforeLoad: ({ location, context, preload }) => {
    // Nothing links here, so nothing loads it ahead. If something ever
    // does, that must not make a draft.
    if (preload) return;
    const text = sharedText(
      sharedFrom(location.search as Record<string, unknown>),
    );
    if (text === "") throw redirect({ to: "/", replace: true });
    const id = uuidv7(new Date());
    context.store.mutate("post.create", {
      id,
      partId: uuidv7(new Date()),
      text,
    });
    keepOnDeviceOnce();
    // In the place of this address, so that going back does not share
    // the same thing again.
    throw redirect({ to: "/", search: { draft: id }, replace: true });
  },
});
