import { CircleCheck, Clock } from "lucide-react";

/** Today's figures are restated every 5 minutes; past this, the pill says so. */
const STALE_AFTER_MIN = 30;

function ago(mins: number): string {
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * "Synced 2 minutes ago" — when the 5-minute cron last wrote these figures
 * (`GET /v1/analytics/sync`). Null renders nothing: nothing written yet is not a sync.
 */
export function SyncedBadge({ syncedAt }: { syncedAt: string | null | undefined }) {
  if (!syncedAt) return null;
  const at = new Date(syncedAt);
  const mins = Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
  const stale = mins > STALE_AFTER_MIN;
  const Icon = stale ? Clock : CircleCheck;
  return (
    <span
      data-synced={stale ? "stale" : "fresh"}
      title={`Last refreshed ${at.toLocaleString()}`}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm whitespace-nowrap text-foreground/80 tabular-nums"
    >
      <Icon aria-hidden className={"size-4 " + (stale ? "text-warning" : "text-success")} />
      Synced {ago(mins)}
    </span>
  );
}
