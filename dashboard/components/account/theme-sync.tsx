"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import {
  isThemeChoice,
  readThemeCookie,
  themeCookieString,
  type ThemeChoice,
} from "@/lib/theme-cookie";

/** The account theme this browser last applied. */
const SEEN_KEY = "tmb-account-theme-seen";

/**
 * The server painted `cookie ?? saved` (lib/theme-cookie.ts). This applies the ACCOUNT's
 * theme only when it differs from this browser's cookie and is new to this browser: a theme
 * picked on another machine follows the person here, while a local choice made since then
 * (a save that failed) wins, so the page does not flip on every load. Fires when the saved
 * value changes, not when the local theme does, so a pick in progress is never pulled back.
 */
export function ThemeSync({
  saved,
  cookie,
}: {
  saved: ThemeChoice | null | undefined;
  /** The theme cookie as the server read it. */
  cookie: ThemeChoice | null;
}) {
  const { theme, setTheme } = useTheme();
  const apply = React.useEffectEvent((want: string) => {
    if (theme !== want) setTheme(want);
  });
  const differs = !!saved && !!cookie && saved !== cookie;
  React.useEffect(() => {
    if (!saved) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SEEN_KEY);
    } catch {
      // Storage blocked: apply every time, as before.
    }
    if (differs && seen !== saved) apply(saved);
    try {
      localStorage.setItem(SEEN_KEY, saved);
    } catch {
      // Storage blocked.
    }
  }, [saved, differs]);
  return null;
}

/**
 * Keeps the theme cookie equal to this browser's choice, however it changed: the rail
 * toggle, the account page, `ThemeSync`, or another tab (next-themes follows localStorage).
 */
export function ThemeCookie() {
  const { theme } = useTheme();
  React.useEffect(() => {
    if (!isThemeChoice(theme) || readThemeCookie(document.cookie) === theme) return;
    document.cookie = themeCookieString(theme, location.protocol === "https:");
  }, [theme]);
  return null;
}
