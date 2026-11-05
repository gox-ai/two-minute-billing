"use client";

import * as React from "react";

/**
 * State for the hints that teach the ⌘K palette. A per-viewer convenience: localStorage
 * only, every access guarded, and a missing store reads as "already used" so a private
 * window never nags.
 */

/** Opens the palette from anywhere; `CommandPalette` listens for it. */
export const OPEN_EVENT = "cmdk:open";
export const openPalette = () => window.dispatchEvent(new CustomEvent(OPEN_EVENT));

const USED = "tmb:palette:used";
const WELCOME = "tmb:palette:welcome-dismissed";
const TIP = "tmb:palette:tip-shown";
const VISITS = "tmb:palette:slow-visits";
const LAST = "tmb:palette:slow-last";
const CHANGED = "tmb:palette-hints-changed";

/** Record visits without the palette before the one-time tip. */
const TIP_AFTER = 3;

function read(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent(CHANGED));
  } catch {
    // Storage unavailable — the hints stay hidden.
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGED, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGED, cb);
    window.removeEventListener("storage", cb);
  };
}

/** True once a key was set, or when storage cannot be read. Server: true, so nothing flashes. */
function useFlag(key: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => read(key) !== null,
    () => true,
  );
}

export const markPaletteUsed = () => {
  if (read(USED) === null) write(USED, "1");
};
export const usePaletteUsed = () => useFlag(USED);

export const dismissPaletteWelcome = () => write(WELCOME, "1");
export const usePaletteWelcomeDismissed = () => useFlag(WELCOME);

/**
 * Counts a record reached without the palette. True exactly once — on the visit that
 * crosses the threshold — so the caller shows the tip once. The same record twice in a
 * row (a refresh, a dev double effect) counts once.
 */
export function noteSlowRecordVisit(recordId: string): boolean {
  if (read(USED) !== null || read(TIP) !== null || read(LAST) === recordId) return false;
  if (!paletteKeys()) return false;
  write(LAST, recordId);
  const n = Number(read(VISITS) ?? 0) + 1;
  if (n < TIP_AFTER) {
    write(VISITS, String(n));
    return false;
  }
  write(TIP, "1");
  return true;
}

/**
 * "⌘K" on Apple devices, "Ctrl K" elsewhere, null on a touch-only device (a phone has no
 * keyboard to press it on). Browser only.
 */
export function paletteKeys(): string | null {
  if (!window.matchMedia("(any-pointer: fine)").matches) return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "")
    ? "⌘K"
    : "Ctrl K";
}

/** `paletteKeys()`, or null on the server, so no wrong key flashes. */
export function usePaletteKey(): string | null {
  return React.useSyncExternalStore(
    () => () => {},
    paletteKeys,
    () => null,
  );
}

/** Typing into a field, or a dialog already open: `/` belongs to them, not the palette. */
export function slashBelongsElsewhere(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
      t.closest('[role="combobox"],[role="textbox"],[role="listbox"]'))
  )
    return true;
  return !!document.querySelector(
    '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]',
  );
}
