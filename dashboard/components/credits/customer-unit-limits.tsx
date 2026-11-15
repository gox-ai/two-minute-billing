import { RecordCard } from "@/components/patterns/record-page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate } from "@/lib/format-date";
import {
  getUnitRunway,
  listCustomerOverdraftLimits,
  type CustomerCreditOverdraftLimit,
} from "@/lib/api/credit-settings";
import { SOURCE_LABELS } from "@/lib/credit-settings";
import { CustomerOverdraftButton } from "@/components/credits/customer-overdraft-button";

/**
 * Units with no money value: how long the credit lasts at the recent use, and the overdraft
 * limit that applies to this customer (with where it comes from). Lists only the units the
 * customer has a balance in or an own limit for; renders nothing when there are none.
 */
export async function CustomerUnitLimits({
  biz,
  cus,
  tz,
  canManage,
}: {
  biz: string;
  cus: string;
  tz: string | null;
  canManage: boolean;
}) {
  const limits = await listCustomerOverdraftLimits(biz, cus).catch(() => null);
  if (!limits || limits.data.length === 0) return null;
  const all = await Promise.all(
    limits.data.map(async (l: CustomerCreditOverdraftLimit) => ({
      l,
      runway: await getUnitRunway(biz, cus, l.unit).catch(() => null),
    })),
  );
  const rows = all.filter(
    ({ l, runway }) =>
      l.customer_override != null || Number(runway?.balance_units_decimal ?? 0) !== 0,
  );
  if (rows.length === 0) return null;
  const count = (v: string, decimals: number) =>
    Number(v).toLocaleString("en-US", { maximumFractionDigits: decimals });
  return (
    <RecordCard id="unit-limits" title="Credit with no money value" flush>
      <Table phone="stack">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Unit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead>Runway</TableHead>
            <TableHead className="text-right">Overdraft limit</TableHead>
            <TableHead phone="aside" className="pr-5 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ l, runway }) => (
            <TableRow key={l.unit}>
              <TableCell className="pl-5">
                <span className="font-medium">{l.unit_name}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {runway ? count(runway.balance_units_decimal, l.decimals) : "—"}
              </TableCell>
              <TableCell>
                {runway?.runway_days != null && runway.runs_out_at ? (
                  <>
                    {runway.message}
                    <div className="text-xs text-muted-foreground">
                      {fmtDate(runway.runs_out_at, tz)} · {runway.burn_units_per_day_decimal}{" "}
                      {l.unit_name} a day
                    </div>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not enough usage to estimate</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(l.overdraft_limit_decimal, l.decimals)}
                <div className="text-xs text-muted-foreground">{SOURCE_LABELS[l.source]}</div>
              </TableCell>
              <TableCell className="pr-5 text-right">
                {canManage ? (
                  <CustomerOverdraftButton
                    biz={biz}
                    cus={cus}
                    unit={l.unit}
                    unitName={l.unit_name}
                    decimals={l.decimals}
                    override={l.customer_override}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="px-5 py-3 text-xs text-muted-foreground">
        Runway uses the credits taken in the last 7 days. The overdraft limit is how far below 0 the
        balance can go. The next grant pays a negative balance first, unless the unit forgives it
        when plan credits renew.
      </p>
    </RecordCard>
  );
}
