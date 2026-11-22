import * as React from "react";

import { explain } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import type { Span } from "@/components/analytics/layout";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import type { AnalyticsResult } from "@/lib/analytics-api";
import { Headline, type HeadlineChange } from "./parts";

type Rate = Pick<
  AnalyticsResult,
  "total" | "total_basis" | "total_numerator" | "total_denominator"
> | null;

/** What the four Current cards read. Each page fills it from its own batch. */
export interface CurrentCardsData {
  /** The currency every money figure is stated in. Null: no basis, so money shows a dash. */
  cur: string | null;
  mrr: number | null;
  mrrChange: HeadlineChange | null;
  mrrSpark: Array<number | null>;
  arr: number | null;
  cmrr: number | null;
  cancelling: number | null;
  cancelCur: string | null;
  paying: number | null;
  payingChange: HeadlineChange | null;
  payingSpark: Array<number | null>;
  arpc: { total: number | null; currency?: string | null } | null;
  payingSubs: number | null;
  renewingSubs: number | null;
  custChurn: Rate;
  mrrChurn: Pick<AnalyticsResult, "total"> | null;
  mrrLost: number | null;
  trial: { converted: number | null; ended: number | null };
  trialConv: number | null;
  mrrNew: number | null;
  /** Where a figure opens its list. Absent: the figure is plain text. */
  links?: {
    cancelling?: string;
    payingSubs?: string;
    renewing?: string;
    mrrLost?: string;
    newMrr?: string;
  };
}

const count = (n: number) => n.toLocaleString("en");

/**
 * MRR, Paying customers, Churn and Trial conversion over 30 days: the cards at the head of
 * Business Home and of the organization's Home. One definition, so the two cannot drift.
 */
export function CurrentCards({
  data: d,
  span = 3,
  bare = false,
}: {
  data: CurrentCardsData;
  /** `null`: no column class, the row sets the width. */
  span?: Span | null;
  /** Cells inside a surface that already draws the card. */
  bare?: boolean;
}) {
  const cell = { span, bare };
  const cur = d.cur;
  const mc = (n: number | null, c: string | null = cur) =>
    n == null || !c ? null : moneyCompact(n, c);
  const mt = (n: number | null, c: string | null = cur) =>
    n == null || !c ? undefined : money(n, c);
  const churnOf =
    d.custChurn?.total_basis === "window" &&
    d.custChurn.total_numerator != null &&
    d.custChurn.total_denominator != null
      ? `${count(d.custChurn.total_numerator)} of ${count(d.custChurn.total_denominator)} customers`
      : null;
  const arpc = d.arpc?.total == null ? null : Math.round(d.arpc.total);
  const arpcCur = d.arpc?.currency ?? cur;
  return (
    <>
      <Headline
        {...cell}
        label="MRR"
        info={explain(G.mrr, G.arr, G.cmrr, G.cancelling)}
        change={d.mrrChange}
        spark={d.mrrSpark}
        value={mc(d.mrr) ?? "—"}
        title={mt(d.mrr)}
        stats={[
          { label: "ARR", value: mc(d.arr), title: mt(d.arr) },
          { label: "Committed", value: mc(d.cmrr), title: mt(d.cmrr) },
          {
            label: "Cancelling",
            value: mc(d.cancelling, d.cancelCur),
            title:
              d.cancelling == null || !d.cancelCur
                ? undefined
                : `${money(d.cancelling, d.cancelCur)} of MRR booked to cancel`,
            href: d.links?.cancelling,
          },
        ]}
      />
      <Headline
        {...cell}
        label="Paying customers"
        info={explain(G.payingCustomers, G.arpa, G.payingSubs, G.renewing)}
        change={d.payingChange}
        spark={d.payingSpark}
        value={d.paying == null ? "—" : count(d.paying)}
        stats={[
          {
            label: "ARPC",
            value: arpc == null ? null : mc(arpc, arpcCur),
            title: arpc == null ? undefined : mt(arpc, arpcCur),
          },
          // Paying includes subscriptions booked to stop at term end; renewing excludes them.
          {
            label: "Paying subs",
            value: d.payingSubs == null ? null : count(d.payingSubs),
            href: d.links?.payingSubs,
          },
          {
            label: "Renewing",
            value: d.renewingSubs == null ? null : count(d.renewingSubs),
            href: d.links?.renewing,
          },
        ]}
      />
      <Headline
        {...cell}
        label="Churn, 30 days"
        info={explain(G.customerChurn, G.churned, G.mrrChurnRate, G.mrrLost)}
        value={d.custChurn?.total == null ? "—" : pctFromBps(d.custChurn.total, 1)}
        note={churnOf}
        stats={[
          {
            label: "Churned",
            value:
              d.custChurn?.total_basis === "window" && d.custChurn.total_numerator != null
                ? count(d.custChurn.total_numerator)
                : null,
          },
          {
            label: "MRR churn",
            value: d.mrrChurn?.total == null ? null : pctFromBps(d.mrrChurn.total, 1),
          },
          {
            label: "MRR lost",
            value: mc(d.mrrLost),
            title: mt(d.mrrLost),
            href: d.links?.mrrLost,
          },
        ]}
      />
      <Headline
        {...cell}
        label="Trial conversion, 30 days"
        featured={d.trialConv != null}
        info={explain(G.trialConversion, G.trialsConverted, G.trialsEnded, G.newMrr30)}
        value={d.trialConv == null ? "—" : pctFromBps(d.trialConv, 1)}
        note={
          d.trial.converted != null && d.trial.ended
            ? `${count(d.trial.converted)} of ${count(d.trial.ended)} ended trials converted`
            : null
        }
        stats={[
          {
            label: "Converted",
            value: d.trial.converted == null ? null : count(d.trial.converted),
          },
          { label: "Ended", value: d.trial.ended == null ? null : count(d.trial.ended) },
          {
            label: "New MRR",
            value: mc(d.mrrNew),
            title: mt(d.mrrNew),
            href: d.links?.newMrr,
          },
        ]}
      />
    </>
  );
}
