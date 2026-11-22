import { uuidv7 } from "@pigy/core";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { keepOnDeviceOnce } from "@/lib/device-storage";
import { dropShared, keptShared, sharedFrom, sharedText } from "@/lib/share";
import { environmentLabels } from "@/lib/workspace";
import { useMutate } from "@/sync/react";

/**
 * Where what another app shares to pigy arrives: the share target of the
 * manifest, `apps/web/public/manifest.webmanifest`. The system opens
 * `/share?title=…&text=…&url=…` in the installed app, and this screen
 * shows what came and asks what to do with it.
 *
 * Nothing is stored before the person says so. The address is one that
 * any website can send a browser to, with a text of its choosing: a draft
 * that was made by the visit alone would be written into the workspace,
 * and synced to every device, by whoever made the link. So what came is
 * shown, as text and as nothing else, and "Save as draft" makes the draft:
 * a change like any other, made on the device, also without a connection.
 *
 * It is under the route that needs a session, so somebody who is signed
 * out signs in first and is brought back here. What was shared waits in
 * the tab meanwhile and not in the address that the sign-in comes back
 * to, which the server does not keep at any length: `keepShared` of
 * lib/share.ts. The address is a path of the app's own, and not one of
 * the Worker's: the service worker answers it with the app shell.
 */
export const Route = createFileRoute("/_app/share")({
  component: Share,
});

function Share() {
  const { workspace } = Route.useRouteContext();
  const navigate = useNavigate();
  const mutate = useMutate();
  // From the address as the browser has it: see `sharedFrom`. Read once,
  // when the screen is made, which it is anew in the other workspace when
  // the person changes to that one: the address stays as it is then.
  const [text] = useState(() => {
    const fromAddress = sharedText(sharedFrom(window.location.search));
    if (fromAddress === "") {
      // What was shared before the sign-in, which the tab has kept. It
      // stays kept until the person has decided, so that a reload and a
      // change of workspace show it again, as they do for an address.
      return sharedText(sharedFrom(keptShared()));
    }
    // A share that has come since takes the place of one that was kept.
    dropShared();
    return fromAddress;
  });

  // Nothing was shared: an address that somebody typed, or a share of
  // nothing.
  if (text === "") return <Navigate to="/" replace />;

  const save = () => {
    const id = uuidv7(new Date());
    mutate("post.create", { id, partId: uuidv7(new Date()), text });
    dropShared();
    keepOnDeviceOnce();
    // In the place of this address, so that going back does not offer
    // the same thing again.
    void navigate({ to: "/", search: { draft: id }, replace: true });
  };

  return (
    <Page title="Shared to pigy">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <p className="text-muted-foreground">
          This was shared to pigy. It is not saved yet.
        </p>
        {/* As text: nothing in it is a link or anything else to press. */}
        <blockquote
          aria-label="What was shared"
          className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2"
        >
          {text}
        </blockquote>
        <div className="flex flex-wrap items-center gap-2">
          {/* The main thing to do, so it has the keyboard: Enter saves. */}
          <Button autoFocus onClick={save}>
            Save as draft
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              dropShared();
              void navigate({ to: "/", replace: true });
            }}
          >
            Discard
          </Button>
          <span className="text-muted-foreground text-xs">
            The draft is saved in {environmentLabels[workspace.environment]}.
          </span>
        </div>
      </div>
    </Page>
  );
}
