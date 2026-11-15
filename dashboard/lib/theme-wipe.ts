/// <reference lib="dom" />
// Unit tests pull this file into the engine program, which has no DOM lib.
import * as React from "react";
import { flushSync } from "react-dom";
import { useTheme } from "next-themes";
import { THEME_WIPE } from "./motion";

/**
 * Theme wipe: the new theme spreads as a circle from the control that changed it.
 * A same-document view transition snapshots the page, the theme changes inside the update,
 * and `app/motion/theme-wipe.css` (keyed on `<html data-theme-wipe>`) grows the new snapshot's
 * clip from the press to the farthest corner. The attribute lives only for the wipe, so the
 * navigation rules that hide and freeze the root snapshot stay in charge otherwise.
 */

type Point = { x: number; y: number };
type Rect = { left: number; top: number; width: number; height: number };
type Press = { clientX: number; clientY: number; detail: number };

/** The radius that covers a `w`×`h` viewport from (x, y): the distance to its farthest corner. */
export function wipeRadius(x: number, y: number, w: number, h: number): number {
  return Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

/** The theme a choice paints: "system" follows the device. */
export function resolveTheme(choice: string, prefersDark: boolean): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark ? "dark" : "light";
}

/**
 * Where the wipe starts: the pointer, or the control's centre for a keyboard press
 * (a keyboard `click` has `detail` 0 and no real coordinates).
 */
export function wipeOrigin(control: Rect | null, press?: Press | null): Point | null {
  if (press && press.detail > 0) return { x: press.clientX, y: press.clientY };
  if (!control) return null;
  return { x: control.left + control.width / 2, y: control.top + control.height / 2 };
}

type StartVT = (update: () => unknown) => { finished: Promise<void>; ready: Promise<void> };

const VARS = ["--wipe-x", "--wipe-y", "--wipe-r"] as const;

/** next-themes applies the class in an effect; wait for it so the new snapshot has it. */
function classApplied(want: "light" | "dark"): Promise<void> {
  const html = document.documentElement;
  if (html.classList.contains("dark") === (want === "dark")) return Promise.resolve();
  return new Promise((resolve) => {
    const mo = new MutationObserver(() => {
      if (html.classList.contains("dark") !== (want === "dark")) return;
      mo.disconnect();
      resolve();
    });
    mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    window.setTimeout(() => {
      mo.disconnect();
      resolve();
    }, 150);
  });
}

/**
 * `setTheme`, with the wipe. Pass the pressed control's origin (`wipeOrigin`).
 * Switches at once where view transitions are missing, under reduced motion, when the
 * painted theme would not change (a "System" pick that matches), or when the theme is forced.
 */
export function useThemeWipe() {
  const { theme, setTheme, forcedTheme } = useTheme();
  const change = React.useCallback(
    (choice: string, origin: Point | null) => {
      const html = document.documentElement;
      const start = (document as { startViewTransition?: StartVT }).startViewTransition;
      const from = html.classList.contains("dark") ? "dark" : "light";
      const to = resolveTheme(choice, window.matchMedia("(prefers-color-scheme: dark)").matches);
      if (
        !THEME_WIPE ||
        forcedTheme ||
        !origin ||
        from === to ||
        typeof start !== "function" ||
        document.visibilityState !== "visible" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setTheme(choice);
        return;
      }
      const r = wipeRadius(origin.x, origin.y, window.innerWidth, window.innerHeight);
      html.style.setProperty("--wipe-x", `${origin.x}px`);
      html.style.setProperty("--wipe-y", `${origin.y}px`);
      html.style.setProperty("--wipe-r", `${Math.ceil(r)}px`);
      html.dataset.themeWipe = "";
      const t = start.call(document, () => {
        flushSync(() => setTheme(choice));
        return classApplied(to);
      });
      void t.finished
        .catch(() => {})
        .finally(() => {
          delete html.dataset.themeWipe;
          for (const v of VARS) html.style.removeProperty(v);
        });
      // A skipped transition (the route guard, or a newer one) still ran the update.
      t.ready.catch(() => {});
    },
    [setTheme, forcedTheme],
  );
  return { theme, switchTheme: change };
}
