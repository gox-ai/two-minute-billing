import { cn } from "@/lib/utils";
import { HEX_RE, onColor } from "@/lib/brand";
import { initialsOf } from "@/components/brand/brand-mark";

const SIZES = {
  // One letter: two do not fit 20px at the 12px type floor.
  "5": "size-5 rounded-md text-xs",
  "6": "size-6 rounded-md text-xs",
  "7": "size-7 rounded-md text-xs",
  "8": "size-8 rounded-md text-sm",
  "10": "size-10 rounded-xl text-sm",
} as const;

/**
 * A business's mark in the dashboard: its icon; else its initials on its brand colour; else its
 * initials on a plain tile. Every business gets the same square, so a list of them lines up, and
 * the initials match the ones its customers see on the hosted pages (`initialsOf`).
 */
export function BizMark({
  name,
  iconUrl,
  brandColor,
  size = "6",
  className,
}: {
  name: string;
  iconUrl?: string | null;
  brandColor?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const box = SIZES[size];
  if (iconUrl) {
    // Square and unrounded: a mark often draws its own frame, and rounding clips its corners.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host
      <img
        src={iconUrl}
        alt=""
        className={cn(box.split(" ")[0], "shrink-0 object-contain", className)}
      />
    );
  }
  const letters = size === "5" ? initialsOf(name).slice(0, 1) : initialsOf(name);
  const brand = brandColor && HEX_RE.test(brandColor) ? brandColor : null;
  return (
    <span
      aria-hidden
      className={cn(
        box,
        "flex shrink-0 items-center justify-center leading-none font-semibold tracking-tight",
        !brand && "border border-border bg-muted text-foreground/70",
        className,
      )}
      style={brand ? { backgroundColor: brand, color: onColor(brand) } : undefined}
    >
      {letters}
    </span>
  );
}
