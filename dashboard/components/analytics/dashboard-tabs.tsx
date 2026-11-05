import Link from "next/link";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";

/**
 * The `Dashboard | All <X>` switch above /transactions and /payment_intents.
 *
 * The LIST renders on BOTH tabs, so these are not two views that swap; the Dashboard
 * tab ADDS the analytics block above a permanent list. That is why this is a pair of
 * LINKS with `aria-current`
 * rather than a Radix `Tabs`: the state lives in the URL (shareable, reload-safe,
 * and the server can skip the analytics read on the list tab), and nothing is
 * hidden behind a client-side panel swap.
 */
export function DashboardTabs({
  basePath,
  search,
  listLabel,
  active,
}: {
  basePath: string;
  /** Every current search param; all of them survive the switch except `tab`. */
  search: Record<string, string | undefined>;
  /** e.g. `All Transactions`. */
  listLabel: string;
  active: "dashboard" | "list";
}) {
  const href = (tab: "dashboard" | "list") => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) {
      if (k !== "tab" && v != null && v !== "") qs.set(k, v);
    }
    // `dashboard` is the default, so it stays out of the URL.
    if (tab === "list") qs.set("tab", "list");
    const q = qs.toString();
    return q ? `${basePath}?${q}` : basePath;
  };

  const tab = (id: "dashboard" | "list", label: string) => (
    <Link
      key={id}
      href={href(id)}
      aria-current={active === id ? "page" : undefined}
      className={segmentItem(active === id)}
    >
      {label}
    </Link>
  );

  return (
    <nav aria-label="Views" className={`${SEGMENT_TRACK} mb-6`}>
      {tab("dashboard", "Dashboard")}
      {tab("list", listLabel)}
    </nav>
  );
}
