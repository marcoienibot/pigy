import { type Limits, maxAltLength, maxImagesPerPart } from "@pigy/core";
import { useRouteContext } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ImagePlus, X } from "lucide-react";
import {
  type ChangeEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  acceptedTypes,
  attachFiles,
  imageNotes,
  type PartImage,
  selectUploading,
  thumbnailUrl,
  uploadsFor,
} from "@/lib/media";
import { useOnline } from "@/lib/online";
import type { Uploads } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import { useMutate, useSynced } from "@/sync/react";

/** The uploads of the tab, for whoever is signed in. */
export function useUploads(): Uploads {
  const { me } = useRouteContext({ from: "/_app" });
  return uploadsFor(me.user.id);
}

/**
 * Keeps the uploads of the workspace on screen going, whatever screen is
 * shown: it goes on with the images that are on their way and whose file
 * the device has, and tries again when the connection is back. It shows
 * nothing.
 */
export function UploadKeeper() {
  const { workspace } = useRouteContext({ from: "/_app" });
  const uploads = useUploads();
  const uploading = useSynced(selectUploading);
  useEffect(() => {
    void uploads.resume(workspace.id, uploading ? uploading.split(" ") : []);
  }, [uploads, workspace.id, uploading]);
  useOnline(() => uploads.retry());
  return null;
}

/**
 * Puts files into a part, as the editor does for files that were chosen,
 * dropped or pasted, and tells the person of the ones that were not
 * taken.
 */
export function useAttach(partId: string, has: number) {
  const { workspace } = useRouteContext({ from: "/_app" });
  const uploads = useUploads();
  const mutate = useMutate();
  return useEffectEvent(async (files: readonly File[]) => {
    if (files.length === 0) return;
    const refusals = await attachFiles(
      files,
      partId,
      has,
      workspace.id,
      mutate,
      uploads,
    );
    for (const refusal of refusals) toast.error(refusal);
  });
}

/** The image files among what was dropped or pasted. */
export function filesOf(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) =>
    file.type.startsWith("image/"),
  );
}

/** An address for the picture of an image, once there is one. */
function usePicture(image: PartImage, uploads: Uploads): string | undefined {
  const { workspace } = useRouteContext({ from: "/_app" });
  const local = useSyncExternalStore(uploads.subscribe, () =>
    image.media ? uploads.url(image.media.id) : undefined,
  );
  const [fetched, setFetched] = useState<string>();
  const ready = image.media?.status === "ready";
  const mediaId = image.media?.id;
  useEffect(() => {
    if (local || !ready || !mediaId) return;
    let shown = true;
    thumbnailUrl(workspace.id, mediaId).then(
      (url) => {
        if (shown) setFetched(url);
      },
      // Without a connection: the tile says what the image is.
      () => {},
    );
    return () => {
      shown = false;
    };
  }, [local, ready, mediaId, workspace.id]);
  return local ?? fetched;
}

/** What the tile of an image says of where the image is, or null. */
function useStatus(image: PartImage, uploads: Uploads): string | null {
  const { media } = image;
  const progress = useSyncExternalStore(uploads.subscribe, () =>
    media ? uploads.progress(media.id) : undefined,
  );
  const lacks = useSyncExternalStore(uploads.subscribe, () =>
    media ? uploads.lacks(media.id) : false,
  );
  if (!media) return "No longer kept";
  if (media.status === "failed") return media.error ?? "Not uploaded";
  if (media.originalGoneAt !== null) return "No longer kept";
  if (media.status === "ready") return null;
  if (progress?.error) return progress.error;
  if (progress?.waiting) return "Waiting for a connection";
  if (progress) {
    return progress.sent >= progress.total
      ? "Checking"
      : `Uploading ${Math.floor((progress.sent / progress.total) * 100)}%`;
  }
  return lacks
    ? "Waiting for the device that has the file"
    : "Waiting to upload";
}

function Tile({
  image,
  index,
  count,
  label,
  onMove,
}: {
  image: PartImage;
  index: number;
  count: number;
  /** What the part is called, for the names of the buttons. */
  label: string;
  /** Moves the image by one place: earlier for -1, later for 1. */
  onMove: (step: -1 | 1) => void;
}) {
  const uploads = useUploads();
  const mutate = useMutate();
  const picture = usePicture(image, uploads);
  const status = useStatus(image, uploads);
  const failed = image.media?.status === "failed" || !image.media;
  const name = `image ${index + 1} of ${label}`;
  return (
    <li
      data-image={image.id}
      className="flex w-full gap-2 rounded-md border p-2 sm:w-[calc(50%-0.25rem)]"
    >
      <div className="relative size-20 shrink-0 overflow-hidden rounded bg-muted">
        {picture && (
          // Described by the field next to it, which is where the
          // description is written.
          <img src={picture} alt="" className="size-full object-cover" />
        )}
        {status && (
          <span
            role="status"
            className={cn(
              "absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-[0.65rem] leading-tight",
              failed && "text-destructive",
            )}
          >
            {status}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <textarea
          aria-label={`Description of ${name}`}
          placeholder="Describe the image for people who cannot see it"
          value={image.alt}
          maxLength={maxAltLength}
          rows={2}
          className="min-h-12 w-full flex-1 resize-none rounded border bg-transparent px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) =>
            mutate("media.setAlt", { id: image.id, alt: event.target.value })
          }
        />
        <div className="flex items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${name} earlier`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${name} later`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${name}`}
            onClick={() => mutate("media.detach", { id: image.id })}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * The images of a part in the editor: each with its picture, where its
 * upload stands, its description, and the buttons that move and remove
 * it, and under them the button that adds more, with what the editor has
 * to say about them.
 */
export function PartImagesField({
  partId,
  images,
  label,
  limits,
  hasLink,
}: {
  partId: string;
  images: readonly PartImage[];
  /** What the part is called: "the post", "part 2". */
  label: string;
  /** The limits of the accounts that get the text. */
  limits: readonly Limits[];
  hasLink: boolean;
}) {
  const mutate = useMutate();
  const attach = useAttach(partId, images.length);
  const input = useRef<HTMLInputElement>(null);
  const notes = imageNotes(images, limits, hasLink);
  const full = images.length >= maxImagesPerPart;

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    // So that the same file can be chosen again.
    event.target.value = "";
    void attach(files);
  };
  /** Moves the image at `index` by one place. */
  const move = (index: number, step: -1 | 1) => {
    const image = images[index];
    const to = index + step;
    if (!image || to < 0 || to >= images.length) return;
    mutate("media.move", {
      id: image.id,
      afterId:
        step === 1 ? (images[to]?.id ?? null) : (images[to - 1]?.id ?? null),
    });
  };

  return (
    <div className="flex flex-col gap-2 px-4 pb-1 md:px-6">
      {images.length > 0 && (
        <ul aria-label={`Images of ${label}`} className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <Tile
              key={image.id}
              image={image}
              index={index}
              count={images.length}
              label={label}
              onMove={(step) => move(index, step)}
            />
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul
          data-image-notes=""
          className="flex flex-col gap-0.5 text-xs text-muted-foreground"
        >
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div>
        <input
          ref={input}
          type="file"
          accept={acceptedTypes}
          multiple
          hidden
          aria-label={`Image files for ${label}`}
          onChange={choose}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={full}
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
          {images.length === 0 ? "Add images" : "Add more"}
        </Button>
        {full && (
          <span className="text-xs text-muted-foreground">
            A part has {maxImagesPerPart} images at most.
          </span>
        )}
      </div>
    </div>
  );
}
