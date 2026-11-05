import { cn } from "@/lib/utils";

/**
 * The product logo: TWO and the receipt mark over MINUTE BILLING, one file per theme. The
 * collapsed rail hides it with `nav-label` and shows the receipt mark alone (`.wordmark-mark`,
 * globals.css).
 */
export function Wordmark({
  size = "md",
  className,
}: {
  /** `lg` heads the sign-in screens. */
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const height = size === "lg" ? "h-12" : size === "sm" ? "h-7" : "h-8";
  return (
    <span className={cn("inline-flex items-center", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static public asset */}
      <img src="/brand/mark.svg" alt="" className="wordmark-mark hidden size-7 shrink-0" />
      <span className={cn("nav-label inline-flex shrink-0", height)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static public asset */}
        <img
          src="/brand/logo-horizontal-on-light.svg"
          alt="Two Minute Billing"
          className="h-full w-auto dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- a static public asset */}
        <img
          src="/brand/logo-horizontal-on-dark.svg"
          alt="Two Minute Billing"
          className="hidden h-full w-auto dark:block"
        />
      </span>
    </span>
  );
}
