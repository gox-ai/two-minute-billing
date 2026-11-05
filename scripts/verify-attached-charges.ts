/**
 * Attached charges: a `charge` product attached to a plan, billed once at its event.
 *
 *  - attach rules: needs a one-time price; never `recommended`; always charge_once, no cycle cap
 *  - subscription_creation: on the first invoice, never a recurring item; the estimate agrees
 *  - on_demand: trigger_charge bills it, and only once
 *  - activation: fires once per subscription, however often activation runs
 *  - plan change: a signup charge on the new plan does NOT fire
 *
 *   pnpm verify:attached-charges
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  createProduct,
  createPrice,
  setItemApplicablePlans,
  listItemApplicablePlans,
  CatalogError,
} from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { triggerAttachedItemCharge, fireActivationCharges } from "@/modules/subscriptions/items";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateNewSubscription } from "@/modules/subscriptions/estimate";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { invoiceLineItems, invoices, subscriptions, subscriptionItems } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Attached Charges Org" });
const orgId = org.organization.id;

async function freshBiz(name: string) {
  return createBusiness({ organizationId: orgId, name, defaultCurrency: "USD", livemode: "test" });
}
async function plan(bizId: string, slug: string, amountMinor: number) {
  const prod = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: slug,
    id: slug,
    kind: "plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
  return { prod, price };
}
async function charge(
  bizId: string,
  slug: string,
  amountMinor: number | null,
  model: "flat" | "per_unit" = "flat",
) {
  const prod = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: slug,
    id: slug,
    kind: "charge",
  });
  const price =
    amountMinor == null
      ? null
      : await createPrice({
          organizationId: orgId,
          businessId: bizId,
          productId: prod.id,
          type: "one_time",
          model,
          currency: "USD",
          amountMinor,
        });
  return { prod, price };
}
async function customer(bizId: string, email: string) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer: c,
    token: "tok_4242",
  });
  return c;
}
async function billNow(bizId: string, subId: string) {
  const sub = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1))[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizId,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  return invoice;
}
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof CatalogError ? e.message : `unexpected: ${String(e)}`;
  }
}

// R: attach rules.
{
  const biz = await freshBiz("R rules");
  await plan(biz.id, "basic", 10000);
  await charge(biz.id, "unpriced", null);
  await charge(biz.id, "setup", 5000);

  const noPrice = await refusal(() =>
    setItemApplicablePlans({
      organizationId: orgId,
      businessId: biz.id,
      itemPublicId: "unpriced",
      planPublicIds: ["basic"],
    }),
  );
  ok(
    "R1: a charge with no one-time price is refused",
    noPrice?.includes("one-time price") ?? false,
  );

  const recommended = await refusal(() =>
    setItemApplicablePlans({
      organizationId: orgId,
      businessId: biz.id,
      itemPublicId: "setup",
      planPublicIds: ["basic"],
      applicability: { basic: "recommended" },
    }),
  );
  ok("R2: a charge cannot be recommended", recommended?.includes("not as recommended") ?? false);

  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "setup",
    planPublicIds: ["basic"],
    applicability: { basic: "mandatory" },
    config: { basic: { chargeOnce: false, billingCycles: 3 } },
  });
  const links = await listItemApplicablePlans(orgId, biz.id, "setup");
  ok("R3: a charge is stored charge_once", links?.config.basic?.chargeOnce === true);
  ok("R4: a charge is never cycle-capped", links?.config.basic?.billingCycles === null);
}

// C: a mandatory subscription_creation charge lands on the first invoice once.
{
  const biz = await freshBiz("C creation");
  const { price: planPrice } = await plan(biz.id, "basic", 10000);
  const { price: setupPrice } = await charge(biz.id, "setup", 5000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "setup",
    planPublicIds: ["basic"],
    applicability: { basic: "mandatory" },
  });
  const c = await customer(biz.id, "c@example.com");
  const est = await estimateNewSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    items: [{ price: planPrice, quantity: 1 }],
    now: new Date(),
  });
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("C1: the charge is not a recurring subscription item", items.length === 1);
  const inv = await billNow(biz.id, sub.id);
  ok("C2: first invoice = plan 10000 + charge 5000", Number(inv.totalMinor) === 15000);
  ok("C3: the estimate agrees with the invoice (15000)", est.subtotal_minor === 15000);
  const chargeLines = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(eq(invoices.subscriptionId, sub.id)),
  );
  ok(
    "C4: the charge appears on exactly one invoice line",
    chargeLines.filter((r) => r.invoice_line_items.description?.includes(setupPrice!.publicId))
      .length === 1,
  );
}

// D: an on_demand charge bills when triggered, and only once.
{
  const biz = await freshBiz("D on_demand");
  const { price: planPrice } = await plan(biz.id, "basic", 10000);
  await charge(biz.id, "onboarding", 2500, "per_unit");
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "onboarding",
    planPublicIds: ["basic"],
    applicability: { basic: "optional" },
    config: { basic: { chargeOnEvent: "on_demand" } },
  });
  const c = await customer(biz.id, "d@example.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("D1: an on_demand charge is not auto-included", items.length === 1);
  const { invoice } = await triggerAttachedItemCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    itemPublicId: "onboarding",
    quantity: 2,
    now: new Date(),
  });
  ok("D2: trigger_charge bills 2 × 2500 = 5000", Number(invoice.totalMinor) === 5000);
  let second: string | null = null;
  try {
    await triggerAttachedItemCharge({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      itemPublicId: "onboarding",
      now: new Date(),
    });
  } catch (e) {
    second = String((e as Error).message);
  }
  ok(
    "D3: a second trigger is refused (charged once)",
    second?.includes("already has a charge for it") ?? false,
  );
}

// A: an activation charge fires once, however often activation runs.
{
  const biz = await freshBiz("A activation");
  const { price: planPrice } = await plan(biz.id, "basic", 10000);
  const { price: kickoffPrice } = await charge(biz.id, "kickoff", 4000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "kickoff",
    planPublicIds: ["basic"],
    applicability: { basic: "mandatory" },
    config: { basic: { chargeOnEvent: "activation" } },
  });
  const c = await customer(biz.id, "a@example.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const fire = () =>
    fireActivationCharges({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
    });
  // Creating an active subscription may already have fired it; either way it bills once.
  await fire();
  const again = await fire();
  const kickoffLines = await withTenant(orgId, (tx) =>
    tx
      .select({ description: invoiceLineItems.description })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(eq(invoices.subscriptionId, sub.id)),
  );
  ok(
    "A1: the activation charge is billed exactly once",
    kickoffLines.filter((l) => l.description?.includes(kickoffPrice!.publicId)).length === 1,
  );
  ok("A2: a repeated activation raises nothing", again === 0);
}

// P: switching to a plan with a signup charge does not bill that charge.
{
  const biz = await freshBiz("P plan change");
  const { price: p1 } = await plan(biz.id, "starter", 10000);
  const { price: p2 } = await plan(biz.id, "pro", 20000);
  const { price: setupPrice } = await charge(biz.id, "pro-setup", 9000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "pro-setup",
    planPublicIds: ["pro"],
    applicability: { pro: "mandatory" },
  });
  const c = await customer(biz.id, "p@example.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p1, quantity: 1 }],
  });
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    changes: [{ itemId: items[0]!.publicId, newPriceId: p2.publicId }],
  });
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
  );
  const setupLines = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(
        and(eq(invoices.subscriptionId, sub.id), eq(invoiceLineItems.priceId, setupPrice!.id)),
      ),
  );
  ok("P1: the plan change adds no item for the charge", after.length === 1);
  ok("P2: the signup charge is not billed on a plan change", setupLines.length === 0);
}

// ── Report ──────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ ATTACHED CHARGES: PASS" : "❌ ATTACHED CHARGES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
