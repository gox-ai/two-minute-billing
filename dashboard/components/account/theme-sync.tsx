"use client";

import * as React from "react";
import { useTheme } from "next-themes";

/**
 * Applies the theme saved on the ACCOUNT when this browser's own choice differs — so a theme
 * picked on one machine follows the person to the next. Fires when the saved value changes,
 * not when the local theme does, so a pick in progress is never pulled back mid-save.
 */
export function ThemeSync({ saved }: { saved: "light" | "dark" | "system" | null | undefined }) {
  const { theme, setTheme } = useTheme();
  const apply = React.useEffectEvent((want: string) => {
    if (theme !== want) setTheme(want);
  });
  React.useEffect(() => {
    if (saved) apply(saved);
  }, [saved]);
  return null;
}
