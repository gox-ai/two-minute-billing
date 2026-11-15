"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

function appleModifier(): "⌘" | "Ctrl" {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "") ? "⌘" : "Ctrl";
}

/** "⌘" on Apple devices, "Ctrl" elsewhere; null on the server, so no wrong key flashes. */
export function useModKey(): "⌘" | "Ctrl" | null {
  return React.useSyncExternalStore(
    () => () => {},
    appleModifier,
    () => null,
  );
}

/**
 * One key or shortcut. `mod` adds the platform modifier: `<Kbd mod>K</Kbd>` is "⌘K" on a Mac
 * and "Ctrl K" elsewhere, and renders nothing until the platform is known.
 */
export function Kbd({
  mod,
  className,
  children,
  ...props
}: React.ComponentProps<"kbd"> & { mod?: boolean }) {
  const modKey = useModKey();
  if (mod && !modKey) return null;
  return (
    <kbd
      className={cn(
        "inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border bg-card px-1.5 font-sans text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    >
      {mod ? modKey === "⌘" ? <>⌘{children}</> : <>Ctrl {children}</> : children}
    </kbd>
  );
}
