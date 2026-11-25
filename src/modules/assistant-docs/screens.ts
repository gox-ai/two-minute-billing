/**
 * The dashboard map at runtime: every signed-in screen, its route and its controls by card
 * (`dashboard-map.generated.json`). Used to check a "Show me" guide and to find the screen a
 * member is on.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface MapScreen {
  route: string;
  scope: "biz" | "org";
  label: string;
  section: string;
  controls: string[];
  groups?: Array<{ title: string | null; controls: string[] }>;
  /** Card and section titles: a guide's `within`, never its control. Absent in an older map. */
  headings?: string[];
  /** Labels the screen lists from a catalogue (a provider directory). Each is also a control. */
  options?: string[];
  /** A control inside a dropdown menu → its trigger's label ("" when not static). */
  menus?: Record<string, string>;
}

const MAP = fileURLToPath(new URL("./dashboard-map.generated.json", import.meta.url));
let screens: MapScreen[] | null = null;
export function dashboardScreens(): MapScreen[] {
  // A slim image without the map has no screens.
  screens ??= existsSync(MAP) ? (JSON.parse(readFileSync(MAP, "utf8")) as MapScreen[]) : [];
  return screens;
}

/**
 * The screen a dashboard path shows: `/businesses/biz_1/subscriptions/sub_2` →
 * `/businesses/{business}/subscriptions/{sub}`. A literal segment beats a placeholder, so
 * `…/subscriptions/new` is not read as a subscription id.
 */
export function screenForPath(
  path: string,
  list: MapScreen[] = dashboardScreens(),
): MapScreen | null {
  const segs = path.split(/[?#]/)[0]!.replace(/\/$/, "").split("/");
  let best: { s: MapScreen; literal: number } | null = null;
  for (const s of list) {
    const parts = s.route.split("/");
    if (parts.length !== segs.length) continue;
    let literal = 0;
    const ok = parts.every((p, i) => {
      if (/^\{\w+\}$/.test(p)) return segs[i] !== "";
      if (p === segs[i]) return ++literal > 0;
      return false;
    });
    if (ok && (!best || literal > best.literal)) best = { s, literal };
  }
  return best?.s ?? null;
}
