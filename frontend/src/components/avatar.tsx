import * as React from "react";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Falls back to initials rather than a broken image icon. Clerk avatars are
 * remote URLs that can fail to load, and a member list full of grey squares
 * looks like the app is broken rather than like nobody set a photo.
 */
export function Avatar({
  name,
  src,
  hasImage,
  className,
}: {
  name: string;
  src?: string | null;
  /** Clerk's `has_image`: false means imageUrl is a generated placeholder. */
  hasImage?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  // Clerk always returns an imageUrl - when nobody uploaded a photo it is a
  // generated placeholder. `hasImage` is the flag that says whether it is a
  // real upload, so callers pass it through and we fall back to initials
  // rather than showing Clerk's generic avatar.
  const showImage = Boolean(src) && hasImage !== false && !failed;

  React.useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground",
        className,
      )}
      title={name}
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
