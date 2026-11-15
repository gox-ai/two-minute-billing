import Link from "next/link";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";

export type TransferTab = "copy" | "history" | "test";

export const TRANSFER_TABS: Array<{ id: TransferTab; label: string }> = [
  { id: "copy", label: "Copy set-up" },
  { id: "history", label: "Past copies" },
  { id: "test", label: "Test data" },
];

/** `?tab=` value → tab; anything else is the copy tab. */
export const tabOf = (v: unknown): TransferTab => (v === "history" || v === "test" ? v : "copy");

/** Copy set-up | Past copies | Test data, as links: the tab is in the URL. */
export function TransferTabs({ biz, active }: { biz: string; active: TransferTab }) {
  return (
    <nav aria-label="Transfer and sample data" data-nav-tabs className={SEGMENT_TRACK}>
      <SegmentIndicator />
      {TRANSFER_TABS.map((t) => (
        <Link
          key={t.id}
          href={`/businesses/${biz}/transfer?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={segmentItem(active === t.id)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
