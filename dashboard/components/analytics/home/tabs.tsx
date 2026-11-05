"use client";

import Link from "next/link";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { useNavPending } from "@/components/navigation/nav-pending";

export type HomeTab = "overview" | "recurring" | "collections" | "credits" | "usage" | "sales";

export const HOME_TABS: Array<{ id: HomeTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "recurring", label: "Recurring revenue" },
  { id: "credits", label: "Credits" },
  { id: "usage", label: "Usage" },
  { id: "sales", label: "One-time sales" },
  { id: "collections", label: "Collections" },
];

/**
 * Business Home's three views, as LINKS. The tab lives in the URL so it is shareable and
 * Back works; nothing here is client state and each view is rendered on the server, which
 * is also what lets a tab fetch only the figures it shows.
 */
export function HomeTabs({
  biz,
  active,
  currency,
  period,
  shown: visible,
}: {
  biz: string;
  active: HomeTab;
  /** The tabs this business has data for. The active tab always shows. */
  shown?: readonly HomeTab[];
  /** Carried across the switch so picking a currency survives a tab change. */
  currency?: string;
  /** The page-wide period — every tab answers it, so it survives a tab change too. */
  period?: Record<string, string>;
}) {
  const { navigate, pending, target } = useNavPending();
  // The tab just clicked reads as current while its view loads.
  const shown = pending && target ? target : active;
  const href = (id: HomeTab) => {
    const qs = new URLSearchParams();
    // `overview` is the default, so it stays out of the URL.
    if (id !== "overview") qs.set("tab", id);
    if (currency && currency !== "ALL") qs.set("currency", currency);
    for (const [k, v] of Object.entries(period ?? {})) qs.set(k, v);
    const q = qs.toString();
    return `/businesses/${biz}${q ? `?${q}` : ""}`;
  };

  return (
    <nav aria-label="Views" className={`${SEGMENT_TRACK} mb-6`}>
      {HOME_TABS.filter((t) => !visible || visible.includes(t.id) || t.id === active).map((t) => (
        <Link
          key={t.id}
          href={href(t.id)}
          aria-current={shown === t.id ? "page" : undefined}
          onClick={(e) => {
            // A modified click keeps the browser's own behaviour (new tab, new window).
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            navigate(href(t.id), { target: t.id });
          }}
          className={segmentItem(shown === t.id)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
