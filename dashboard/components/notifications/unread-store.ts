"use client";

import * as React from "react";

/**
 * The bell's unread count, shared by the rail row and the phone top bar. One poll for the
 * whole page: every 60 s while the tab is visible, at once when it becomes visible again, and
 * when the service worker says a push arrived.
 */
export interface Unread {
  count: number;
  destructive: boolean;
}

let state: Unread | null = null;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;

const POLL_MS = 60_000;
const emit = () => listeners.forEach((l) => l());

export async function refreshUnread() {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch("/api/notifications/unread", { cache: "no-store" });
    if (res.ok) {
      const next = (await res.json()) as Unread;
      if (next.count !== state?.count || next.destructive !== state?.destructive) {
        state = next;
        emit();
      }
    }
  } catch {
    // Keep the last count: a blip must not read as "nothing unread".
  } finally {
    inflight = false;
  }
}

/** The bell list changed under the count (a row opened, "Mark all as read"). */
export function setUnread(next: Unread) {
  state = next;
  emit();
}

function onVisible() {
  if (document.visibilityState === "visible") void refreshUnread();
}
function onWorkerMessage(e: MessageEvent) {
  if ((e.data as { type?: string } | null)?.type === "notification") void refreshUnread();
}

function start() {
  void refreshUnread();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshUnread();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (users++ === 0) start();
  return () => {
    listeners.delete(l);
    if (--users === 0) stop();
  };
}

/** Null until the first answer: no badge rather than a guessed zero. */
export function useUnread(): Unread | null {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

/** "99+" past 99. */
export const countText = (n: number) => (n > 99 ? "99+" : String(n));

/** Opens the panel from anywhere (the phone drawer's row opens the phone sheet). */
export const OPEN_EVENT = "tmb:open-notifications";
