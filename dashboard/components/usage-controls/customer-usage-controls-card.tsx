import Link from "next/link";
import { RecordCard } from "@/components/patterns/record-page";
import { getCreditRunway, listSpendLimits } from "@/lib/api/usage-controls";
import { runwayLabel } from "@/lib/usage-controls";

/** Runway and the number of spend limits, linking to Customer → Usage controls. */
export async function CustomerUsageControlsCard({ biz, cus }: { biz: string; cus: string }) {
  const [runway, limits] = await Promise.all([
    getCreditRunway(biz, cus).catch(() => null),
    listSpendLimits(biz, cus).catch(() => null),
  ]);
  const href = `/businesses/${biz}/customers/${cus}/usage-controls`;
  const count = limits?.data.length ?? null;
  return (
    <RecordCard
      id="usage-controls"
      title="Usage controls"
      actions={
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          View usage controls
        </Link>
      }
    >
      <div className="flex flex-col gap-1 text-sm tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Credit runway</span>
          <span>{runway ? runwayLabel(runway.runway_days) : "—"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Spend limits</span>
          {count == null ? (
            <span>—</span>
          ) : (
            <Link href={href} className="figure-link">
              {count}
            </Link>
          )}
        </div>
      </div>
    </RecordCard>
  );
}
