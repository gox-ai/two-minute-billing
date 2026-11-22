"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * First-party analytics for the hosted checkout and the portal. No cookie, no storage, no id
 * of its own: the server keys every event to the session the buyer already has. It reports
 * that the page ran, the visible time on each checkout step (`[data-checkout-step]`) or
 * portal section (`.portal-pane[data-pane]`), and invoice PDF clicks. Honours GPC and DNT.
 */
const TICK_MS = 1000;
const PDF = /^\/portal\/invoices\/[^/]+\/pdf$/;

function surfaceOf(path: string | null): "checkout" | "portal" | null {
  if (!path) return null;
  if (path === "/checkout") return "checkout";
  if (path === "/portal") return "portal";
  return null;
}

function privacyRefused(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || navigator.doNotTrack === "1";
}

/** Checkout: the one current step. Portal: every section on screen and displayed. */
function visibleKeys(surface: "checkout" | "portal"): string[] {
  if (surface === "checkout") {
    const step = document.querySelector("[data-checkout-step]")?.getAttribute("data-checkout-step");
    return step ? [step] : [];
  }
  const out: string[] = [];
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll<HTMLElement>(".portal-pane[data-pane]")) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= 0 || r.top >= vh) continue;
    const shown = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (shown >= Math.min(r.height, vh) * 0.3 && el.dataset.pane) out.push(el.dataset.pane);
  }
  return out;
}

export function StorefrontBeacon() {
  const surface = surfaceOf(usePathname());

  useEffect(() => {
    if (!surface || privacyRefused()) return;
    const url = `/${surface}/visit`;
    const post = (body: object, unloading = false) => {
      const json = JSON.stringify(body);
      if (unloading && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([json], { type: "application/json" }));
        return;
      }
      void fetch(url, {
        method: "POST",
        body: json,
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => undefined);
    };

    post({ kind: "view" });
    let acc: Record<string, number> = {};
    let current = visibleKeys(surface);
    let since = performance.now();
    const tick = () => {
      const now = performance.now();
      if (document.visibilityState === "visible")
        for (const k of current) acc[k] = (acc[k] ?? 0) + (now - since);
      since = now;
      current = visibleKeys(surface);
    };
    const flush = () => {
      tick();
      const steps = Object.fromEntries(
        Object.entries(acc)
          .map(([k, ms]) => [k, Math.round(ms)] as const)
          .filter(([, ms]) => ms > 0),
      );
      acc = {};
      if (Object.keys(steps).length) post({ kind: "engage", steps }, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else since = performance.now();
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const href = a?.getAttribute("href");
      if (surface === "portal" && href && PDF.test(href)) post({ kind: "pdf" }, true);
    };

    const timer = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    document.addEventListener("click", onClick, true);
    return () => {
      flush();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("click", onClick, true);
    };
  }, [surface]);

  return null;
}
