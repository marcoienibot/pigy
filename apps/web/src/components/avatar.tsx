import { useState } from "react";
import { cn } from "@/lib/utils";

/** Up to two letters to show in place of a picture. */
function initials(name: string): string {
  const [first = "", second = ""] = name.trim().split(/\s+/);
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

/**
 * The picture of a person or an account: the one at `src`, or the initials
 * of `name` where there is none or it does not load, as without a
 * connection. `className` sets the size.
 */
export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-[0.625rem] font-medium text-primary-foreground",
        className,
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          // The server of the picture is not told where it is shown.
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
