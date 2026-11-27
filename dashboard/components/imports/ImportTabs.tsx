import Link from "next/link";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";

export type ImportTab = "files" | "history" | "export";

const TABS: Array<{ id: ImportTab; label: string }> = [
  { id: "files", label: "Import files" },
  { id: "history", label: "Past imports" },
  { id: "export", label: "Export data" },
];

/** `?tab=` value → tab; anything else is the import tab. */
export const importTabOf = (v: unknown): ImportTab =>
  v === "history" ? "history" : v === "export" ? "export" : "files";

/** Import files | Past imports | Export data, as links: the tab is in the URL. */
export function ImportTabs({
  biz,
  active,
  show = ["files", "history", "export"],
}: {
  biz: string;
  active: ImportTab;
  /** The tabs the signed-in person may open. */
  show?: ImportTab[];
}) {
  return (
    <nav aria-label="Import and export data" data-nav-tabs className={SEGMENT_TRACK}>
      <SegmentIndicator />
      {TABS.filter((t) => show.includes(t.id)).map((t) => (
        <Link
          key={t.id}
          href={`/businesses/${biz}/imports?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={segmentItem(active === t.id)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
