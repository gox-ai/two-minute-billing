/**
 * Quiet hours. `resolve.ts` decides that a push is held and until when; this is the release:
 * a member's held pushes for one device go out as one push.
 */
import { kindDef, type NotificationKind } from "./catalogue";
import { countText } from "./text";

/** One push for everything held: most first, then catalogue order. */
export function collapsedPush(items: Array<{ kind: string; count: number }>): {
  title: string;
  body: string;
  url: string;
  tag: string;
  destructive: boolean;
} {
  const byKind = new Map<NotificationKind, number>();
  for (const i of items) {
    const k = i.kind as NotificationKind;
    if (!kindDef(k)) continue;
    byKind.set(k, (byKind.get(k) ?? 0) + Math.max(1, i.count));
  }
  const parts = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => countText(k, n));
  return {
    title: "While quiet hours were on",
    body: parts.length ? `${parts.join(", ")}.` : "You have new notifications.",
    url: "/notifications",
    tag: "quiet_hours",
    destructive: [...byKind.keys()].some((k) => kindDef(k).tone === "destructive"),
  };
}
