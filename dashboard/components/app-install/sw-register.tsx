"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  BUSINESS_ID,
  LAST_BUSINESS_COOKIE,
  SW_URL,
  setInstallPrompt,
  type InstallPromptEvent,
} from "@/lib/pwa";

// Off in `next dev` unless asked for: a worker caching /_next/static fights HMR.
const ENABLED = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW === "1";

/**
 * Registers /sw.js and keeps the browser's install prompt for the account menu's
 * "Install the app" row and the install card. Renders nothing. Mounted once, in the dashboard shell.
 */
export function SwRegister() {
  React.useEffect(() => {
    const onPrompt = (e: Event) => {
      // Kept for our own install row and card. Not preventDefault(): on Android that would hide
      // the browser's own install banner, and the saved event can still prompt later.
      setInstallPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    if ("serviceWorker" in navigator) {
      if (ENABLED) {
        navigator.serviceWorker.register(SW_URL, { scope: "/" }).catch(() => {
          // No worker means no offline page and no push; the app works without it.
        });
      } else {
        // A worker left over from a production run on this origin would serve stale chunks.
        void navigator.serviceWorker
          .getRegistrations()
          .then((rs) => rs.forEach((r) => void r.unregister()));
      }
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

/** Remembers the business in view, so the app shortcuts (/go/<section>) open it next time. */
export function LastBusiness() {
  const path = usePathname();
  const biz = path.match(/^\/businesses\/([^/]+)/)?.[1];
  React.useEffect(() => {
    if (!biz || !BUSINESS_ID.test(biz)) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${LAST_BUSINESS_COOKIE}=${biz}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, [biz]);
  return null;
}
