import * as React from "react";
import { Grid, Block, BlockLink, Stack } from "@/components/analytics/layout";
import { G } from "@/components/analytics/glossary";
import { money, moneyCompact } from "@/lib/format";
import type { BatchEntry, AnalyticsResult } from "@/lib/analytics-api";
import { BucketBars } from "./charts";
import { BarList, Lead, Line, Lines, Tile, pick, slice, slices, type Basis } from "./parts";

/**
 * Business Home's tabs for the non-subscription models: Credits, Usage and One-time sales.
 * Each is drawn only when the business has that kind of data (see the page's presence check).
 */

const count = (n: number) => n.toLocaleString("en");
const pts = (r: AnalyticsResult | null) => ({
  labels: (r?.series ?? []).map((p) => p.label),
  values: (r?.series ?? []).map((p) => p.value ?? null),
});
const HORIZON = ["overdue", "1_30", "31_60", "61_90", "90_plus", "undated"];
/** The bands as credit reads them; the generic labels speak of things falling due. */
const EXPIRY_LABEL: Record<string, string> = {
  overdue: "Past its expiry date",
  "1_30": "Within 30 days",
  "31_60": "In 31–60 days",
  "61_90": "In 61–90 days",
  "90_plus": "After 90 days",
  undated: "Does not expire",
};

