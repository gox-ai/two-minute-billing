import Link from "next/link";
import { RecordCard } from "@/components/patterns/record-page";
import { getCreditBalance } from "@/lib/api/credits";
import { money } from "@/lib/format";

/**
 * The customer's available credit per currency, linking to Customer → Credits.
 * Renders nothing when the balance cannot be read.
 */
export async function CustomerCreditsCard({ biz, cus }: { biz: string; cus: string }) {
  const balances = await getCreditBalance(biz, cus).catch(() => null);
  if (!balances) return null;
  const href = `/businesses/${biz}/customers/${cus}/credits`;
  return (
    <RecordCard
      id="credits"
      title="Credits"
      actions={
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          View credits
        </Link>
      }
    >
      <div className="flex justify-between gap-4 text-sm tabular-nums">
        <span className="text-muted-foreground">Available in {balances.currency}</span>
        <Link href={href} className="figure-link font-medium">
          {money(balances.available_minor, balances.currency)}
        </Link>
      </div>
    </RecordCard>
  );
}
