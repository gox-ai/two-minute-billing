import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomer } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { getGrantActivity, type GrantActivityLine } from "@/lib/api/credit-settings";
import { listCreditUnits } from "@/lib/api/credits";
import { fmtUnits, grantStatusKey, txnKindLabel, unitInfo } from "@/lib/credits";
import { businessTz } from "@/lib/business-tz-server";
import { accountHolderName } from "@/lib/names";
import { money } from "@/lib/format";
import { fmtDateTime } from "@/lib/format-date";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState, EmptyState } from "@/components/states";
import { Facts, RecordCard, Row, Zone } from "@/components/patterns/record-page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

/** One credit grant: what it gave, what used it, what expired or was voided, and what is left. */
export default async function CreditGrantActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; cus: string; grant: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  await requirePermission("credits:view", "manager");
  const { biz, cus, grant } = await params;
  const { after } = await searchParams;
  const base = `/businesses/${biz}/customers/${cus}`;
  let a, business, customer, unitList;
  try {
    [a, business, customer, unitList] = await Promise.all([
      getGrantActivity(biz, cus, grant, after),
      getBusiness(biz).catch(() => undefined),
      getCustomer(biz, cus).catch(() => null),
      listCreditUnits(biz).catch(() => ({ data: [] })),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Credit grant" />
        <ErrorState error={e} thing="credit grant" retry />
      </>
    );
  }
  if (!a) notFound();
  const tz = await businessTz(biz);
  const name = (customer ? accountHolderName(customer) : null) ?? cus;
  const info = unitInfo(unitList.data, a.unit, a.currency);
  const paid = a.category === "paid";
  // Money credit (no unit) counts in minor units, so money() formats it.
  const units = (n: number) => fmtUnits(n, info);
  const left = a.remaining_units;
  const GRANT_STATUS: Record<string, string> = {
    voided: "Voided",
    expired: "Expired",
    not_started: "Not started",
    used_up: "Used up",
    active: "Active",
  };
  const status = GRANT_STATUS[grantStatusKey(a.status, left)];
  const source = (m: GrantActivityLine) =>
    m.settlement ? (
      <span>Usage of {m.meter_name ?? m.meter ?? "a meter"}</span>
    ) : m.invoice ? (
      <Link
        href={`/businesses/${biz}/invoices/${m.invoice}`}
        className="text-primary hover:underline"
      >
        {m.invoice_number ?? "Draft invoice"}
      </Link>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  return (
    <>
      <PageHeader
        title="Credit grant"
        description={`What this grant gave ${name}, what used it and what is left.`}
        breadcrumbs={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Customers", href: `/businesses/${biz}/customers` },
          { label: name, href: base },
          { label: "Credits", href: `${base}/credits` },
          { label: `Grant of ${fmtUnits(a.purchased_units, info)}` },
        ]}
      />
      <Zone title="Summary">
        <Row span="6/6">
          <RecordCard title="Credit">
            <Facts
              rows={[
                { label: "Status", value: status },
                { label: "Given or bought", value: units(a.purchased_units) },
                { label: "Used", value: units(a.used_units) },
                { label: "Expired", value: units(a.expired_units) },
                { label: "Voided", value: units(a.voided_units) },
                { label: "Remaining", value: units(left) },
              ]}
            />
            {left > 0 && a.status === "active" ? (
              <p className="mt-3 text-xs text-muted-foreground">
                This can include usage that we did not take from the grant yet. We take it each
                hour.
              </p>
            ) : null}
          </RecordCard>
          <RecordCard title="Money">
            {paid ? (
              <Facts
                rows={[
                  { label: "Paid by the customer", value: money(a.cost_basis_minor, a.currency) },
                  {
                    label: "Revenue recognized",
                    value: money(a.revenue_recognised_minor, a.currency),
                  },
                  { label: "Breakage", value: money(a.breakage_minor, a.currency) },
                  {
                    label: "Unused credit voided",
                    value: money(a.refunded_minor, a.currency),
                  },
                  {
                    label: "Credited by credit notes",
                    value: money(a.credited_minor, a.currency),
                  },
                  {
                    label: "Deferred revenue left",
                    value: money(a.remaining_cost_minor, a.currency),
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                This credit was given, not sold. It books no revenue when it is used.
              </p>
            )}
          </RecordCard>
        </Row>
      </Zone>
      <Zone title="Activity">
        <RecordCard title="Movements" meta="Oldest first" flush>
          {a.data.length === 0 ? (
            <EmptyState title="No movements" description="The grant has not started yet." />
          ) : (
            <Table phone="stack">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Date</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead phone="aside" className={paid ? "text-right" : "pr-5 text-right"}>
                    Amount
                  </TableHead>
                  {paid ? <TableHead className="pr-5 text-right">Cost</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.data.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-5 tabular-nums">
                      {fmtDateTime(m.created_at, tz)}
                    </TableCell>
                    <TableCell>{txnKindLabel(m)}</TableCell>
                    <TableCell>{source(m)}</TableCell>
                    <TableCell
                      className={paid ? "text-right tabular-nums" : "pr-5 text-right tabular-nums"}
                    >
                      {fmtUnits(m.units, info)}
                    </TableCell>
                    {paid ? (
                      <TableCell className="pr-5 text-right tabular-nums">
                        {money(m.cost_minor, a.currency)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {a.has_more && a.next_cursor ? (
            <div className="px-5 py-3">
              <Link
                href={`?after=${encodeURIComponent(a.next_cursor)}`}
                className="text-sm text-primary hover:underline"
              >
                View later movements
              </Link>
            </div>
          ) : null}
        </RecordCard>
      </Zone>
    </>
  );
}
