/**
 * The installable app's shared bits: the service worker registration, the captured install
 * prompt, and the last-business cookie the app shortcuts read. Plain module (no "use client"),
 * so the server-side /go route can import the cookie name; the browser-only functions guard
 * themselves.
 */

/** The business this device used last; read by /go/<section> (the manifest shortcuts). */
export const LAST_BUSINESS_COOKIE = "tmb_last_biz";

/** A business id as it may appear in a path segment. Anything else is ignored. */
export const BUSINESS_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const SW_URL = "/sw.js";

/** The active worker's registration, or null where there is none (dev, old browser). */
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

/** Chrome's `beforeinstallprompt` event; not in lib.dom. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// The deferred install prompt. Captured once, early, by <SwRegister>; the account menu reads it.
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function setInstallPrompt(e: InstallPromptEvent | null) {
  deferred = e;
  listeners.forEach((l) => l());
}

export const installPrompt = {
  get: () => deferred,
  getServer: () => null,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** True when the page runs as the installed app (or iOS Home Screen web app). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone or iPad Safari, where install is Share → Add to Home Screen. */
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports a Mac UA; touch points tell them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // The help names Safari's Share button, so other iOS browsers are left out.
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}
