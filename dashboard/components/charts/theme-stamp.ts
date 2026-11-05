"use client";

import * as React from "react";

function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  return () => mo.disconnect();
}

const snapshot = () => {
  const el = document.documentElement;
  return `${el.className}|${el.dataset.theme ?? ""}`;
};

/**
 * Changes once the theme is APPLIED to `<html>`. Chart colours are read with
 * getComputedStyle, and next-themes updates `resolvedTheme` before it swaps the class —
 * keying the read on `resolvedTheme` caught the old theme's tokens and left dark ink on a
 * light chart (and the reverse).
 */
export function useThemeStamp(): string {
  return React.useSyncExternalStore(subscribe, snapshot, () => "ssr");
}
