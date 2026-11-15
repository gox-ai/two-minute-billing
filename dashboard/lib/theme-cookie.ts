/**
 * The theme choice in a cookie, so the server renders the right theme from the first byte.
 *
 * Holds `light`, `dark` or `system` and nothing else. Not HttpOnly: the browser writes it
 * whenever next-themes changes the choice (`ThemeCookie`). Sign-in expires it, so the first
 * page after sign-in renders the account's saved theme instead of a previous person's.
 */

export const THEME_COOKIE = "tmb_theme";
/** next-themes' localStorage key (its default). Other tabs listen to it. */
export const THEME_STORAGE_KEY = "theme";
const ONE_YEAR_S = 365 * 24 * 60 * 60;

export type ThemeChoice = "light" | "dark" | "system";

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "light" || v === "dark" || v === "system";
}

/** The cookie's value from a `document.cookie` string, or null when absent or not a choice. */
export function readThemeCookie(cookieHeader: string): ThemeChoice | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== THEME_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    return isThemeChoice(v) ? v : null;
  }
  return null;
}

/** The `document.cookie` assignment for a choice. */
export function themeCookieString(choice: ThemeChoice, secure: boolean): string {
  return `${THEME_COOKIE}=${choice}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * The choice the server stamps on `<html data-theme-choice>`: the cookie, else the account's
 * saved theme. An attribute, not the `dark` class: React re-renders `<html>` on every
 * `router.refresh()`, and a class prop that changed would overwrite the one next-themes set
 * (for `system` it would strip `dark` on a dark device).
 */
export function themeChoice(
  cookie: string | null | undefined,
  saved: string | null | undefined,
): ThemeChoice | null {
  return isThemeChoice(cookie) ? cookie : isThemeChoice(saved) ? saved : null;
}

/**
 * Runs in <head>, so before first paint and before next-themes' script in <body>: paints the
 * stamped choice the way next-themes does (`light`/`dark` class, `color-scheme`; `system`
 * resolved from the device) and copies it to localStorage, so next-themes agrees.
 */
export const THEME_CHOICE_SCRIPT = `try{var d=document.documentElement,c=d.dataset.themeChoice;if(c==='light'||c==='dark'||c==='system'){var t=c==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):c;d.classList.remove('light','dark');d.classList.add(t);d.style.colorScheme=t;if(localStorage.getItem('${THEME_STORAGE_KEY}')!==c)localStorage.setItem('${THEME_STORAGE_KEY}',c)}}catch(e){}`;
