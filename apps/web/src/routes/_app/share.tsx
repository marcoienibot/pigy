import { uuidv7 } from "@pigy/core";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { keepOnDeviceOnce } from "@/lib/device-storage";
import { attachFiles, readFile, uploadsFor } from "@/lib/media";
import {
  dropShared,
  forgetFiles,
  keptShared,
  type SharedImages,
  sharedFiles,
  sharedFrom,
  sharedImages,
  sharedText,
  sharesSomething,
  showingFiles,
} from "@/lib/share";
import { environmentLabels } from "@/lib/workspace";
import { useMutate } from "@/sync/react";

/**
 * Where what another app shares to pigy arrives: the share target of the
 * manifest, `apps/web/public/manifest.webmanifest`. The system posts what
 * was shared to `/share`, the service worker keeps the files of it on the
 * device and sends the browser on to `/share?title=…&text=…&url=…&files=…`,
 * sw/shares.ts, and this screen shows what came and asks what to do with
 * it.
 *
 * Nothing is stored before the person says so. The address is one that
 * any website can send a browser to, with a text of its choosing, and a
 * form that any website can post: a draft that was made by the visit
 * alone would be written into the workspace, and synced to every device,
 * by whoever made the link. So what came is shown, as text and as
 * pictures and as nothing else, and "Save as draft" makes the draft: a
 * change like any other, made on the device, also without a connection.
 * The images are uploaded then, as the editor uploads them.
 *
 * It is under the route that needs a session, so somebody who is signed
 * out signs in first and is brought back here. What was shared waits in
 * the tab meanwhile and not in the address that the sign-in comes back
 * to, which the server does not keep at any length: `keepShared` of
 * lib/share.ts. The files wait where the service worker keeps them, for
 * an hour. The address is a path of the app's own, and not one of the
 * Worker's: the service worker answers it with the app shell.
 */
export const Route = createFileRoute("/_app/share")({
  component: Share,
});

function Share() {
  const { workspace, me } = Route.useRouteContext();
  const navigate = useNavigate();
  const mutate = useMutate();
  // From the address as the browser has it: see `sharedFrom`. Read once,
  // when the screen is made, which it is anew in the other workspace when
  // the person changes to that one: the address stays as it is then.
  const [shared] = useState(() => {
    const fromAddress = sharedFrom(window.location.search);
    if (!sharesSomething(fromAddress)) {
      // What was shared before the sign-in, which the tab has kept. It
      // stays kept until the person has decided, so that a reload and a
      // change of workspace show it again, as they do for an address.
      return sharedFrom(keptShared());
    }
    // A share that has come since takes the place of one that was kept.
    // Its own files stay: the screen is made anew for the other
    // workspace with the same address.
    dropShared(fromAddress.files);
    return fromAddress;
  });
  const text = sharedText(shared);
  // The images, once the files that the service worker kept have been
  // read. None to wait for in a share without files.
  const [loaded] = useState(() =>
    shared.files === undefined
      ? Promise.resolve<SharedImages>({ images: [], notes: [] })
      : sharedFiles(shared.files).then((share) =>
          sharedImages(share, readFile),
        ),
  );
  const [images, setImages] = useState<SharedImages | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    showingFiles(shared.files);
    let current = true;
    void loaded.then((read) => {
      if (current) setImages(read);
    });
    return () => {
      current = false;
    };
  }, [loaded, shared.files]);

  // Nothing was shared: an address that somebody typed, or a share of
  // nothing.
  if (!sharesSomething(shared)) return <Navigate to="/" replace />;
  const nothing = images !== undefined && images.images.length === 0;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    // Enter can come before the files are read: they are waited for.
    const { images: files } = await loaded;
    const id = uuidv7(new Date());
    const partId = uuidv7(new Date());
    mutate("post.create", { id, partId, text });
    const refusals = await attachFiles(
      files,
      partId,
      0,
      workspace.id,
      mutate,
      uploadsFor(me.user.id),
    );
    for (const refusal of refusals) toast.error(refusal);
    // The uploads keep the files that they need.
    if (shared.files !== undefined) await forgetFiles(shared.files);
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
        {text === "" ? null : (
          // As text: nothing in it is a link or anything else to press.
          <blockquote
            aria-label="What was shared"
            className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2"
          >
            {text}
          </blockquote>
        )}
        {shared.files === undefined ? null : <SharedPictures images={images} />}
        <div className="flex flex-wrap items-center gap-2">
          {/* The main thing to do, so it has the keyboard: Enter saves. */}
          <Button
            autoFocus
            disabled={saving || (nothing && text === "")}
            onClick={() => void save()}
          >
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

/** The images of a share, as pictures, and what is said of the rest. */
function SharedPictures({ images }: { images: SharedImages | undefined }) {
  // Addresses of the files, which the page holds: no request is made.
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = (images?.images ?? []).map((file) =>
      URL.createObjectURL(file),
    );
    setUrls(made);
    return () => {
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [images]);
  if (!images) {
    return <p className="text-muted-foreground text-sm">Reading the images…</p>;
  }
  return (
    <>
      {urls.length === 0 ? null : (
        <ul
          aria-label="Images that were shared"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {urls.map((url, index) => (
            <li key={url}>
              <img
                src={url}
                alt={`Shared ${index + 1} of ${urls.length}`}
                className="aspect-square w-full rounded-lg border object-cover"
              />
            </li>
          ))}
        </ul>
      )}
      {images.notes.map((note) => (
        <p key={note} className="text-muted-foreground text-sm">
          {note}
        </p>
      ))}
    </>
  );
}
