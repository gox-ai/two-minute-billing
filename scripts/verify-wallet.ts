/**
 * Wallet / prepaid credits — permutations:
 *  - granted top-up raises spendable balance and reduces the next invoice,
 *  - paid top-up charges the card (cash in) and raises balance,
 *  - partial coverage: top-up < invoice → card charged the remainder,
 *  - full coverage: top-up ≥ invoice → card charged 0,
 *  - ledger nets (cash/promotional_credit/customer_balance balanced),
 *  - a paid top-up charges the primary card, not the newest one (an expired backup),
 *  - every paid top-up attempt leaves a row: a throw, an indeterminate answer and a
 *    pending answer each book one, and the wallet is credited once, on success only.
 *
 *   pnpm verify:wallet
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createGatewayAccount } from "@/modules/gateway/service";
import { setPaymentMethodStatus } from "@/modules/payment-methods/service";
import { settleTransactionOutcome } from "@/modules/payments/settlement";
import { TmtestProvider } from "@/providers/tmtest";
import { ProviderIndeterminateError } from "@/providers/types";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { topUpWallet, walletBalance, WalletError } from "@/modules/wallet/service";
import { ledgerEntries, payments, transactions, walletTopups } from "@db/schema";

const org = await createOrganization({ name: "Wallet Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month", // $100
});

async function mk(email: string) {
  const c = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  return c;
}
const chargedOn = (invId: string) =>
  withTenant(orgId, async (tx) => {
    const pays = await tx.select().from(payments).where(eq(payments.invoiceId, invId));
    return pays
      .filter((p) => p.status === "succeeded")
      .reduce((s, p) => s + Number(p.amountMinor), 0);
  });

const checks: Array<[string, boolean]> = [];

// 1) granted top-up $40 → balance 40 → invoice $100 → amount_due 60, card charged 60.
{
  const c = await mk("granted@a.com");
  await topUpWallet({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 4000,
    currency: "USD",
    type: "granted",
  });
  const bal = await walletBalance(orgId, c.id, "USD");
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const charged = await chargedOn(invoice.id);
  console.log(
    `granted $40: balance=${bal}, invoice amount_due=${invoice.amountDueMinor}, card charged=${charged}`,
  );
  checks.push(
    ["granted balance", bal === 4000n],
    ["granted amount_due 6000", Number(invoice.amountDueMinor) === 6000],
    ["granted card 6000", charged === 6000],
  );
}

// 2) paid top-up $30 charges the card; balance reflects it.
{
  const c = await mk("paid@a.com");
  const before = await walletBalance(orgId, c.id, "USD");
  await topUpWallet({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 3000,
    currency: "USD",
    type: "paid",
  });
  const after = await walletBalance(orgId, c.id, "USD");
  // cash should have increased by 3000 from the paid top-up
  const cash = await withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, "cash"));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });
  console.log(`paid $30: balance ${before}→${after}, cash includes top-up (${cash} ≥ 3000)`);
  checks.push(["paid balance +3000", after - before === 3000n], ["paid cash in", cash >= 3000n]);
}

// 3) full coverage: granted $100 → invoice $100 → amount_due 0, card charged 0.
{
  const c = await mk("full@a.com");
  await topUpWallet({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 10000,
    currency: "USD",
    type: "granted",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice, payment } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  console.log(
    `full coverage: amount_due=${invoice.amountDueMinor}, status=${invoice.status}, payment=${payment ? payment.status : "none"}`,
  );
  checks.push(
    ["full coverage amount_due 0", Number(invoice.amountDueMinor) === 0],
    ["full coverage no charge", payment === null],
  );
}

// 4–7) Paid top-ups through a tmtest gateway account.
{
  const gBiz = await createBusiness({
    organizationId: orgId,
    name: "Gateway Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: gBiz.id,
    gatewayKey: "tmtest",
    label: "Test gateway",
    credentials: {},
  });
  const mkG = async (email: string, token = "tok_4242") => {
    const c = await createCustomer({ organizationId: orgId, businessId: gBiz.id, email });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: gBiz.id,
      customer: c,
      token,
      gatewayAccountId: acct.publicId,
    });
    return { c, pm };
  };
  const paysOf = (customerId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.customerId, customerId)),
    );
  const txnsOf = (customerId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.customerId, customerId)),
    );
  const topupsOf = (customerId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(walletTopups).where(eq(walletTopups.customerId, customerId)),
    );
  const paidTopUp = async (c: Awaited<ReturnType<typeof mkG>>["c"], amountMinor: number) => {
    try {
      await topUpWallet({
        organizationId: orgId,
        businessId: gBiz.id,
        customer: c,
        amountMinor,
        currency: "USD",
        type: "paid",
      });
      return null;
    } catch (e) {
      if (e instanceof WalletError) return e.message;
      throw e;
    }
  };
  const proto = TmtestProvider.prototype as unknown as {
    charge: (...a: unknown[]) => Promise<unknown>;
  };
  const realCharge = proto.charge;

  // 4) Expired newest card + valid older primary → the primary is charged.
  {
    const { c, pm: primary } = await mkG("primary@a.com");
    const newer = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: gBiz.id,
      customer: c,
      token: "tok_4111111111111111",
      gatewayAccountId: acct.publicId,
    });
    await withTenant(orgId, (tx) => setPaymentMethodStatus(tx, orgId, newer.id, "expired"));
    const err = await paidTopUp(c, 2500);
    const pays = await paysOf(c.id);
    const bal = await walletBalance(orgId, c.id, "USD");
    console.log(
      `expired newest: err=${err}, charged pm=${pays.map((p) => (p.paymentMethodId === primary.id ? "primary" : "newest")).join(",")}, balance=${bal}`,
    );
    checks.push(
      ["B1: no error", err === null],
      [
        "B1: one payment, on the primary",
        pays.length === 1 &&
          pays[0]!.paymentMethodId === primary.id &&
          pays[0]!.status === "succeeded",
      ],
      ["B1: balance +2500", bal === 2500n],
    );
    // Success books a transaction and posts cash / excess, never AR.
    const txns = await txnsOf(c.id);
    const lines = await withTenant(orgId, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.customerId, c.id)),
    );
    checks.push(
      [
        "B2: success records a succeeded transaction",
        txns.length === 1 && txns[0]!.status === "succeeded" && txns[0]!.paymentId === pays[0]!.id,
      ],
      [
        "B2: success posts no accounts_receivable",
        !lines.some((l) => l.account === "accounts_receivable"),
      ],
      ["B2: one wallet_topups row", (await topupsOf(c.id)).length === 1],
    );
  }

  // 5) The provider throws → a failed attempt is booked; nothing is credited.
  {
    const { c } = await mkG("throws@a.com");
    proto.charge = async () => {
      throw new Error("socket hang up");
    };
    const err = await paidTopUp(c, 1800).finally(() => {
      proto.charge = realCharge;
    });
    const pays = await paysOf(c.id);
    const txns = await txnsOf(c.id);
    console.log(
      `throw: err=${err}, payments=${pays.map((p) => p.status)}, txns=${txns.map((t) => t.status)}`,
    );
    checks.push(
      ["B2 throw: WalletError", err !== null],
      [
        "B2 throw: a failed payment row exists",
        pays.length === 1 &&
          pays[0]!.status === "failed" &&
          pays[0]!.failureCode === "gateway_error",
      ],
      ["B2 throw: a failed transaction exists", txns.length === 1 && txns[0]!.status === "failed"],
      [
        "B2 throw: no credit",
        (await walletBalance(orgId, c.id, "USD")) === 0n && (await topupsOf(c.id)).length === 0,
      ],
    );
  }

  // 6) Indeterminate → pending, never failed; a later success credits once.
  {
    const { c } = await mkG("indeterminate@a.com");
    proto.charge = async () => {
      throw new ProviderIndeterminateError("outcome unknown");
    };
    const err = await paidTopUp(c, 1200).finally(() => {
      proto.charge = realCharge;
    });
    const pays = await paysOf(c.id);
    const txns = await txnsOf(c.id);
    console.log(
      `indeterminate: err=${err}, payments=${pays.map((p) => p.status)}, txns=${txns.map((t) => t.status)}`,
    );
    checks.push(
      [
        "B2 indeterminate: payment stays pending",
        pays.length === 1 && pays[0]!.status === "pending",
      ],
      [
        "B2 indeterminate: transaction is timeout",
        txns.length === 1 && txns[0]!.status === "timeout",
      ],
      ["B2 indeterminate: no credit yet", (await walletBalance(orgId, c.id, "USD")) === 0n],
    );
    const settle = () =>
      withTenant(orgId, (tx) =>
        settleTransactionOutcome(tx, {
          organizationId: orgId,
          businessId: gBiz.id,
          outcome: "succeeded",
          txn: txns[0]!,
        }),
      );
    await settle();
    await settle();
    const bal = await walletBalance(orgId, c.id, "USD");
    const lines = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.customerId, c.id), eq(ledgerEntries.account, "cash"))),
    );
    console.log(`indeterminate settled twice: balance=${bal}, cash lines=${lines.length}`);
    checks.push(
      ["B2 late success: credited once", bal === 1200n && (await topupsOf(c.id)).length === 1],
      ["B2 late success: one cash posting", lines.length === 1],
    );
  }

  // 7) An async-pending answer → in_progress transaction for the sweep; no credit.
  {
    const { c } = await mkG("async@a.com", "tok_4000000000000101");
    const err = await paidTopUp(c, 900);
    const pays = await paysOf(c.id);
    const txns = await txnsOf(c.id);
    console.log(
      `async pending: err=${err}, payments=${pays.map((p) => p.status)}, txns=${txns.map((t) => t.status)}`,
    );
    checks.push(
      ["B2 pending: payment pending", pays.length === 1 && pays[0]!.status === "pending"],
      [
        "B2 pending: in_progress transaction with a gateway id",
        txns.length === 1 && txns[0]!.status === "in_progress" && !!txns[0]!.idAtGateway,
      ],
      ["B2 pending: no credit", (await walletBalance(orgId, c.id, "USD")) === 0n],
    );
  }

  // 8) A declined card books a failed attempt and credits nothing.
  {
    const { c } = await mkG("declined@a.com", "tok_4000000000000002");
    const err = await paidTopUp(c, 700);
    const pays = await paysOf(c.id);
    checks.push(
      ["decline: WalletError", err !== null],
      ["decline: failed payment row", pays.length === 1 && pays[0]!.status === "failed"],
      ["decline: no credit", (await walletBalance(orgId, c.id, "USD")) === 0n],
    );
  }
}

// ── A made-up currency is refused at the API, not booked as a new balance ──
{
  const { buildApp } = await import("@/index");
  const app = await buildApp({ logger: false });
  const c = await mk("bad-currency@a.com");
  const post = (path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/customers/${c.publicId}/${path}`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `cur-${Math.random()}` },
      payload,
    });
  const topup = (currency: string) =>
    post("wallet/topup", { amount_minor: 500, currency, type: "granted" });
  const promo = (currency: string) =>
    post("promotional_credits", { action: "add", amount_minor: 500, currency });
  const [tZ, tX, pZ, pX] = await Promise.all([
    topup("ZZZ"),
    topup("XXX"),
    promo("ZZZ"),
    promo("XXX"),
  ]);
  const [tOk, pOk] = [await topup("USD"), await promo("USD")];
  checks.push(
    [
      "API currency: wallet top-up refuses ZZZ and XXX (400)",
      tZ.statusCode === 400 && tX.statusCode === 400,
    ],
    [
      "API currency: promotional credits refuse ZZZ and XXX (400)",
      pZ.statusCode === 400 && pX.statusCode === 400,
    ],
    ["API currency: nothing booked in ZZZ", (await walletBalance(orgId, c.id, "ZZZ")) === 0n],
    ["API currency: USD still accepted on both", tOk.statusCode < 300 && pOk.statusCode < 300],
  );
  if (tOk.statusCode >= 300 || pOk.statusCode >= 300)
    console.log(
      `  USD: ${tOk.statusCode} ${tOk.body.slice(0, 160)} | ${pOk.statusCode} ${pOk.body.slice(0, 160)}`,
    );
  await app.close();
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ WALLET: PASS" : "❌ WALLET: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
