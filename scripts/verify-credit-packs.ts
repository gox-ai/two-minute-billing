/**
 * Credit packs, manual paid grants and plan credits (design G3 §3.2, §3.6, §9 step 4):
 *  - a pack line sells a pending grant; it activates once, whichever path pays the invoice
 *    (offline payment, money balances at creation, credit on file, a card charge, the backstop);
 *  - activation books Dr credit_grants_pending / Cr credit_grants_paid at cost; pending closes to 0;
 *  - a pack invoice takes no promotional credit; top-up limits refuse at mint;
 *  - price rules: a paid pack needs a tax treatment; a custom unit is taxed at purchase;
 *  - a manual paid grant raises an invoice, stays pending, and with mark_paid is active at once;
 *    paid credit without an invoice fails the CHECK;
 *  - plan credits over 3 renewals for each rollover shape; a re-run of a period grants once.
 *
 *   pnpm verify:all:fresh -- --suite credit-packs
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { signup } from "@/modules/auth/service";
import { createBusiness } from "@/modules/tenancy/service";
import { CatalogError, createPrice, createProduct, updatePrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { addPromotionalCredits, recordExcessPayment } from "@/modules/customers/balances";
import { applyCreditOnFile } from "@/modules/customers/collect";
import { createCheckoutSession, CheckoutError } from "@/modules/checkout/service";
import { createCustomer } from "@/modules/customers/service";
import { createCreditUnit, grantRemaining } from "@/modules/credits/service";
import { activatePaidCreditGrants, runActivateCreditGrants } from "@/modules/credits/packs";
import { createManualPaidGrant } from "@/modules/credits/paid-grant";
import { applyPlanCredits } from "@/modules/credits/plan-credits";
import { runWithClockScope } from "@/platform/clock";
import { createPortalSession } from "@/modules/customer-portal/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { E12 } from "@/modules/credits/units";
import {
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantMovements,
  creditGrants,
  invoices,
  prices,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { checker, meterBusiness, newCustomer, setTerm, tick } from "./lib/meter-fixtures";

const { fails, check } = checker();
const { orgId, biz, ids, product } = await meterBusiness("Credit Packs Org");

await createCreditUnit({
  ...ids,
  key: "token",
  unit: { name: "token", pluralName: "tokens", currency: "USD", minorPerUnitE12: E12 / 10n },
});
// 0.1 minor unit per token: a 1,000-token pack is worth 100 and sells for 800.
// Packs are one-time charges: a purchase checkout refuses a plan's prices.
const packProduct = await createProduct({ ...ids, name: "Token packs", kind: "charge" });
let pn = 0;
const pack = (gc: Record<string, unknown>, amount = 800) =>
  createPrice({
    ...ids,
    productId: packProduct.id,
    id: `pack-${++pn}-${Date.now()}`,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: amount,
    grantsCredit: gc,
  });
const tokenPack = await pack({
  kind: "pack",
  unit: "token",
  amount: 1000,
  tax_treatment: "taxed_at_purchase",
});
const moneyPack = await pack(
  { kind: "pack", unit: null, amount: 1000, tax_treatment: "taxed_at_use" },
  1000,
);

const grantsOf = (invoiceId: string) =>
  systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, invoiceId));
async function accounts(customerId: string): Promise<Record<string, bigint>> {
  const rows = (await systemDb.execute(sql`
    select account, sum(case when direction = 'debit' then amount_minor else -amount_minor end)::text as net
    from ledger_entries where customer_id = ${customerId} group by account`)) as unknown as Array<{
    account: string;
    net: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.account, BigInt(r.net)]));
}
const packInvoice = (customerId: string, price = tokenPack, quantity = 1, collect = false) =>
  createManualInvoice({
    ...ids,
    customerId,
    currency: "USD",
    collect,
    lines: [
      {
        description: "Tokens",
        priceId: price.id,
        quantity,
        amountMinor: BigInt(price.amountMinor ?? 0) * BigInt(quantity),
        kind: "one_time",
      },
    ],
  });

// ── 1. A pack line sells a pending grant; each paying path activates it ──────────
console.log("1. activation at each paying path");
const c1 = await createCustomer({
  ...ids,
  email: `p1-${Date.now()}@example.com`,
  autoCollection: "off",
});
const inv1 = (await packInvoice(c1.id, tokenPack, 2)).invoice;
const [g1] = await grantsOf(inv1.id);
check(
  "an unpaid pack invoice holds a pending grant of 2 × 1,000 tokens",
  g1?.status === "pending" && g1.amount === 2000n && g1.costBasisMinor === 1600n,
  g1,
);
check(
  "the sale moves the cost into credit_grants_pending",
  -(await accounts(c1.id))[A.pending]! === 1600n,
);
await recordOfflinePayment({ ...ids, invoicePublicId: inv1.publicId, method: "wire" });
const [g1a] = await grantsOf(inv1.id);
check("offline payment (recordOfflinePayment) activates it", g1a?.status === "active", g1a?.status);
const a1 = await accounts(c1.id);
check(
  "activation: pending closes to 0, credit_grants_paid holds the cost",
  (a1[A.pending] ?? 0n) === 0n && -(a1[A.paid] ?? 0n) === 1600n,
  a1,
);
const left1 = (await withTenant(orgId, (tx) => grantRemaining(tx, [g1a!.id]))).get(g1a!.id)!;
check(
  "the activate movement carries the full lot (2,000 tokens, face 200, cost 1,600)",
  left1.units === 2000n && left1.face === 200n && left1.cost === 1600n,
  left1,
);
const again = await withTenant(orgId, (tx) =>
  activatePaidCreditGrants(tx, { organizationId: orgId, invoiceId: inv1.id }),
);
const moves = await systemDb
  .select()
  .from(creditGrantMovements)
  .where(and(eq(creditGrantMovements.grantId, g1a!.id), eq(creditGrantMovements.kind, "activate")));
check(
  "a second activation finds nothing: one activate movement",
  again === 0 && moves.length === 1,
  { again, n: moves.length },
);

const c2 = await createCustomer({
  ...ids,
  email: `p2-${Date.now()}@example.com`,
  autoCollection: "off",
});
await recordExcessPayment({ ...ids, customer: c2, amountMinor: 5000, currency: "USD" });
const inv2 = (await packInvoice(c2.id)).invoice;
const [g2] = await grantsOf(inv2.id);
check(
  "paid by excess at creation (createInvoiceFromLines) activates in the same call",
  inv2.status === "paid" && g2?.status === "active",
  { inv: inv2.status, g: g2?.status },
);

const c3 = await createCustomer({
  ...ids,
  email: `p3-${Date.now()}@example.com`,
  autoCollection: "off",
});
const inv3 = (await packInvoice(c3.id)).invoice;
await recordExcessPayment({ ...ids, customer: c3, amountMinor: 5000, currency: "USD" });
await applyCreditOnFile({ ...ids, invoice: inv3 });
const [g3] = await grantsOf(inv3.id);
check(
  "paid by credit on file (applyCreditOnFile) activates it",
  g3?.status === "active",
  g3?.status,
);

const c4 = await newCustomer(ids, "card");
const r4 = await packInvoice(c4.id, tokenPack, 1, true);
const [i4] = await systemDb.select().from(invoices).where(eq(invoices.id, r4.invoice.id));
const [g4] = await grantsOf(r4.invoice.id);
check(
  "paid by a card charge (collectInvoice) activates it",
  i4?.status === "paid" && g4?.status === "active",
  { inv: i4?.status, g: g4?.status },
);

const c5 = await createCustomer({
  ...ids,
  email: `p5-${Date.now()}@example.com`,
  autoCollection: "off",
});
const inv5 = (await packInvoice(c5.id)).invoice;
// A path that marks the invoice paid without activating: only the backstop pass catches it.
await systemDb
  .update(invoices)
  .set({ status: "paid", paidAt: new Date() })
  .where(eq(invoices.id, inv5.id));
const before5 = (await grantsOf(inv5.id))[0]?.status;
await runActivateCreditGrants();
const [g5] = await grantsOf(inv5.id);
check(
  "the activate_credit_grants pass activates a grant the paying path skipped",
  before5 === "pending" && g5?.status === "active",
  { before5, after: g5?.status },
);

// ── 2. Pack rules ────────────────────────────────────────────────────────────────
console.log("2. pack rules");
const c6 = await createCustomer({
  ...ids,
  email: `p6-${Date.now()}@example.com`,
  autoCollection: "off",
});
await addPromotionalCredits({ ...ids, customer: c6, amountMinor: 5000, currency: "USD" });
const inv6 = (await packInvoice(c6.id)).invoice;
check(
  "a pack invoice takes no promotional credit",
  inv6.promotionalCreditsAppliedMinor === 0n && inv6.amountDueMinor === 800n,
  {
    promo: inv6.promotionalCreditsAppliedMinor,
    due: inv6.amountDueMinor,
  },
);
const inv7 = (await packInvoice(c6.id, moneyPack)).invoice;
check(
  "a money pack taxed at use is zero-rated (no tax on the sale)",
  inv7.totalMinor === 1000n,
  inv7.totalMinor,
);
const noTreatment = await pack({ kind: "pack", unit: null, amount: 100 }).catch((e) => e);
check(
  "a paid pack price without a tax treatment is refused",
  noTreatment instanceof CatalogError && /tax treatment/.test(noTreatment.message),
  String(noTreatment),
);
const unitAtUse = await pack({
  kind: "pack",
  unit: "token",
  amount: 100,
  tax_treatment: "taxed_at_use",
}).catch((e) => e);
check(
  "custom unit + taxed_at_use is refused",
  unitAtUse instanceof CatalogError && /taxed at purchase/.test(unitAtUse.message),
  String(unitAtUse),
);
const recurringPack = await createPrice({
  ...ids,
  productId: product.id,
  id: `bad-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 100,
  interval: "month",
  grantsCredit: { kind: "pack", unit: null, amount: 100, tax_treatment: "taxed_at_purchase" },
}).catch((e) => e);
check("a pack on a recurring price is refused", recurringPack instanceof CatalogError);
// A one-time price of a plan is billed by a subscription; Buy cannot sell it.
const planOneTime = (gc?: Record<string, unknown>) =>
  createPrice({
    ...ids,
    productId: product.id,
    id: `plan-once-${++pn}-${Date.now()}`,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    ...(gc ? { grantsCredit: gc } : {}),
  });
const moneyGc = { kind: "pack", unit: null, amount: 2000, tax_treatment: "taxed_at_purchase" };
const planPack = await planOneTime(moneyGc).catch((e) => e);
check(
  "a pack on a plan's one-time price is refused at create",
  planPack instanceof CatalogError &&
    /one-time price of an add-on or a charge/.test(planPack.message),
  String(planPack),
);
const planPrice = await planOneTime();
const planPackEdit = await updatePrice({
  ...ids,
  pricePublicId: planPrice.publicId,
  grantsCredit: moneyGc,
}).catch((e) => e);
check(
  "a pack set on a plan's one-time price by update is refused",
  planPackEdit instanceof CatalogError &&
    /one-time price of an add-on or a charge/.test(planPackEdit.message),
  String(planPackEdit),
);
const recurringPrice = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `rec-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 100,
  interval: "month",
});
const recurringPackEdit = await updatePrice({
  ...ids,
  pricePublicId: recurringPrice.publicId,
  grantsCredit: moneyGc,
}).catch((e) => e);
check(
  "a pack set on a recurring price by update is refused",
  recurringPackEdit instanceof CatalogError && /one-time price/.test(recurringPackEdit.message),
  String(recurringPackEdit),
);
// The portal lists only packs Buy can sell: rows written before the check are skipped.
{
  await systemDb
    .update(prices)
    .set({ grantsCredit: { ...moneyGc, kind: "pack" } as never })
    .where(sql`${prices.id} in (${planPrice.id}, ${recurringPrice.id})`);
  const app = await buildApp({ logger: false });
  const link = await createPortalSession({ ...ids, customerId: c6.id });
  const sess = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  });
  const list = await app.inject({
    method: "GET",
    url: "/portal/v1/credits",
    headers: { authorization: `Bearer ${JSON.parse(sess.body).token}` },
  });
  const listed =
    list.statusCode === 200
      ? (JSON.parse(list.body).packs as { price: string; unit: string | null }[])
      : [];
  const has = (pid: string) => listed.some((p) => p.price === pid);
  check(
    "the portal lists one-time pack prices only (not a plan's, not a recurring one)",
    has(tokenPack.publicId) && !has(planPrice.publicId) && !has(recurringPrice.publicId),
    { status: list.statusCode, listed: listed.map((p) => p.price) },
  );
  const unitOf = (pid: string) => listed.find((p) => p.price === pid)?.unit;
  check(
    "a portal pack names its unit: token for a unit pack, null for a money pack",
    unitOf(tokenPack.publicId) === "token" && unitOf(moneyPack.publicId) === null,
    listed,
  );
  await systemDb
    .update(prices)
    .set({ grantsCredit: null })
    .where(sql`${prices.id} in (${planPrice.id}, ${recurringPrice.id})`);
  await app.close();
}
await systemDb
  .update(businesses)
  .set({ creditConfig: { top_up_limits: { USD: { min_minor: 1000, max_minor: 2000 } } } })
  .where(eq(businesses.id, biz.id));
const mint = (quantity: number) =>
  createCheckoutSession({
    ...ids,
    mode: "purchase",
    priceId: tokenPack.publicId,
    quantity,
    customerId: c6.publicId,
  }).catch((e) => e);
const low = await mint(1);
const high = await mint(3);
const inRange = await mint(2);
check(
  "top-up below the minimum is refused at mint",
  low instanceof CheckoutError && /between/.test(low.message),
  String(low),
);
check("top-up above the maximum is refused at mint", high instanceof CheckoutError, String(high));
check("top-up inside the limits mints", !(inRange instanceof Error), String(inRange));
await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, biz.id));

// ── 3. Manual paid grants (C4) ───────────────────────────────────────────────────
console.log("3. manual paid grants");
const m1 = await createCustomer({
  ...ids,
  email: `m1-${Date.now()}@example.com`,
  autoCollection: "off",
});
const unpaid = await createManualPaidGrant({
  ...ids,
  customerPublicId: m1.publicId,
  unitKey: "token",
  amount: 1000n,
  priceMinor: 80n,
  taxTreatment: "taxed_at_purchase",
});
const [mi1] = await systemDb
  .select()
  .from(invoices)
  .where(eq(invoices.publicId, unpaid.invoicePublicId));
check(
  "a manual paid grant raises an invoice and stays pending",
  unpaid.grant.status === "pending" && unpaid.grant.invoiceId === mi1?.id && mi1?.status !== "paid",
  {
    g: unpaid.grant.status,
    inv: mi1?.status,
  },
);
const paid = await createManualPaidGrant({
  ...ids,
  customerPublicId: m1.publicId,
  unitKey: "token",
  amount: 1000n,
  priceMinor: 80n,
  taxTreatment: "taxed_at_purchase",
  markPaid: { method: "bank_transfer", reference: "WIRE-0001" },
});
const [mi2] = await systemDb
  .select()
  .from(invoices)
  .where(eq(invoices.publicId, paid.invoicePublicId));
check(
  "with mark_paid the grant is active in the same call and the invoice is paid",
  paid.grant.status === "active" && mi2?.status === "paid",
  {
    g: paid.grant.status,
    inv: mi2?.status,
  },
);
const am = await accounts(m1.id);
check(
  "manual paid grants book like a pack: pending 80 (unpaid one), paid 80",
  -(am[A.pending] ?? 0n) === 80n && -(am[A.paid] ?? 0n) === 80n,
  am,
);
const direct = await systemDb
  .insert(creditGrants)
  .values({
    organizationId: orgId,
    businessId: biz.id,
    publicId: `cgr_direct_${Date.now()}`,
    customerId: m1.id,
    currency: "USD",
    amount: 100n,
    faceMinor: 100n,
    costBasisMinor: 100n,
    category: "paid",
    source: "manual",
    taxTreatment: "taxed_at_purchase",
  })
  .catch((e) => e);
check(
  "a direct insert of a paid grant without an invoice fails the CHECK",
  direct instanceof Error &&
    /credit_grants_paid_invoice_ck/.test(
      String((direct as { cause?: unknown }).cause ?? direct.message),
    ),
  String(direct),
);

// ── 4. Plan credits: rollover over 3 renewals per shape; a re-run grants once ────
console.log("4. plan credits");
const P = [1, 2, 3, 4, 5].map((m) => new Date(Date.UTC(2030, m - 1, 1)));
async function planCustomer(tag: string, gc: Record<string, unknown>) {
  const price = await createPrice({
    ...ids,
    productId: product.id,
    id: `plan-${tag}-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  // Set after the signup, so only the synthetic periods below grant.
  await updatePrice({ ...ids, pricePublicId: price.publicId, grantsCredit: gc });
  const [item] = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.subscription.id));
  const renew = (i: number) =>
    withTenant(orgId, (tx) =>
      applyPlanCredits(tx, {
        ...ids,
        subscription: { id: sub.subscription.id, customerId: c.id, currency: "USD" },
        periodStart: P[i]!,
        periodEnd: P[i + 1]!,
      }),
    );
  const live = async (at: Date) => {
    const gs = await systemDb
      .select()
      .from(creditGrants)
      .where(eq(creditGrants.subscriptionItemId, item!.id));
    const left = await withTenant(orgId, (tx) =>
      grantRemaining(
        tx,
        gs.map((g) => g.id),
      ),
    );
    return gs
      .filter(
        (g) => g.status === "active" && g.effectiveAt <= at && (!g.expiresAt || g.expiresAt > at),
      )
      .reduce((s, g) => s + left.get(g.id)!.units, 0n);
  };
  const grants = () =>
    systemDb.select().from(creditGrants).where(eq(creditGrants.subscriptionItemId, item!.id));
  return { c, renew, live, grants };
}
const base = { kind: "per_cycle", unit: null, amount: 100 };
const sA = await planCustomer("forever", {
  ...base,
  rollover: { mode: "carry", percent: 100, expire_after_cycles: null },
});
for (const i of [0, 1, 2]) await sA.renew(i);
check(
  "100% forever: after 3 cycles 300 left (two rolled grants + the new cycle)",
  (await sA.live(P[2]!)) === 300n,
  await sA.live(P[2]!),
);
const rolledA = (await sA.grants()).filter((g) => g.sourceRef?.includes(":rollover:"));
check(
  "a rolled grant never rolls again (each rolled grant keeps 100, none expired)",
  rolledA.length === 2 && rolledA.every((g) => g.status === "active" && g.expiresAt === null),
  rolledA.map((g) => [g.status, g.expiresAt]),
);

const sB = await planCustomer("capped", {
  ...base,
  rollover: { mode: "carry", percent: 50, cap: 30, expire_after_cycles: 1 },
});
for (const i of [0, 1, 2]) await sB.renew(i);
check(
  "50% capped at 30, kept 1 cycle: 100 + 30 after 3 cycles",
  (await sB.live(P[2]!)) === 130n,
  await sB.live(P[2]!),
);
const expiredB = (await sB.grants()).filter((g) => g.status === "expired");
check(
  "the closing cycles and the lapsed rolled grant are expired (3)",
  expiredB.length === 3,
  expiredB.map((g) => g.sourceRef),
);

const sC = await planCustomer("two", {
  ...base,
  rollover: { mode: "carry", percent: 100, expire_after_cycles: 2 },
});
for (const i of [0, 1, 2]) await sC.renew(i);
check(
  "carry kept 2 cycles: 300 live after 3 cycles",
  (await sC.live(P[2]!)) === 300n,
  await sC.live(P[2]!),
);
await sC.renew(3);
const firstRolled = (await sC.grants()).find((g) =>
  g.sourceRef?.endsWith(`:rollover:${P[1]!.toISOString()}`),
);
check(
  "…and the first rolled grant expires at the 4th renewal",
  firstRolled?.status === "expired" && (await sC.live(P[3]!)) === 300n,
  {
    status: firstRolled?.status,
    live: await sC.live(P[3]!),
  },
);

const sD = await planCustomer("none", { ...base });
await sD.renew(0);
await sD.renew(1);
check("rollover none: the closing cycle expires, 100 live", (await sD.live(P[1]!)) === 100n);
const rerun = await sD.renew(1);
check(
  "a re-run of the same renewal grants once",
  rerun.granted === 0 && (await sD.grants()).length === 2,
  { rerun, n: (await sD.grants()).length },
);
const promoNet = -((await accounts(sD.c.id))[A.promotional] ?? 0n);
check(
  "plan credit is promotional: credit_grants_promotional holds the live 100",
  promoNet === 100n,
  promoNet,
);

// A trialing subscription's first bill has no term (period columns null): it must bill and
// grant no plan credit, and the subscription's own term bills and grants once.
{
  const trialPrice = await createPrice({
    ...ids,
    productId: product.id,
    id: `plan-trial-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    trialPeriod: 14,
    trialPeriodUnit: "day",
    grantsCredit: { ...base },
  });
  const c = await newCustomer(ids, "trial-plan");
  const { subscription: tSub } = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price: trialPrice, quantity: 1 }],
  });
  const planGrants = () =>
    systemDb.select().from(creditGrants).where(eq(creditGrants.customerId, c.id));
  let err: unknown = null;
  try {
    await billSubscriptionPeriod({
      ...ids,
      subscription: tSub,
      periodStart: tSub.currentPeriodStart!,
      periodEnd: tSub.currentPeriodEnd!,
    });
  } catch (e) {
    err = e;
  }
  check(
    "a trialing first bill (no period) bills and grants no plan credit",
    tSub.currentPeriodStart === null && err === null && (await planGrants()).length === 0,
    { start: tSub.currentPeriodStart, err: String(err), n: (await planGrants()).length },
  );
}
{
  const ownPrice = await createPrice({
    ...ids,
    productId: product.id,
    id: `plan-own-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    grantsCredit: { ...base },
  });
  const c = await newCustomer(ids, "own-term");
  const planGrants = () =>
    systemDb.select().from(creditGrants).where(eq(creditGrants.customerId, c.id));
  const { subscription: oSub } = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price: ownPrice, quantity: 1 }],
  });
  const before = (await planGrants()).length;
  // The renewal bills the subscription's own term; a bill for another period does not grant.
  await setTerm(oSub.id, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 3_600_000));
  await tick(biz.id);
  const ownTerm = (await planGrants()).length - before;
  await billSubscriptionPeriod({
    ...ids,
    subscription: oSub,
    periodStart: P[0]!,
    periodEnd: P[1]!,
  });
  check(
    "plan credit grants on the subscription's own term invoice only",
    ownTerm === 1 && (await planGrants()).length === before + 1,
    { before, ownTerm, after: (await planGrants()).length },
  );
}

// Plan credits from signup: cycle 1 at signup (invoiced now or deferred), the first renewal
// rolls it over and grants cycle 2, and no cycle is granted twice. Own business: the renewal
// below runs a time-warped tick.
{
  const sb = await meterBusiness("Plan Credits Signup Org");
  const app = await buildApp({ logger: false });
  for (const invoiceNow of [true, false]) {
    const tag = invoiceNow ? "now" : "deferred";
    const price = await createPrice({
      ...sb.ids,
      productId: sb.product.id,
      id: `plan-signup-${tag}-${Date.now()}`,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 1000,
      interval: "month",
      grantsCredit: { ...base, rollover: { mode: "carry", percent: 100, expire_after_cycles: 1 } },
    });
    const c = await newCustomer(sb.ids, `signup-${tag}`);
    const res = await app.inject({
      method: "POST",
      url: `/v1/businesses/${sb.biz.publicId}/customers/${c.publicId}/subscriptions`,
      headers: {
        authorization: `Bearer ${sb.org.secret}`,
        "idempotency-key": `signup-${tag}-${Date.now()}`,
      },
      payload: { items: [{ price: price.publicId, quantity: 1 }], invoice_immediately: invoiceNow },
    });
    const grants = () =>
      systemDb.select().from(creditGrants).where(eq(creditGrants.customerId, c.id));
    const refs = async (kind: string) =>
      (await grants()).filter((g) => g.sourceRef?.includes(`:${kind}:`)).length;
    check(
      `signup (${tag}): the first cycle's credits are granted (1 cycle grant)`,
      res.statusCode === 201 && (await refs("cycle")) === 1,
      {
        status: res.statusCode,
        body: res.statusCode === 201 ? undefined : res.body,
        cycles: await refs("cycle"),
      },
    );
    const [sub] = await systemDb
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.customerId, c.id));
    const renewAt = new Date(sub!.currentPeriodEnd!.getTime() + 60 * 60_000);
    const renew = () =>
      runWithClockScope({ onlyBusinessId: sb.biz.id, now: renewAt }, () =>
        runBillingClockTick(renewAt),
      );
    await renew();
    await renew();
    const cycles = await refs("cycle");
    const rolled = await refs("rollover");
    const rerun = await withTenant(sb.orgId, (tx) =>
      applyPlanCredits(tx, {
        ...sb.ids,
        subscription: { id: sub!.id, customerId: c.id, currency: "USD" },
        periodStart: sub!.currentPeriodStart!,
        periodEnd: sub!.currentPeriodEnd!,
      }),
    );
    check(
      `signup (${tag}): renewal 1 rolls cycle 1 over and grants cycle 2; nothing is granted twice`,
      cycles === 2 && rolled === 1 && rerun.granted === 0 && (await refs("cycle")) === 2,
      { cycles, rolled, rerun },
    );
  }
  await app.close();
}

// ── 5. A paid manual grant needs invoices:manage as well as credits:manage ──────
console.log("5. permissions");
{
  const app = await buildApp({ logger: false });
  const uniq = Date.now().toString(36);
  const owner = await signup({
    email: `packs-owner-${uniq}@example.com`,
    password: "Correct-Horse-Battery-9",
    organizationName: `Packs perms ${uniq}`,
  });
  const permOrg = owner.user.organizationId;
  const permBiz = await createBusiness({
    organizationId: permOrg,
    name: "Perms",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const permCus = await createCustomer({
    organizationId: permOrg,
    businessId: permBiz.id,
    email: `pc-${uniq}@example.com`,
  });
  const mint = (permissions: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/v1/api_keys",
      headers: {
        cookie: `tmb_session=${owner.token}`,
        "idempotency-key": `k-${uniq}-${Object.keys(permissions).join("-")}`,
      },
      payload: { name: "credits", permissions },
    });
  const creditsOnly = JSON.parse((await mint({ credits: "write", customers: "read" })).body);
  const both = JSON.parse(
    (await mint({ credits: "write", invoices: "write", customers: "read" })).body,
  );
  const grantWith = (secret: string, key: string) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${permBiz.publicId}/customers/${permCus.publicId}/credit_grants`,
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": key },
      payload: {
        category: "paid",
        amount: 500,
        currency: "USD",
        price_minor: 500,
        tax_treatment: "taxed_at_purchase",
      },
    });
  const denied = await grantWith(creditsOnly.secret, `g1-${uniq}`);
  check(
    "credits:manage without invoices:manage → 403 on a paid manual grant",
    denied.statusCode === 403,
    denied.body,
  );
  const allowed = await grantWith(both.secret, `g2-${uniq}`);
  check(
    "with invoices:manage as well the paid grant is created (201)",
    allowed.statusCode === 201,
    allowed.body,
  );
  const promo = await app.inject({
    method: "POST",
    url: `/v1/businesses/${permBiz.publicId}/customers/${permCus.publicId}/credit_grants`,
    headers: { authorization: `Bearer ${creditsOnly.secret}`, "idempotency-key": `g3-${uniq}` },
    payload: { category: "promotional", amount: 500, currency: "USD" },
  });
  check(
    "credits:manage alone still gives promotional credit (201)",
    promo.statusCode === 201,
    promo.body,
  );
  await app.close();
}

await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDIT-PACKS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ CREDIT-PACKS: PASS");
process.exit(0);