export function creditsZones({
  biz,
  basis,
  batch,
  lowCredit,
}: {
  biz: string;
  basis: Basis;
  batch: BatchEntry[];
  /** Customers whose credit runs out within 7 days (the customers list's own count). */
  lowCredit: number | null;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const total = (key: string) => pick(batch, key)?.total ?? null;
  const moneyOrDash = (n: number | null) => (n == null ? "—" : moneyCompact(n, cur));
  const countOrDash = (n: number | null) => (n == null ? "—" : count(n));
  const customers = `/businesses/${biz}/customers`;

  const balance = total("c_balance");
  const expiring = slices(pick(batch, "c_expiring")).sort(
    (a, z) => HORIZON.indexOf(a.key) - HORIZON.indexOf(z.key),
  );
  const byUnit = slices(pick(batch, "c_by_unit"));

  const current = (
    <Stack>
      <Grid>
        <Tile
          span={3}
          label="Credit balance"
          info={G.creditBalance}
          value={moneyOrDash(balance)}
          title={balance == null ? undefined : money(balance, cur)}
          note="face value"
        />
        <Tile
          span={3}
          label="Credit liability"
          info={G.creditLiability}
          value={moneyOrDash(total("c_liability"))}
          note="paid credit not used yet"
        />
        <Tile
          span={3}
          label="Customers with credit"
          value={countOrDash(total("c_customers"))}
          href={`${customers}?filter=credit_balance:gt:0`}
        />
        <Tile
          span={3}
          label="Prepaid account balance"
          info={G.prepaidBalance}
          value={moneyOrDash(total("c_prepaid"))}
          note="kept apart from credit"
        />
      </Grid>
      <Grid>
        <Block
          span={6}
          title="When credit expires"
          info={G.creditsExpiring}
          action={
            <BlockLink href={`${customers}?filter=next_credit_expiry_at:in_next:30`}>
              Expiring in 30 days
            </BlockLink>
          }
        >
          {expiring.length > 0 ? (
            <BarList
              rows={expiring.map((r) => ({
                key: r.key,
                label: EXPIRY_LABEL[r.key] ?? r.label,
                total: r.total,
              }))}
              format={(n) => moneyCompact(n, cur)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No customer holds credit now.</p>
          )}
        </Block>
        <Block
          span={6}
          title="Running low"
          info={G.creditRunway}
          action={
            <BlockLink href={`${customers}?filter=credit_runway_days:lt:7`}>Customers</BlockLink>
          }
        >
          <Lead
            value={countOrDash(lowCredit)}
            note="customers run out within 7 days at their use of the last 7 days"
          />
          {byUnit.length > 1 ? (
            <div className="mt-4 border-t pt-4">
              <Lines>
                {byUnit.map((u) => (
                  <Line
                    key={u.key}
                    label={`Balance in ${u.label}`}
                    value={moneyCompact(u.total, cur)}
                  />
                ))}
              </Lines>
            </div>
          ) : null}
        </Block>
      </Grid>
    </Stack>
  );

  const granted = total("c_granted");
  const used = total("c_used");
  const expired = total("c_expired");
  const usedSeries = pick(batch, "c_used_series");
  const sources = slices(pick(batch, "c_granted_by"));

  const performance = (
    <Stack>
      <Grid>
        <Block span={8} title="Credit flow" info={G.creditFlow}>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Lead value={moneyOrDash(granted)} note="granted" />
            <Lead value={moneyOrDash(used)} note="used" />
            <Lead value={moneyOrDash(expired)} note="expired unused" />
          </div>
          {usedSeries && usedSeries.series.length > 0 ? (
            <div className="mt-4">
              <BucketBars
                labels={pts(usedSeries).labels}
                values={pts(usedSeries).values}
                seriesLabel="Credits used"
                tone="brand"
                kind="money"
                currency={usedSeries.currency ?? cur}
              />
            </div>
          ) : null}
        </Block>
        <Block span={4} title="Revenue from credit" info={G.creditRevenue}>
          <Lines>
            <Line label="Credit packs sold" value={countOrDash(total("c_packs"))} />
            <Line
              label="Pack sales billed"
              value={moneyOrDash(slice(pick(batch, "c_pack_revenue"), "credit_pack"))}
            />
            <Line label="Revenue recognized on use" value={moneyOrDash(total("c_used_cost"))} />
            <Line label="Breakage" value={moneyOrDash(total("c_breakage"))} />
          </Lines>
        </Block>
      </Grid>
      {sources.length > 0 ? (
        <Grid>
          <Block span={12} title="Credit granted, by where it came from">
            <BarList
              rows={sources.map((r) => ({ key: r.key, label: r.label, total: r.total }))}
              format={(n) => moneyCompact(n, cur)}
            />
          </Block>
        </Grid>
      ) : null}
    </Stack>
  );

  return { current, performance };
}

export function usageZones({
  biz,
  basis,
  batch,
  stopped,
}: {
  biz: string;
  basis: Basis;
  batch: BatchEntry[];
  /** Customers with no usage in the last 30 days who had some before (customers list count). */
  stopped: number | null;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const total = (key: string) => pick(batch, key)?.total ?? null;
  const moneyOrDash = (n: number | null) => (n == null ? "—" : moneyCompact(n, cur));
  const countOrDash = (n: number | null) => (n == null ? "—" : count(n));
  const customers = `/businesses/${biz}/customers`;
  const margin = `/businesses/${biz}/reports/usage-margin`;

  const current = (
    <Grid>
      <Tile
        span={3}
        label="Usage revenue, 30 days"
        info={G.usageRevenue}
        value={moneyOrDash(slice(pick(batch, "u_rev30"), "usage"))}
      />
      <Tile span={3} label="Usage events, 30 days" value={countOrDash(total("u_events30"))} />
      <Tile
        span={3}
        label="Customers with usage, 30 days"
        value={countOrDash(total("u_customers30"))}
      />
      <Tile
        span={3}
        label="Usage stopped"
        info={G.usageStopped}
        value={countOrDash(stopped)}
        note="no usage in 30 days"
        href={`${customers}?filter=days_since_last_usage:gte:30`}
      />
    </Grid>
  );

  const revenue = slice(pick(batch, "u_rev"), "usage");
  const events = pick(batch, "u_events_series");
  const retention = total("u_retention");
  const byMeter = slices(pick(batch, "u_rev_meter"));
  const eventsByMeter = slices(pick(batch, "u_events_meter"));

  const performance = (
    <Stack>
      <Grid>
        <Block span={8} title="Usage" info={G.usageRevenue}>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Lead value={moneyOrDash(revenue)} note="usage revenue billed" />
            <Lead value={countOrDash(total("u_events"))} note="events" />
            <Lead value={countOrDash(total("u_customers"))} note="customers with usage" />
          </div>
          {events && events.series.length > 0 ? (
            <div className="mt-4">
              <BucketBars
                labels={pts(events).labels}
                values={pts(events).values}
                seriesLabel="Usage events"
                tone="brand"
                kind="count"
              />
            </div>
          ) : null}
        </Block>
        <Block
          span={4}
          title="Retention and cost"
          info={G.usageRetention}
          action={<BlockLink href={margin}>Usage margin</BlockLink>}
        >
          <Lead
            value={retention == null ? "—" : `${(retention / 100).toFixed(1)}%`}
            note="usage revenue retention"
          />
          <div className="mt-4 border-t pt-4">
            <Lines>
              <Line label="Cost of usage lines with a cost" value={moneyOrDash(total("u_cost"))} />
            </Lines>
          </div>
        </Block>
      </Grid>
      {byMeter.length > 0 || eventsByMeter.length > 0 ? (
        <Grid>
          <Block span={6} title="Usage revenue by meter">
            <BarList
              rows={byMeter.map((r) => ({ key: r.key, label: r.label, total: r.total }))}
              format={(n) => moneyCompact(n, cur)}
            />
          </Block>
          <Block span={6} title="Events by meter">
            <BarList
              rows={eventsByMeter.map((r) => ({ key: r.key, label: r.label, total: r.total }))}
              format={count}
            />
          </Block>
        </Grid>
      ) : null}
    </Stack>
  );

  return { current, performance };
}

export function salesZones({
  biz,
  basis,
  batch,
  lapsed,
}: {
  biz: string;
  basis: Basis;
  batch: BatchEntry[];
  /** Buyers with no order in 90 days (customers list count). */
  lapsed: number | null;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const total = (key: string) => pick(batch, key)?.total ?? null;
  const moneyOrDash = (n: number | null) => (n == null ? "—" : moneyCompact(n, cur));
  const countOrDash = (n: number | null) => (n == null ? "—" : count(n));
  const pct = (bps: number | null) => (bps == null ? "—" : `${(bps / 100).toFixed(1)}%`);
  const customers = `/businesses/${biz}/customers`;

  const current = (
    <Grid>
      <Tile
        span={3}
        label="Orders, 30 days"
        info={G.orders}
        value={countOrDash(total("s_orders30"))}
      />
      <Tile span={3} label="Order revenue, 30 days" value={moneyOrDash(total("s_revenue30"))} />
      <Tile span={3} label="Average order value, 30 days" value={moneyOrDash(total("s_aov30"))} />
      <Tile
        span={3}
        label="No order in 90 days"
        value={countOrDash(lapsed)}
        note="buyers who did not come back"
        href={`${customers}?filter=days_since_last_order:gte:90`}
      />
    </Grid>
  );

  const orders = pick(batch, "s_orders_series");
  const revenue = total("s_revenue");
  const refunds = total("s_refunds");
  const products = slices(pick(batch, "s_by_product"));

  const performance = (
    <Stack>
      <Grid>
        <Block
          span={8}
          title="Orders"
          info={G.orders}
          action={
            <BlockLink href={`/businesses/${biz}/reports/stats/checkout_conversion`}>
              Checkout conversion
            </BlockLink>
          }
        >
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Lead value={countOrDash(total("s_orders"))} note="orders" />
            <Lead value={moneyOrDash(revenue)} note="order revenue" />
            <Lead value={moneyOrDash(total("s_aov"))} note="average order value" />
          </div>
          {orders && orders.series.length > 0 ? (
            <div className="mt-4">
              <BucketBars
                labels={pts(orders).labels}
                values={pts(orders).values}
                seriesLabel="Orders"
                tone="brand"
                kind="count"
              />
            </div>
          ) : null}
        </Block>
        <Block
          span={4}
          title="Buyers"
          info={G.returningBuyers}
          action={
            <BlockLink href={`${customers}?filter=order_count:gte:2`}>Repeat buyers</BlockLink>
          }
        >
          <Lead value={countOrDash(total("s_buyers"))} note="buyers" />
          <div className="mt-4 border-t pt-4">
            <Lines>
              <Line label="Returning buyers" value={countOrDash(total("s_returning"))} />
              <Line label="Returning buyer rate" value={pct(total("s_returning_rate"))} />
              <Line
                label="Refunds on orders"
                value={
                  refunds == null
                    ? "—"
                    : revenue
                      ? `${moneyCompact(refunds, cur)} · ${((refunds / revenue) * 100).toFixed(1)}%`
                      : moneyCompact(refunds, cur)
                }
              />
            </Lines>
          </div>
        </Block>
      </Grid>
      {products.length > 0 ? (
        <Grid>
          <Block span={12} title="Order revenue by product">
            <BarList
              rows={products
                .slice(0, 10)
                .map((r) => ({ key: r.key, label: r.label, total: r.total }))}
              format={(n) => moneyCompact(n, cur)}
            />
          </Block>
        </Grid>
      ) : null}
    </Stack>
  );

  return { current, performance };
}
