import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The assistant's mark: the brand's torn receipt with a spark. A logo, so its gradient
 * stops are fixed brand hexes rather than theme tokens.
 *  - color: full colour, for light surfaces
 *  - onbrand: white body, for an indigo fill
 *  - dark: lighter stops, for dark surfaces
 *  - auto (default): color in the light theme, dark in the dark theme
 */

const BODY = "M0 0H32V32L26.67 26.29L21.33 32L16 26.29L10.67 32L5.33 26.29L0 32Z";
const SPARK =
  "M16 4.2 Q17.15 11.25 24.2 12.4 Q17.15 13.55 16 20.6 Q14.85 13.55 7.8 12.4 Q14.85 11.25 16 4.2 Z";

type Variant = "color" | "onbrand" | "dark";

const BODY_STOPS: Record<"color" | "dark", [string, string, string]> = {
  color: ["#4E4EDA", "#0893A6", "#8BCB2B"],
  dark: ["#9393F3", "#5ED6E0", "#BEF264"],
};
const SPARK_STOPS: [string, string, string] = ["#4E4EDA", "#0893A6", "#65A30D"];

function Mark({
  variant,
  size,
  className,
  twinkle,
}: {
  variant: Variant;
  size: number;
  className?: string;
  /** The spark glints now and then (`.billy-twinkle` in globals.css). */
  twinkle?: boolean;
}) {
  const gid = `billy-${React.useId().replace(/:/g, "")}`;
  const gradient =
    variant === "onbrand" ? (
      <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="9" y1="5" x2="23" y2="20">
        <stop offset="0" stopColor={SPARK_STOPS[0]} />
        <stop offset=".5" stopColor={SPARK_STOPS[1]} />
        <stop offset="1" stopColor={SPARK_STOPS[2]} />
      </linearGradient>
    ) : (
      <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="30" y2="30">
        <stop offset="0" stopColor={BODY_STOPS[variant][0]} />
        <stop offset=".55" stopColor={BODY_STOPS[variant][1]} />
        <stop offset="1" stopColor={BODY_STOPS[variant][2]} />
      </linearGradient>
    );
  const body = variant === "onbrand" ? "#FFFFFF" : `url(#${gid})`;
  const spark = variant === "onbrand" ? `url(#${gid})` : variant === "dark" ? "#0A0F18" : "#FFFFFF";
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <defs>{gradient}</defs>
      <path fill={body} d={BODY} />
      <path fill={spark} d={SPARK} className={twinkle ? "billy-twinkle" : undefined} />
    </svg>
  );
}

export function BillyMark({
  variant = "auto",
  size = 20,
  className,
  twinkle,
}: {
  variant?: Variant | "auto";
  size?: number;
  className?: string;
  twinkle?: boolean;
}) {
  if (variant !== "auto")
    return <Mark variant={variant} size={size} className={className} twinkle={twinkle} />;
  return (
    <>
      <Mark
        variant="color"
        size={size}
        className={cn("dark:hidden", className)}
        twinkle={twinkle}
      />
      <Mark
        variant="dark"
        size={size}
        className={cn("hidden dark:block", className)}
        twinkle={twinkle}
      />
    </>
  );
}
