/**
 * Minimum commitment per term (0383–0385). What regresses without each check:
 *  - the term-end true-up misses the usage billed on the renewal invoice itself, or counts
 *    a month twice;
 *  - a second tick raises a second true-up;
 *  - an immediate cancel bills the full commitment, ignores the cancellation credit, or
 *    ignores "delete";
 *  - a mid-term commitment change is not time-weighted;
 *  - a goodwill credit note claws money back through the true-up; a plan-change one does not
 *    count against it;
 *  - a skipped term still owes its commitment;
 *  - the renewal estimate does not show the line the renewal will raise;
 *  - the commitment is accepted with pending invoices or on an add-on price.
 *
 *   pnpm verify:commitment
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { cancelSubscriptionWithOptions, createSubscription } from "@/modules/subscriptions/service";
import { renewSubscription, runBillingClockTick } from "@/modules/subscriptions/renewal";
import { skipRenewal } from "@/modules/subscriptions/renewal-skips";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateRenewal } from "@/modules/subscriptions/estimate";
import { getCommitment, setCommitment } from "@/modules/subscriptions/commitment";
import { recordUsage } from "@/modules/metering/service";
import { issueAdjustmentCreditNote } from "@/modules/credit-notes/service";
import {
  creditNoteItems,
  creditNotes,
  invoiceLineItems,
  invoices,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;
const errName = (p: Promise<unknown>) =>
  p.then(
    () => "fulfilled",
    (e: Error) => `${e?.name}: ${e?.message}`,
  );
const halfUp = (num: bigint, den: bigint) => (num + den / 2n) / den;

async function main() {
  const org = await createOrganization({ name: `Commitment Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Commitment Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `commitment-${RUN}@example.com`,
    autoCollection: "off",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Annual",
    id: `annual-${RUN}`,
    kind: "plan",
  });
  const meter = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Calls",
    id: `calls-${RUN}`,
    kind: "addon",
  });
  const priceArgs = { organizationId: orgId, businessId: biz.id, currency: "USD" };
  const commitPlan = await createPrice({
    ...priceArgs,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    amountMinor: 1_200_000,
    interval: "year",
    billUsageMonthly: true,
    commitmentAmountMinor: 2_000_000,
  });
  const plainPlan = await createPrice({
    ...priceArgs,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    amountMinor: 1_200_000,
    interval: "year",
  });
  const usage = await createPrice({
    ...priceArgs,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    amountMinor: 200,
    interval: "month",
  });
  ok(
    "an add-on price cannot carry a commitment",
    (
      await errName(
        createPrice({
          ...priceArgs,
          productId: meter.id,
          type: "recurring",
          model: "flat",
          amountMinor: 1,
          interval: "year",
          commitmentAmountMinor: 5,
        }),
      )
    ).startsWith("CatalogError"),
  );

  const now = new Date();
  const monthStart = (back: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const subscribe = (start: Date, withUsage = true, extra: Record<string, unknown> = {}) =>
    createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      startDate: start,
      items: [
        { price: commitPlan, quantity: 1 },
        ...(withUsage ? [{ price: usage, quantity: 1 }] : []),
      ],
      ...extra,
    }).then((r) => r.subscription);
  const itemOf = async (subId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.subscriptionId, subId),
              eq(subscriptionItems.priceId, usage.id),
            ),
          ),
      )
    )[0]!;
  const record = (itemId: string, quantity: number, at: Date) =>
    recordUsage({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionItemId: itemId,
      quantity,
      timestamp: at,
    });
  const tick = () =>
    runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const commitmentLines = (subId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select({ line: invoiceLineItems, inv: invoices })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
        .where(
          and(eq(invoices.subscriptionId, subId), eq(invoiceLineItems.adjustment, "commitment")),
        ),
    );
  const reload = async (subId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, subId)),
      )
    )[0]!;

  // A: a full term ends naturally. 100 units a month × 12 at 200 = 240,000.
  const T0 = monthStart(12);
  const a = await subscribe(T0);
  ok(
    "the commitment is copied from the plan price",
    a.commitmentAmountMinor === 2_000_000n,
    String(a.commitmentAmountMinor),
  );
  const aItem = await itemOf(a.id);
  for (let k = 1; k <= 12; k++)
    await record(aItem.id, 100, new Date(monthStart(13 - k).getTime() + 2 * DAY));
  // F: a full term whose renewal is skipped. Renewed directly: the tick voids a skip whose
  // date has passed, and this one is in the past.
  const f = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      startDate: T0,
      items: [{ price: plainPlan, quantity: 1 }],
      commitmentAmountMinor: 2_000_000n,
    })
  ).subscription;
  await skipRenewal({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: f.id,
    renewalAt: monthStart(0),
    source: "api",
    now: new Date(T0.getTime() + DAY),
  });
  await renewSubscription(orgId, f.id, new Date());
  // B / C: immediate cancels three months in.
  const b = await subscribe(monthStart(3));
  const c = await subscribe(monthStart(3));
  await record((await itemOf(b.id)).id, 50, new Date(monthStart(3).getTime() + 2 * DAY));
  // G: a mid-term change and credit notes.
  const g = await subscribe(monthStart(1), false);
  // H: plan changes, without and with a term reset.
  const h = await subscribe(monthStart(2), false);

  const errs: unknown[] = [];
  for (let i = 0; i < 16; i++) errs.push(...(await tick()).errors);
  ok("no tick recorded a failure", errs.length === 0, JSON.stringify(errs));

  // ── A: the true-up on the renewal ───────────────────────────────────────────
  const aLines = await commitmentLines(a.id);
  ok("A: one commitment line", aLines.length === 1, String(aLines.length));
  const al = aLines[0];
  ok(
    "A: 2,000,000 − (1,200,000 + 240,000 usage, the last month included) = 560,000",
    al?.line.amountMinor === 560_000n,
    String(al?.line.amountMinor),
  );
  ok(
    "A: on the renewal invoice, on the plan price, for the closed term",
    al != null &&
      al.inv.periodStart!.getTime() === monthStart(0).getTime() &&
      al.line.priceId === commitPlan.id &&
      al.line.kind === "recurring" &&
      al.line.periodStart!.getTime() === T0.getTime(),
  );
  await tick();
  ok("A: another tick raises no second true-up", (await commitmentLines(a.id)).length === 1);
  const aNow = await reload(a.id);
  const aStatus = await getCommitment(orgId, aNow);
  ok(
    "A: the new term starts a fresh segment; counted = the new plan fee",
    aStatus.segments.length === 1 &&
      aStatus.segments[0]!.from === monthStart(0).toISOString() &&
      aStatus.countedMinor === 1_200_000n &&
      aStatus.shortfallMinor === 800_000n,
    JSON.stringify({
      ...aStatus,
      proratedMinor: String(aStatus.proratedMinor),
      countedMinor: String(aStatus.countedMinor),
      shortfallMinor: String(aStatus.shortfallMinor),
    }),
  );
  const est = await estimateRenewal({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: a.id,
  });
  ok(
    "A: the renewal estimate shows the true-up the renewal will raise",
    est?.lines.some(
      (l) =>
        l.description.startsWith("Minimum commitment adjustment") && l.amount_minor === 800_000,
    ) === true,
    JSON.stringify(est?.lines),
  );

  // ── F: a skipped term owes nothing ──────────────────────────────────────────
  const fLines = await commitmentLines(f.id);
  ok(
    "F: the term before the skip is trued up on the skip's invoice (nothing billed: all of it)",
    fLines.length === 1 && fLines[0]!.line.amountMinor === 2_000_000n,
    fLines.map((l) => String(l.line.amountMinor)).join(","),
  );
  const fStatus = await getCommitment(orgId, await reload(f.id));
  ok(
    "F: the skipped term carries no commitment",
    fStatus.proratedMinor === 0n,
    String(fStatus.proratedMinor),
  );

  // ── B / C: an immediate cancel ─────────────────────────────────────────────
  const cancelAt = new Date();
  const bBefore = await reload(b.id);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: b.id,
    now: cancelAt,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    unbilledChargesOption: "invoice",
  });
  const start = bBefore.currentPeriodStart!;
  const end = bBefore.currentPeriodEnd!;
  const prorated = halfUp(
    2_000_000n * BigInt(cancelAt.getTime() - start.getTime()),
    BigInt(end.getTime() - start.getTime()),
  );
  const credited = await withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ amount: creditNoteItems.amountMinor })
      .from(creditNoteItems)
      .innerJoin(creditNotes, eq(creditNoteItems.creditNoteId, creditNotes.id))
      .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.subscriptionId, b.id),
          eq(creditNotes.reasonCode, "subscription_cancellation"),
        ),
      );
    return rows.reduce((s, r) => s + r.amount, 0n);
  });
  const bLines = await commitmentLines(b.id);
  const expected = prorated - (1_200_000n - credited + 10_000n);
  ok(
    "B: cancel now bills the prorated commitment less the fees net of the cancellation credit",
    credited > 0n && bLines.length === 1 && bLines[0]!.line.amountMinor === expected,
    `credited=${credited} prorated=${prorated} expected=${expected} got=${bLines.map((l) => l.line.amountMinor).join(",")}`,
  );
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: c.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    unbilledChargesOption: "delete",
  });
  const cCharges = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(
        and(eq(unbilledCharges.subscriptionId, c.id), eq(unbilledCharges.entityType, "commitment")),
      ),
  );
  ok(
    "C: cancel with delete waives the commitment",
    cCharges.length === 1 &&
      cCharges[0]!.status === "voided" &&
      (await commitmentLines(c.id)).length === 0,
    cCharges.map((x) => x.status).join(","),
  );

  // ── G: a mid-term change, goodwill and plan-change credit notes ─────────────
  const gNow = await reload(g.id);
  const changeAt = new Date();
  await setCommitment({
    organizationId: orgId,
    businessId: biz.id,
    sub: gNow,
    amountMinor: 3_000_000n,
    now: changeAt,
  });
  const gStatus = await getCommitment(orgId, await reload(g.id));
  const gs = gNow.currentPeriodStart!.getTime();
  const ge = gNow.currentPeriodEnd!.getTime();
  const weighted = halfUp(
    2_000_000n * BigInt(changeAt.getTime() - gs) + 3_000_000n * BigInt(ge - changeAt.getTime()),
    BigInt(ge - gs),
  );
  ok(
    "G: a change mid-term is time-weighted",
    gStatus.segments.length === 2 && gStatus.proratedMinor === weighted,
    `${gStatus.proratedMinor} vs ${weighted}`,
  );
  const gInv = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, g.id)),
    )
  )[0]!;
  const baseLine = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, gInv.id)),
    )
  ).find((l) => l.kind === "recurring")!;
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: gInv.publicId,
    items: [
      { description: "Goodwill", amountMinor: 50_000, invoiceLineItemPublicId: baseLine.publicId },
    ],
    reasonCode: "other",
  });
  const afterGoodwill = await getCommitment(orgId, await reload(g.id));
  ok(
    "G: a goodwill credit note does not reduce the counted fees",
    afterGoodwill.countedMinor === gStatus.countedMinor,
    `${afterGoodwill.countedMinor} vs ${gStatus.countedMinor}`,
  );
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: gInv.publicId,
    items: [
      {
        description: "Plan change",
        amountMinor: 50_000,
        invoiceLineItemPublicId: baseLine.publicId,
      },
    ],
    reasonCode: "subscription_change",
  });
  const afterChange = await getCommitment(orgId, await reload(g.id));
  ok(
    "G: a plan-change credit note reduces the counted fees",
    afterChange.countedMinor === gStatus.countedMinor - 50_000n,
    `${afterChange.countedMinor} vs ${gStatus.countedMinor}`,
  );

  // ── H: a plan change follows the plan's commitment; a reset trues up the old term ──
  const bigPlan = await createPrice({
    ...priceArgs,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    amountMinor: 1_200_000,
    interval: "year",
    billUsageMonthly: true,
    commitmentAmountMinor: 3_000_000,
  });
  const hBefore = await reload(h.id);
  const planItem = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, h.id)),
    )
  )[0]!;
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: h.id,
    now: new Date(),
    changes: [{ itemId: planItem.publicId, newPriceId: bigPlan.publicId }],
    invoiceImmediately: true,
  });
  const hSwapped = await reload(h.id);
  const hSegs = (hSwapped.commitmentSegments ?? []) as Array<{ amount_minor: string }>;
  ok(
    "H: a plan swap moves the commitment to the new plan's, from now",
    hSwapped.commitmentAmountMinor === 3_000_000n &&
      hSegs.length === 2 &&
      hSegs[1]!.amount_minor === "3000000" &&
      hSwapped.currentPeriodStart!.getTime() === hBefore.currentPeriodStart!.getTime(),
    JSON.stringify(hSwapped.commitmentSegments),
  );
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: h.id,
    now: new Date(),
    changes: [],
    resetTerm: true,
    invoiceImmediately: true,
  });
  const hCharges = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(
        and(eq(unbilledCharges.subscriptionId, h.id), eq(unbilledCharges.entityType, "commitment")),
      ),
  );
  const hReset = await reload(h.id);
  ok(
    "H: a term reset queues the old term's prorated true-up once",
    hCharges.length === 1 &&
      hCharges[0]!.amountMinor > 0n &&
      hCharges[0]!.periodStart?.getTime() === hBefore.currentPeriodStart!.getTime(),
    hCharges.map((x) => `${x.amountMinor}@${x.periodStart?.toISOString()}`).join(","),
  );
  ok(
    "H: the reset term starts fresh: one segment, a new sub-period",
    ((hReset.commitmentSegments ?? []) as unknown[]).length === 1 &&
      hReset.currentSubPeriodStart?.getTime() === hReset.currentPeriodStart?.getTime() &&
      hReset.currentSubPeriodEnd != null,
  );

  // ── Pending invoices ───────────────────────────────────────────────────────
  ok(
    "a commitment with pending invoices is refused at create",
    (await errName(subscribe(monthStart(0), false, { createPendingInvoices: true }))).startsWith(
      "SubscriptionError",
    ),
  );
  const pending = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price: plainPlan, quantity: 1 }],
      createPendingInvoices: true,
    })
  ).subscription;
  ok(
    "…and on the subscription",
    (
      await errName(
        setCommitment({
          organizationId: orgId,
          businessId: biz.id,
          sub: pending,
          amountMinor: 1n,
          now: new Date(),
        }),
      )
    ).startsWith("CommitmentError"),
  );
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ COMMITMENT: PASS" : "\n❌ COMMITMENT: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
