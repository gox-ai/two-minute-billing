"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// Re-exported for the back-office, which reaches next-themes only through this file.
export { useTheme } from "next-themes";

/**
 * App-wide theme provider. Class strategy (`.dark` on <html>), system-aware by
 * default, with no-flash hydration handled by next-themes.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
