/**
 * Phase H FINAL hardening regression suite (post-H review backlog).
 * HAND-COMPUTED constants + real lifecycle (no fabricated state):
 *   H1 (#8)  reverted defaults: change_term_end without prorate raises NO invoice
 *   H2 (#5)  change_term_end idempotency keyed on a TOKEN, not the line description:
 *            same token → reuse (one invoice); different token → a fresh charge
 *   H3 (#3)  concurrent plan-swap that both auto-include a mandatory addon: exactly
 *            ONE addon item, addon proration charged exactly ONCE
 *   H4 (#7)  trigger_charge resolves an add-on attached to ANY of the sub's plans
 *            (multi-plan), not one arbitrary limit(1) plan
 *   H5 (#12) CN numbers are unique + non-null; sample-data delete keys off metadata
 *            (a merchant SAMPLE10 survives) + re-create is idempotent
 *   H6 (#9)  org-level audit list is mode-gated (a test key can't read live rows)
 *   H7 (#10) every cancel path writes an audit row (end_of_term included)
 *
 *   pnpm verify:hardening-h
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import {
  createSubscription,
  changeTermEnd,
  cancelSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import { changeSubscription, prorateTermChange } from "@/modules/subscriptions/proration";
import { triggerAttachedItemCharge } from "@/modules/subscriptions/items";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon } from "@/modules/coupons/service";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import { createSampleData, deleteSampleData } from "@/modules/transfer/sample-data";
import { listAuditLogs } from "@/modules/audit/service";
import {
  invoices,
  subscriptions,
  subscriptionItems,
  invoiceLineItems,
  prices,
  products,
  coupons,
  creditNotes,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "HardeningH Org" });
const orgId = org.organization.id;

async function pmCustomer(bizId: string, email: string, auto: "on" | "off" = "on") {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: auto,
    address: { country: "US" },
  });
  if (auto === "on")
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer: c,
      token: "tok_4242",
    });
  return c;
}
async function mkPlan(bizId: string, slug: string, amt: number, kind: "plan" | "addon" = "plan") {
  const prod = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: slug,
    id: slug,
    kind,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: amt,
    interval: "month",
  });
  return { prod, price };
}
const freshSub = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1),
    )
  )[0]!;

// ── H1: reverted defaults — change_term_end WITHOUT prorate raises no invoice ──
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H1 defaults",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await mkPlan(biz.id, "h1plan", 10000);
  const c = await pmCustomer(biz.id, "h1@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const f = await freshSub(sub.id);
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: f,
    periodStart: f.currentPeriodStart!,
    periodEnd: f.currentPeriodEnd!,
  });
  const before = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
    )
  ).length;
  // Omit prorate → business default is now FALSE → no proration invoice generated.
  const r = await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    termEndsAt: new Date(f.currentPeriodEnd!.getTime() + 10 * 86400_000),
    now: new Date(),
  });
  const after = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
    )
  ).length;
  ok(
    "H1: default prorate=false → no proration invoice",
    r.prorationInvoice === null && after === before,
  );
}

// ── H2: change_term_end idempotency by TOKEN (not description) ─────────────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H2 token-idem",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await mkPlan(biz.id, "h2plan", 10000);
  const c = await pmCustomer(biz.id, "h2@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const f = await freshSub(sub.id);
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: f,
    periodStart: f.currentPeriodStart!,
    periodEnd: f.currentPeriodEnd!,
  });
  const s = await freshSub(sub.id);
  const newEnd = new Date(s.currentPeriodEnd!.getTime() + 10 * 86400_000);
  // prorateTermChange does NOT move the boundary — calling it twice with the SAME
  // token is exactly the crash-retry scenario. It must reuse the invoice.
  const inv1 = await prorateTermChange({
    organizationId: orgId,
    businessId: biz.id,
    subscription: s,
    oldPeriodEnd: s.currentPeriodEnd!,
    newPeriodEnd: newEnd,
    invoiceImmediately: false,
    now: new Date(),
    originToken: "op-A",
  });
  const inv1b = await prorateTermChange({
    organizationId: orgId,
    businessId: biz.id,
    subscription: s,
    oldPeriodEnd: s.currentPeriodEnd!,
    newPeriodEnd: newEnd,
    invoiceImmediately: false,
    now: new Date(),
    originToken: "op-A",
  });
  ok(
    "H2: same token reuses the extension invoice (idempotent retry)",
    !!inv1 && !!inv1b && inv1!.publicId === inv1b!.publicId,
  );
  // A genuinely-new operation (different token) → a fresh charge, NOT a false reuse.
  const inv2 = await prorateTermChange({
    organizationId: orgId,
    businessId: biz.id,
    subscription: s,
    oldPeriodEnd: s.currentPeriodEnd!,
    newPeriodEnd: newEnd,
    invoiceImmediately: false,
    now: new Date(),
    originToken: "op-B",
  });
  ok(
    "H2: different token raises a distinct extension invoice",
    !!inv2 && inv2!.publicId !== inv1!.publicId,
  );
  const extInvs = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.subscriptionId, sub.id), inArray(invoices.originToken, ["op-A", "op-B"])),
      ),
  );
  ok(
    "H2: exactly two token-stamped invoices exist (no third from the retry)",
    extInvs.length === 2,
  );
}

// ── H3: concurrent plan-swap that auto-includes a mandatory addon charges once ─
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H3 concurrent-mandatory",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: pA } = await mkPlan(biz.id, "h3a", 10000);
  const { price: pB } = await mkPlan(biz.id, "h3b", 12000);
  const { price: pAddon } = await mkPlan(biz.id, "h3addon", 2000, "addon");
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "h3addon",
    planPublicIds: ["h3b"],
    applicability: { h3b: "mandatory" },
  });
  const c = await pmCustomer(biz.id, "h3@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: pA, quantity: 1 }],
  });
  const planItem = items.find((i) => i.priceId === pA.id)!;
  // Fire two concurrent swaps A→B; both resolve the mandatory addon to insert.
  const settled = await Promise.allSettled([
    changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      changes: [{ itemId: planItem.publicId, newPriceId: pB.publicId }],
      invoiceImmediately: true,
    }),
    changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      changes: [{ itemId: planItem.publicId, newPriceId: pB.publicId }],
      invoiceImmediately: true,
    }),
  ]);
  // Exactly ONE of the two calls may bill. The other either loses the optimistic
  // lock (rejects with ProrationConflictError — nothing applied, nothing billed) or,
  // if it happened to run fully after the winner, re-reads the already-swapped state
  // and prorates to a no-op (fulfils with prorationInvoice === null). Both outcomes
  // are correct; TWO invoices never is.
  const billed = settled.filter(
    (r) => r.status === "fulfilled" && r.value.prorationInvoice !== null,
  );
  ok("H3: exactly one concurrent swap bills (loser conflicts or is a no-op)", billed.length === 1);
  const rejections = settled
    .filter((r) => r.status === "rejected")
    .map((r) => (r.reason as Error).name);
  ok(
    "H3: a losing concurrent swap fails loudly as a conflict (or not at all)",
    rejections.every((n) => n === "ProrationConflictError"),
  );
  const subInvoices = await withTenant(orgId, (tx) =>
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.subscriptionId, sub.id)),
  );
  ok(
    "H3: the concurrent swaps raised exactly ONE invoice (plan not double-charged)",
    subInvoices.length === 1,
  );
  const addonItems = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(
        and(eq(subscriptionItems.subscriptionId, sub.id), eq(subscriptionItems.priceId, pAddon.id)),
      ),
  );
  ok("H3: exactly ONE mandatory addon item after concurrent swaps", addonItems.length === 1);
  const addonLines = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(and(eq(invoices.subscriptionId, sub.id), eq(invoiceLineItems.priceId, pAddon.id))),
  );
  ok(
    "H3: mandatory addon proration charged exactly ONCE (no double-bill)",
    addonLines.length === 1,
  );
}

// ── H4: trigger_charge resolves an addon attached to a NON-first plan ──────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H4 multi-plan",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: p1 } = await mkPlan(biz.id, "h4one", 8000);
  const { price: p2 } = await mkPlan(biz.id, "h4two", 9000);
  await mkPlan(biz.id, "h4addon", 1500, "addon");
  // Addon attached on_demand to the SECOND plan only.
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "h4addon",
    planPublicIds: ["h4two"],
    applicability: { h4two: "optional" },
    config: { h4two: { chargeOnEvent: "on_demand" } },
  });
  const c = await pmCustomer(biz.id, "h4@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: p1, quantity: 1 },
      { price: p2, quantity: 1 },
    ],
  });
  const r = await triggerAttachedItemCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    itemPublicId: "h4addon",
    now: new Date(),
  });
  ok(
    "H4: trigger_charge succeeds on a multi-plan sub (addon on 2nd plan)",
    Number(r.invoice.totalMinor) === 1500,
  );
}

// ── H5: CN numbers unique + sample-data delete keyed on metadata + idempotent ──
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H5 cn-sample",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await mkPlan(biz.id, "h5plan", 5000);
  const c = await pmCustomer(biz.id, "h5@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const f = await freshSub(sub.id);
  const b1 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: f,
    periodStart: f.currentPeriodStart!,
    periodEnd: f.currentPeriodEnd!,
  });
  const g = await freshSub(sub.id);
  const b2 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: g,
    periodStart: g.currentPeriodEnd!,
    periodEnd: new Date(g.currentPeriodEnd!.getTime() + 30 * 86400_000),
  });
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: b1.invoice.publicId,
    items: [{ description: "r1", amountMinor: 1000 }],
    reasonCode: "other",
    reason: "t",
  });
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: b2.invoice.publicId,
    items: [{ description: "r2", amountMinor: 1000 }],
    reasonCode: "other",
    reason: "t",
  });
  const cns = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz.id)),
  );
  const nums = cns.map((x) => x.number);
  ok(
    "H5: every CN has a number",
    nums.every((n) => !!n),
  );
  ok("H5: CN numbers are unique", new Set(nums).size === nums.length);

  // sample-data: an untagged merchant coupon must survive a sample-data delete
  // (delete now keys off metadata.sample, not a hardcoded code).
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "REALPROMO",
    kind: "percentage",
    percentOffBps: 500,
    durationType: "once",
  });
  await createSampleData(orgId, biz.id);
  // Re-create is idempotent (no 409 on the fixed slug ids).
  let recreateThrew = false;
  try {
    await createSampleData(orgId, biz.id);
  } catch {
    recreateThrew = true;
  }
  ok("H5: sample-data re-create is idempotent (no throw)", !recreateThrew);
  const beforeDel = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, biz.id), eq(coupons.code, "SAMPLE10"))),
  );
  ok("H5: sample coupon SAMPLE10 exists after create", beforeDel.length === 1);
  await deleteSampleData(orgId, biz.id);
  const merchantCoupon = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, biz.id), eq(coupons.code, "REALPROMO"))),
  );
  ok("H5: untagged merchant coupon survives sample-data delete", merchantCoupon.length === 1);
  const sampleCoupon = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, biz.id), eq(coupons.code, "SAMPLE10"))),
  );
  ok("H5: sample coupon removed by delete (metadata-scoped)", sampleCoupon.length === 0);
  const sampleProducts = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, biz.id), eq(products.publicId, "sample-plan"))),
  );
  ok("H5: sample catalog removed by delete", sampleProducts.length === 0);
}

// ── H6: org-level audit list is mode-gated ────────────────────────────────────
{
  const liveBiz = await createBusiness({
    organizationId: orgId,
    name: "H6 live",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const testBiz = await createBusiness({
    organizationId: orgId,
    name: "H6 test",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Auditable action on each: cancel a subscription (writes subscription.cancel).
  for (const [b, tag] of [
    [liveBiz, "live"],
    [testBiz, "test"],
  ] as const) {
    const { price } = await mkPlan(b.id, `h6plan-${tag}`, 5000);
    // Only test-mode businesses auto-provision a tmtest gateway; a live business has
    // none, so skip vaulting (auto: 'off') — H6 just needs an auditable cancel, not
    // collection.
    const c = await pmCustomer(b.id, `h6-${tag}@a.com`, "off");
    const { subscription: sub } = await createSubscription({
      organizationId: orgId,
      businessId: b.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
    await cancelSubscriptionWithOptions({
      organizationId: orgId,
      businessId: b.id,
      subscriptionId: sub.id,
      cancelOption: "immediately",
      now: new Date(),
    });
  }
  const testView = await listAuditLogs(orgId, { action: "subscription.cancel", livemode: "test" });
  const liveView = await listAuditLogs(orgId, { action: "subscription.cancel", livemode: "live" });
  const allView = await listAuditLogs(orgId, { action: "subscription.cancel", livemode: "all" });
  const testHasLive = testView.some((r) => r.businessId === liveBiz.id);
  const testHasTest = testView.some((r) => r.businessId === testBiz.id);
  ok("H6: test-mode audit view excludes live-business rows", !testHasLive && testHasTest);
  ok(
    "H6: live-mode audit view excludes test-business rows",
    liveView.some((r) => r.businessId === liveBiz.id) &&
      !liveView.some((r) => r.businessId === testBiz.id),
  );
  ok(
    "H6: all-mode audit view sees both",
    allView.some((r) => r.businessId === liveBiz.id) &&
      allView.some((r) => r.businessId === testBiz.id),
  );
}

// ── H7: every cancel path writes an audit row (end_of_term) ────────────────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "H7 cancel-audit",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await mkPlan(biz.id, "h7plan", 5000);
  const c = await pmCustomer(biz.id, "h7@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    cancelOption: "end_of_term",
    now: new Date(),
  });
  const rows = await listAuditLogs(orgId, { businessId: biz.id, action: "subscription.cancel" });
  ok(
    "H7: end_of_term cancel wrote an audit row",
    rows.some((r) => r.resourceId === sub.publicId),
  );
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ HARDENING-H: PASS" : `❌ HARDENING-H: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
