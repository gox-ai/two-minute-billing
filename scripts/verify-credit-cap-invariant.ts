/**
 * FALSIFICATION TEST for the M1 credit-capacity clamp.
 *
 * Constructs an over-crediting ATTEMPT rather than re-counting history: the 52 existing
 * rows are history and survive any fix, so a re-count cannot tell a pass from a failure.
 *
 * Shape distilled from sub_XXXXXXXXXXXXXXXXXXXXXX01: chain plan changes so that each new
 * invoice is funded by the previous change's credit note (giving it a non-zero
 * refundable_credits_applied_minor, which is what feeds `recycled`), then force a TERM
 * RESET so issueCurrentTermCredit credits every live invoice at once — including ones
 * already credited in full.
 *
 * Asserts the agreed predicate:
 *   with c as (select invoice_id, sum(total_minor) cum from credit_notes
 *              where status <> 'voided' group by invoice_id)
 *   select ... from c join invoices i on i.id = c.invoice_id where c.cum > i.total_minor
 *
 * MUST REPRODUCE (exit 1) on unclamped code, or it is not a test of anything.
 *
 * ⚠️ AND IT IS ONE-DIRECTIONAL. READ ITS GREEN NARROWLY.
 *
 * This asserts only that nobody is credited PAST their cap. A ceiling that is too LOW
 * satisfies it perfectly — so a green run says the clamp closed the over-credit hole and
 * says NOTHING about whether the credit is the right number.
 *
 * That is not hypothetical. On 2026-09-01 this file was green, `verify:all`'s 136 steps
 * were green, and ten money suites were green, while `preTaxCreditFitting` was
 * UNDER-crediting and the difference was being collected from a card (491 minor units
 * over-charged on one six-step scenario). A ceiling check cannot catch that on its own,
 * because it never asks what the number should BE.
 *
 * So: this file guards the ceiling, and the end-to-end money suites guard the value. A
 * change to credit arithmetic needs BOTH, and neither substitutes for the other.
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { withTenant, systemDb, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { configureIndiaGst } from "@/modules/tax/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { collectPayment } from "@/modules/customers/collect";
import { subscriptionItems } from "@db/schema";

const M = (m: any) => (Number(m) / 100).toFixed(2).padStart(12);

async function main() {
  await loadGeoReference();
  const org = await createOrganization({ name: "m1 clamp falsification" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Clamp Test",
    defaultCurrency: "INR",
    livemode: "test",
    timezone: "Asia/Kolkata",
    anchorGranularity: "day",
    prorationGranularity: "whole_day",
  });
  await configureIndiaGst({
    organizationId: orgId,
    businessId: biz.id,
    country: "IN",
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
    priceType: "exclusive",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "clamp@example.com",
    address: {
      line1: "1 St",
      city: "Chennai",
      state: "TN",
      stateCode: "TN",
      postalCode: "600001",
      country: "IN",
    },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });

  const prod = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Platform",
    kind: "plan",
  });
  const mk = (amt: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "INR",
      amountMinor: amt,
      interval: "month",
    });
  const PRO = await mk(2791800),
    BUSINESS = await mk(5611800),
    LITE = await mk(911800);

  const ctx = { organizationId: orgId, businessId: biz.id };
  const termStart = new Date("2026-08-30T18:30:00.000Z");
  const created = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: termStart,
    items: [{ price: PRO, quantity: 1 }],
  });
  const sub = created.subscription;
  await billSubscriptionPeriod({
    ...ctx,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  await collectPayment({ ...ctx, customerPublicId: customer.publicId });

  const step = async (label: string, to: any, at: string, resetTerm = false) => {
    const [item] = await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
    );
    await changeSubscription({
      ...ctx,
      subscriptionId: sub.id,
      now: new Date(`2026-08-31T${at}:00.000Z`),
      changes: [{ itemId: item!.publicId, newPriceId: to.publicId }],
      invoiceImmediately: true,
      ...(resetTerm ? { resetTerm: true } : {}),
    });
    console.log(`  ${at}  ${label}${resetTerm ? "  [TERM RESET]" : ""}`);
  };

  console.log("building the chain (each invoice funded by the previous change's credit note):");
  await step("PRO -> BUSINESS", BUSINESS, "12:16");
  await step("BUSINESS -> PRO", PRO, "12:22");
  await step("PRO -> BUSINESS", BUSINESS, "17:59");
  await step("BUSINESS -> PRO", PRO, "18:36");
  await step("PRO -> LITE", LITE, "19:11");
  await step("LITE -> BUSINESS", BUSINESS, "19:13");
  await step("BUSINESS -> PRO (reset)", PRO, "19:19", true);
  await step("PRO -> LITE (reset)", LITE, "22:08", true);

  const bad = (await systemDb.execute(sql`
    with c as (select cn.invoice_id, sum(cn.total_minor) cum, count(*) k
               from credit_notes cn where cn.status <> 'voided' group by cn.invoice_id)
    select i.number, i.total_minor, c.cum, c.k
    from c join invoices i on i.id = c.invoice_id
    where i.business_id = ${biz.id} and c.cum > i.total_minor
    order by i.created_at`)) as unknown as any[];

  console.log(`\n=== agreed predicate, this business only ===`);
  if (!bad.length) {
    console.log("  no invoice over its cap");
  } else {
    for (const r of bad)
      console.log(
        `  ${String(r.number).padEnd(9)} total ${M(r.total_minor)} cumulative CN ${M(r.cum)} OVER by ${M(Number(r.cum) - Number(r.total_minor))} (${r.k} notes)`,
      );
  }
  const excess = bad.reduce((s: number, r: any) => s + (Number(r.cum) - Number(r.total_minor)), 0);
  console.log(`\n  ${bad.length} invoice(s) over cap, excess ${M(excess)}`);
  console.log(
    bad.length
      ? "\n🔴 OVER-CREDIT REPRODUCED — the test can fail, so a later pass is meaningful."
      : "\n✅ no over-credit — on UNCLAMPED code this means the test does not exercise M1 and proves nothing.",
  );
  await closeDb();
  process.exit(bad.length ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
