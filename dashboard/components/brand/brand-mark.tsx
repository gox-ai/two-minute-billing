import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A business's mark, wherever one is shown to its customers.
 *
 * Shared by the hosted portal/checkout header AND the Brand Styles previews, on
 * purpose: a preview rendered by different code than the real surface is a preview of
 * something that does not exist. Purely presentational — no data access — so the
 * storefront may import it (see the storefront chrome's isolation note).
 *
 * Falls back logo → icon → initials. The initials tile is not a placeholder to be
 * replaced later; it is the correct answer for a business that has set no brand, and
 * it is what most will see until they do.
 */

export function initialsOf(name: string): string {
  // Strip punctuation off each word before taking its initial. Business names in the
  // wild are "acme-analytics (india)" and "Acme, Inc." — taking `word[0]` blindly
  // renders "A(" and "A," as someone's brand mark.
  return (
    name
      .split(/[\s\-_/]+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "•"
  );
}

const SIZES = {
  sm: {
    tile: "size-8 text-xs rounded-lg",
    img: "max-h-8 max-w-[140px]",
    icon: "size-8 rounded-lg",
  },
  md: {
    tile: "size-10 text-sm rounded-xl",
    img: "max-h-10 max-w-[180px]",
    icon: "size-10 rounded-xl",
  },
} as const;

export function BrandMark({
  name,
  logoUrl,
  iconUrl,
  size = "md",
  className,
}: {
  name: string;
  logoUrl?: string | null;
  iconUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  // A wordmark is wide and must not be forced into a square — `object-contain` inside
  // a max-height box is what keeps someone's long logotype from being squashed.
  // eslint-disable-next-line @next/next/no-img-element -- a tenant-supplied absolute URL on an arbitrary host; next/image would need every customer domain in remotePatterns.
  if (logoUrl)
    return (
      <img src={logoUrl} alt={name} className={cn("w-auto object-contain", s.img, className)} />
    );
  // eslint-disable-next-line @next/next/no-img-element -- same.
  if (iconUrl)
    return (
      <img src={iconUrl} alt={name} className={cn("shrink-0 object-cover", s.icon, className)} />
    );
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-solid font-semibold tracking-tight text-solid-foreground",
        s.tile,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
