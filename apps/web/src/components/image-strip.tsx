import { type SandboxImage, sandboxImagePath } from "@pigy/core";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  fetchedUrl,
  imagesOf,
  type PartImage,
  selectPartImages,
  thumbnailUrl,
} from "@/lib/media";
import { useSynced } from "@/sync/react";

/**
 * Pictures in a row, for reading: the images of a post on the Sent
 * screen, and those of a post of a simulated feed. Each is fetched by the
 * page, as the owner of the workspace, and kept in its memory alone.
 */

/** One picture, once its address is there, and its description until then. */
function Picture({
  url,
  alt,
}: {
  /** Fetches the picture and returns an address for it. */
  url: () => Promise<string>;
  alt: string;
}) {
  const [src, setSrc] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `url` is made anew with every render, and fetches the same picture.
  useEffect(() => {
    let shown = true;
    url().then(
      (found) => {
        if (shown) setSrc(found);
      },
      // Not there, or no connection: the frame stays, with what the
      // picture is said to show.
      () => {},
    );
    return () => {
      shown = false;
    };
  }, []);
  return (
    <li className="size-20 shrink-0 overflow-hidden rounded border bg-muted">
      {src ? (
        <img src={src} alt={alt} className="size-full object-cover" />
      ) : (
        <span className="line-clamp-4 p-1 text-[0.65rem] text-muted-foreground">
          {alt || "Image"}
        </span>
      )}
    </li>
  );
}

function Strip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ul aria-label={label} className="my-1 flex flex-wrap gap-1.5">
      {children}
    </ul>
  );
}

/** The images of the parts `partIds` of a post of the workspace on screen. */
export function PostImages({ partIds }: { partIds: readonly string[] }) {
  const { workspace } = useRouteContext({ from: "/_app" });
  const all = useSynced(selectPartImages);
  const images = partIds.flatMap((partId) => imagesOf(all, partId));
  if (images.length === 0) return null;
  return (
    <Strip label="Images of the post">
      {images.map(({ id, alt, media }: PartImage) => (
        <Picture
          key={id}
          alt={alt}
          url={() =>
            media
              ? thumbnailUrl(workspace.id, media.id)
              : Promise.reject(new Error("The image is gone"))
          }
        />
      ))}
    </Strip>
  );
}

/** The images of a post on a simulated network. */
export function SandboxImages({ images }: { images: readonly SandboxImage[] }) {
  if (images.length === 0) return null;
  return (
    <Strip label="Images of the post">
      {images.map(({ id, alt }) => (
        <Picture
          key={id}
          alt={alt}
          url={() => fetchedUrl(sandboxImagePath(id))}
        />
      ))}
    </Strip>
  );
}
