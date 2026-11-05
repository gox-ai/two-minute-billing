/**
 * RazorPay at REAL PLAN PRICES — netbanking, UPI and card, pay-now and auto-collect.
 *
 * `verify:razorpay-live` proves the off-session money path works; it does so at ₹1
 * and ₹50. That is the right amount for proving a *mechanism* and the wrong amount
 * for answering "can we actually bill the Pro plan?", because every ceiling that
 * decides the answer sits far above ₹50:
 *
 *   RBI card e-mandate AFA exemption      ₹15,000 per debit
 *   NPCI UPI Autopay mandate ceiling      ₹1,00,000 (this MCC)
 *   RazorPay mandate `max_amount` cap     ₹10,00,000
 *
 * So a rail that passes at ₹50 tells you nothing about the same rail at ₹56,118. This
 * suite runs the two prices that matter — Pro monthly and Pro annual — across all
 * three INR rails, on BOTH paths (buyer-present "pay now" and off-session
 * auto-collect), and reports a verdict per rail × amount × path.
 *
 * The two amounts are deliberately in DIFFERENT BANDS:
 *   ₹56,118    — above the RBI ₹15,000 AFA line, below the UPI ₹1,00,000 ceiling
 *   ₹5,61,180  — above the UPI ceiling too, below RazorPay's ₹10,00,000 cap
 * which is what makes the pair diagnostic rather than two samples of one case.
 *
 * ## What this suite can and cannot drive
 *
 * All three rails run UNATTENDED, including netbanking — see `emandateRegister` in
 * `lib/razorpay-checkout.ts`, which registers an e-mandate without a browser and so
 * retires the "netbanking registration is browser-only" limitation the older suites
 * were built around.
 *
 * Nothing here reports a rail as proven on registration alone: all three rails have
 * looked like success at registration while the money could not move, so every rail is
 * asserted on the DEBIT, and mandates are asserted on `recurring_details.status`
 * rather than on a token id existing.
 *
 *   pnpm verify:razorpay-pro-amounts
 *   RZP_PRO_MONTHLY_MINOR=… RZP_PRO_ANNUAL_MINOR=… pnpm verify:razorpay-pro-amounts
 *   RZP_SETTLE_WAIT_MS=300000 pnpm verify:razorpay-pro-amounts   (wait longer to settle)
 *
 * ⚠️ Makes REAL API calls (test mode only — non-test keys are refused). Not part of
 * `verify:all`. Test-mode money, but the AMOUNTS ARE REAL: this suite moves ₹56,118
 * and ₹5,61,180 per rail. That is the entire point and it is why it is opt-in.
 */
import "dotenv/config";
import { config } from "@/platform/config";
import { RazorpayProvider } from "@/providers/razorpay";
import { closeDb } from "@/platform/db";
import type { ProviderCustomerRef, ProviderPaymentMethodRef } from "@/providers/types";
import {
  TEST_CARDS,
  basicAuth,
  cardCapture,
  cardMandateAuthorize,
  netbankingCapture,
  readOrderMaxAmount,
  readTokenMaxAmount,
  readTokenRecurringState,
  readInvoiceOrderId,
  emandateRegister,
  accountMethods,
  netbankingPayNowBanks,
  upiCollectCapture,
  probeOrderAmount,
  GatewayRefusalError,
  sleep,
  type RailContext,
} from "./lib/razorpay-checkout";

const checks: [string, boolean][] = [];
const warns: string[] = [];
const ok = (n: string, c: boolean) => {
  checks.push([n, c]);
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
};
const warn = (n: string) => {
  warns.push(n);
  console.log(`  ⚠️  ${n}`);
};

if (!config.RAZORPAY_TEST_KEY_ID || !config.RAZORPAY_TEST_KEY_SECRET) {
  console.log("SKIP: RazorPay test keys not set (RAZORPAY_TEST_KEY_ID/SECRET)");
  process.exit(0);
}
// Never let this suite touch real money — it moves plan-sized amounts.
if (!config.RAZORPAY_TEST_KEY_ID.startsWith("rzp_test")) {
  console.error("REFUSING: RAZORPAY_TEST_KEY_ID is not a test key (must start with rzp_test)");
  process.exit(1);
}

/**
 * The prices under test, in paise. Defaults are a Pro plan
 * (`RAZORPAY REPORT.md` §2) — override when the catalog moves, since the *band* a
 * price falls in is what decides each rail's answer.
 */
const AMOUNTS = [
  {
    key: "monthly",
    label: "Pro monthly ₹56,118",
    minor: BigInt(process.env.RZP_PRO_MONTHLY_MINOR ?? 5_611_800),
  },
  {
    key: "annual",
    label: "Pro annual ₹5,61,180",
    minor: BigInt(process.env.RZP_PRO_ANNUAL_MINOR ?? 56_118_000),
  },
] as const;

/** The ceilings this suite is built to straddle, in paise. */
const RBI_AFA_EXEMPT_CEILING = 1_500_000n; // ₹15,000 — card e-mandate, off-session
const UPI_AUTOPAY_CEILING = 10_000_000n; // ₹1,00,000 — NPCI, this merchant category
const RZP_MANDATE_CAP = 100_000_000n; // ₹10,00,000 — RazorPay API limit on max_amount
/**
 * This MERCHANT's maximum single payment, in paise — ₹5,00,000, measured by bisecting
 * order creation on the test key (2026-08-19). Not an RBI or NPCI rule: a per-account
 * RazorPay setting, raised by support. It sits BELOW the annual Pro price, which is why
 * it, and not any rail limit, is what blocks annual billing today.
 */
const ACCOUNT_MAX_PAYMENT = 50_000_000n;

/**
 * Settlement budget. 120s is NOT enough: a UPI Autopay debit of ₹56,118 was measured
 * capturing between 2 and 5 minutes after acceptance (twice), so a shorter budget
 * reported the one rail that works as "not measured". The card rail is the opposite
 * case — it stays `created` indefinitely (measured across two runs, >30 min), so a
 * longer budget does not launder its stall into a pass.
 */
const SETTLE_WAIT_MS = Number(process.env.RZP_SETTLE_WAIT_MS ?? 300_000);
const MANDATE_WAIT_MS = 60_000;
const POLL_MS = 5_000;

const rupees = (minor: bigint) => `₹${(Number(minor) / 100).toLocaleString("en-IN")}`;

const rzp = new RazorpayProvider({
  keyId: config.RAZORPAY_TEST_KEY_ID,
  keySecret: config.RAZORPAY_TEST_KEY_SECRET,
  apiBase: config.RAZORPAY_API_BASE,
  webhookSecret: "verify-razorpay-pro-amounts-secret",
});

const uniq = Math.random().toString(36).slice(2, 8);
const contact = "9876543210";
const email = `rzp-pro-${uniq}@tmbilling.test`;

const ctx: RailContext = {
  apiBase: config.RAZORPAY_API_BASE,
  keyId: config.RAZORPAY_TEST_KEY_ID,
  auth: basicAuth(config.RAZORPAY_TEST_KEY_ID, config.RAZORPAY_TEST_KEY_SECRET),
  email,
  contact,
};

/**
 * The verdict grid this suite exists to fill in. `null` = not measured, which is
 * kept distinct from `false` on purpose: a rail that never answered must not read as
 * a rail that refused.
 */
type Verdict = { state: "pass" | "fail" | "not-measured"; detail: string };
const grid = new Map<string, Verdict>();
const record = (rail: string, path: string, amount: string, v: Verdict) =>
  grid.set(`${rail}|${path}|${amount}`, v);

/** Poll an off-session debit for settlement. `pending` is a real outcome, not a bug. */
async function pollSettlement(
  paymentId: string,
  budgetMs: number,
): Promise<{ status: string; captured: boolean }> {
  const deadline = Date.now() + budgetMs;
  let last = { status: "unknown", captured: false };
  while (Date.now() < deadline) {
    const p = await rzp.getPayment(paymentId);
    last = { status: p.status, captured: p.captured };
    if (p.captured || p.status === "captured" || p.status === "failed") return last;
    await sleep(POLL_MS);
  }
  return last;
}

// ───────────────────────────────────────────────────────────────────────────────
// Off-session debit through OUR adapter, shared by every mandate rail.
// ───────────────────────────────────────────────────────────────────────────────
async function debitOffSession(
  customer: ProviderCustomerRef,
  pm: ProviderPaymentMethodRef,
  amountMinor: bigint,
  tag: string,
): Promise<{ accepted: boolean; status: string; code?: string; paymentId: string }> {
  const charge = await rzp.charge({
    amountMinor,
    currency: "INR",
    customer,
    paymentMethod: pm,
    idempotencyKey: `pro_${uniq}_${tag}`,
    description: `tmbilling verify:razorpay-pro-amounts ${tag}`,
    email,
    phone: contact,
  });
  return {
    accepted: charge.status === "pending" || charge.status === "succeeded",
    status: charge.status,
    code: charge.failure?.providerCode ?? charge.failure?.code,
    paymentId: charge.providerChargeId,
  };
}

async function main() {
  console.log(`RazorPay ${config.RAZORPAY_API_BASE} (test mode)`);
  console.log(
    `Amounts under test: ${AMOUNTS.map((a) => `${a.label} = ${rupees(a.minor)}`).join("  ·  ")}\n`,
  );

  // ── 0. preflight: what this MERCHANT actually has enabled ──────────────────
  console.log("── preflight ──");
  const health = await rzp.healthCheck();
  ok("authenticated (order created)", health.ok && Boolean(health.orderId?.startsWith("order_")));

  const methods = await accountMethods(ctx);
  const payNowBanks = netbankingPayNowBanks(methods);
  const emandateBanks = Object.keys(methods?.recurring?.emandate ?? {});
  ok(`netbanking is enabled for pay-now (${payNowBanks.length} banks)`, payNowBanks.length > 0);
  ok(`netbanking e-mandate is enabled (${emandateBanks.length} banks)`, emandateBanks.length > 0);
  ok(`UPI is enabled (methods.upi=${JSON.stringify(methods?.upi)})`, Boolean(methods?.upi));

  // ⚠️ The pay-now bank list and the e-mandate bank list are DIFFERENT SETS. Picking
  // the bank from the account rather than from a favourite is what keeps this suite
  // from failing on a bank this merchant simply does not have for one-off payments.
  const NB_PREFERRED = ["CNRB", "FDRL", "IDFB", "INDB", "YESB"];
  const payNowBank = NB_PREFERRED.find((b) => payNowBanks.includes(b)) ?? payNowBanks[0];
  const bigFour = ["HDFC", "ICIC", "SBIN", "UTIB"].filter((b) => payNowBanks.includes(b));
  if (bigFour.length === 0) {
    warn(
      "HDFC / ICICI / SBI / Axis are ABSENT from this account's 64-bank pay-now netbanking list " +
        `(they ARE in the ${emandateBanks.length}-bank e-mandate list). A buyer at any of the four ` +
        `biggest Indian retail banks cannot pay a netbanking invoice on this merchant today. ` +
        `Using ${payNowBank} for the pay-now measurements below.`,
    );
  }

  // ⚠️ Probe the AMOUNT before any rail. RazorPay enforces a per-payment maximum per
  // merchant at ORDER CREATION — upstream of card, UPI and netbanking alike — so an
  // amount above it fails on all three identically. Without this one check, that
  // single account setting reads as three independently broken rails.
  const amountAllowed = new Map<string, boolean>();
  for (const amt of AMOUNTS) {
    const probe = await probeOrderAmount(ctx, Number(amt.minor));
    amountAllowed.set(amt.key, probe.ok);
    ok(`this merchant accepts a single payment of ${rupees(amt.minor)} (${amt.label})`, probe.ok);
    if (!probe.ok) {
      warn(
        `RAZORPAY WILL NOT ACCEPT ${rupees(amt.minor)} AS ONE PAYMENT on this account: ` +
          `"${probe.description}" — refused at order creation, before any rail is chosen, so it ` +
          `affects card, UPI and netbanking equally and no rail choice can work around it. The ` +
          `measured ceiling on this test key is ₹5,00,000 per payment. ${amt.label} therefore cannot ` +
          `be collected in a single transaction at all: it needs RazorPay to raise the account's ` +
          `maximum payment amount (a support request, per-merchant), or the plan has to be split. ` +
          `This is a NEW operator ask — it is not in src/modules/gateway/README.md.`,
      );
    }
  }

  const customer = await rzp.ensureCustomer({
    customerRef: `cus_pro_${uniq}`,
    email,
    name: "tmbilling pro-amount verify",
    phone: contact,
  });
  ok("customer created", customer.providerCustomerId.startsWith("cust_"));

  // ── 1. PAY NOW — card ──────────────────────────────────────────────────────
  // The card rail has no mandate ceiling on a buyer-present payment, so this is the
  // control: if a plan-sized amount cannot clear here, the amount itself is the
  // problem and every other row below is uninterpretable.
  console.log("\n── pay now · CARD ──");
  for (const amt of AMOUNTS) {
    const label = `card pay-now ${rupees(amt.minor)}`;
    try {
      const cap = await cardCapture(
        ctx,
        "INR",
        Number(amt.minor),
        TEST_CARDS.domesticVisaDebit.number,
      );
      const good =
        cap.captured && cap.status === "captured" && cap.amountMinor === Number(amt.minor);
      ok(
        `${label}: captured (status=${cap.status}, amount=${rupees(BigInt(cap.amountMinor))}, intl=${cap.international})`,
        good,
      );
      record("card", "pay-now", amt.key, {
        state: good ? "pass" : "fail",
        detail: `${cap.paymentId} status=${cap.status}`,
      });
    } catch (e) {
      // A refusal is a verdict; anything else is a gap. Recording the two the same way
      // is how "the gateway said no" and "we never asked properly" get confused.
      if (e instanceof GatewayRefusalError) {
        console.log(`  ❌ ${label}: REFUSED by RazorPay — ${e.description}`);
        record("card", "pay-now", amt.key, { state: "fail", detail: `refused: ${e.description}` });
      } else {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`${label}: NOT MEASURED — ${detail}`);
        record("card", "pay-now", amt.key, { state: "not-measured", detail });
      }
    }
  }

  // ── 2. PAY NOW — netbanking ────────────────────────────────────────────────
  // A one-off netbanking payment is method `netbanking`, NOT `emandate`; an order
  // that says `emandate` without a mandate token block is rejected outright.
  console.log("\n── pay now · NETBANKING ──");
  for (const amt of AMOUNTS) {
    const label = `netbanking pay-now ${rupees(amt.minor)} via ${payNowBank}`;
    if (!payNowBank) {
      warn(`${label}: NOT MEASURED — no netbanking bank enabled on this account`);
      record("netbanking", "pay-now", amt.key, {
        state: "not-measured",
        detail: "no bank enabled",
      });
      continue;
    }
    try {
      const cap = await netbankingCapture(ctx, "INR", Number(amt.minor), payNowBank);
      const good =
        cap.captured && cap.status === "captured" && cap.amountMinor === Number(amt.minor);
      ok(
        `${label}: captured (status=${cap.status}, amount=${rupees(BigInt(cap.amountMinor))}, method=${cap.method})`,
        good,
      );
      record("netbanking", "pay-now", amt.key, {
        state: good ? "pass" : "fail",
        detail: `${cap.paymentId} status=${cap.status}`,
      });
    } catch (e) {
      if (e instanceof GatewayRefusalError) {
        console.log(`  ❌ ${label}: REFUSED by RazorPay — ${e.description}`);
        record("netbanking", "pay-now", amt.key, {
          state: "fail",
          detail: `refused: ${e.description}`,
        });
      } else {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`${label}: NOT MEASURED — ${detail}`);
        record("netbanking", "pay-now", amt.key, { state: "not-measured", detail });
      }
    }
  }

  // ── 3. PAY NOW — UPI ───────────────────────────────────────────────────────
  // Only the COLLECT flow is scriptable: RazorPay auto-approves `success@razorpay` in
  // test mode, whereas the INTENT flow is a QR code nothing headless can scan.
  // A UPI one-off is also the row most likely to hit a CUSTOMER-side cap (~₹1,00,000
  // and ~10 transactions a day, set by the payer's PSP) rather than a merchant one.
  console.log("\n── pay now · UPI (collect) ──");
  for (const amt of AMOUNTS) {
    const label = `UPI pay-now ${rupees(amt.minor)}`;
    const sent = await upiCollectCapture(ctx, Number(amt.minor), RazorpayProvider.TEST_SUCCESS_VPA);
    if (!sent.paymentId) {
      // A refusal here IS the measurement for the annual amount — it is expected to
      // exceed the per-transaction UPI ceiling — so record it as a fact, not a gap.
      // Two different ceilings can refuse here and they are NOT the same finding:
      // the account's per-payment maximum (already reported in preflight, and rail-blind)
      // or the UPI per-transaction ceiling. Attributing an account limit to UPI would
      // blame the rail for something no rail choice can fix.
      const accountCapped = amountAllowed.get(amt.key) === false;
      const aboveUpiCeiling = amt.minor > UPI_AUTOPAY_CEILING;
      const why = accountCapped
        ? "the ACCOUNT per-payment maximum, not a UPI limit"
        : aboveUpiCeiling
          ? "expected — above the UPI ceiling"
          : "UNEXPECTED";
      console.log(
        `  ${accountCapped || aboveUpiCeiling ? "❌" : "❌"} ${label}: refused — ${why} — ${sent.detail}`,
      );
      record("upi", "pay-now", amt.key, {
        state: "fail",
        detail: `refused (${accountCapped ? "account cap" : aboveUpiCeiling ? "UPI ceiling" : "unexpected"})`,
      });
      if (!accountCapped && !aboveUpiCeiling) {
        ok(`${label}: refused for a reason we understand`, false);
      }
      continue;
    }
    const settled = await pollSettlement(sent.paymentId, 60_000);
    const good = settled.captured || settled.status === "captured";
    ok(
      `${label}: collect approved and captured (${sent.paymentId}, status=${settled.status})`,
      good,
    );
    record("upi", "pay-now", amt.key, {
      state: good ? "pass" : "fail",
      detail: `${sent.paymentId} status=${settled.status}`,
    });
  }

  // ⚠️ One rail's transport failure must not discard the other rails' results.
  //
  // This suite makes ~40 live calls over ~15 minutes, so a network blip is a matter of
  // when, not if — and it happened: an `ETIMEDOUT`/`EHOSTUNREACH` to RazorPay mid-run
  // aborted everything after it, throwing away a completed preflight and six finished
  // pay-now measurements. Same shape as the unguarded `r.json()` that used to abort
  // `verify:razorpay-live`: the expensive part is the evidence already gathered, so a
  // failure records NOT MEASURED for its own row and the run carries on.
  const rail = async (
    name: string,
    fn: (key: string, label: string, minor: bigint) => Promise<void>,
  ): Promise<void> => {
    for (const amt of AMOUNTS) {
      try {
        await fn(amt.key, amt.label, amt.minor);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        warn(`${name} auto-collect for ${amt.label}: NOT MEASURED — ${detail}`);
        // Only if the row is still empty: the helper may already have recorded a verdict
        // before throwing, and a real measurement must not be overwritten by the abort.
        if (!grid.has(`${name}|auto-collect|${amt.key}`)) {
          record(name, "auto-collect", amt.key, { state: "not-measured", detail });
        }
      }
    }
  };

  // ── 4. AUTO-COLLECT — UPI Autopay ──────────────────────────────────────────
  // The one mandate rail that registers without a browser, so the one whose
  // off-session debit can be proven at a real price unattended.
  console.log("\n── auto-collect · UPI AUTOPAY ──");
  await rail("upi", upiAutopayAtCeiling);

  // ── 5. AUTO-COLLECT — card mandate ─────────────────────────────────────────
  console.log("\n── auto-collect · CARD MANDATE ──");
  await rail("card", cardMandateAtCeiling);

  // ── 6. AUTO-COLLECT — netbanking e-mandate ─────────────────────────────────
  console.log("\n── auto-collect · NETBANKING E-MANDATE ──");
  await rail("netbanking", emandateAtCeiling);

  return finish();
}

/**
 * Register a UPI Autopay mandate whose ceiling is the plan price, then debit the plan
 * price against it.
 *
 * The interesting assertion is not the debit but the CEILING: `createMandateOrder`
 * clamps a requested `max_amount` down to the rail cap, so an annual plan above
 * ₹1,00,000 registers happily against a ₹1,00,000 mandate and then cannot be
 * collected. Reading the ceiling back off the order is what turns that from a code
 * reading into a measurement.
 */
async function upiAutopayAtCeiling(key: string, label: string, amountMinor: bigint): Promise<void> {
  const cust = await rzp.ensureCustomer({
    customerRef: `cus_upi_${key}_${uniq}`,
    email,
    name: `tmbilling upi ${key}`,
    phone: contact,
  });
  const overRailCap = amountMinor > UPI_AUTOPAY_CEILING;
  const setup = await rzp.initiateVaultSetup({
    customer: cust,
    returnUrl: "https://tmbilling.test/return",
    cancelUrl: "https://tmbilling.test/cancel",
    methodTypes: ["upi"],
    maxAmountMinor: amountMinor,
  });
  ok(`UPI mandate for ${label}: auth order accepted`, setup.setupTokenId.startsWith("order_"));

  const collect = await rzp.initiateUpiAutopayCollect({
    customerId: cust.providerCustomerId,
    vpa: RazorpayProvider.TEST_SUCCESS_VPA,
    email,
    contact,
    orderId: setup.setupTokenId,
  });
  let tokenId: string | null = null;
  const deadline = Date.now() + MANDATE_WAIT_MS;
  while (Date.now() < deadline) {
    const p = await rzp.getPayment(collect.paymentId);
    if (p.tokenId) {
      tokenId = p.tokenId;
      break;
    }
    if (p.status === "failed") break;
    await sleep(POLL_MS);
  }
  ok(
    `UPI mandate for ${label}: authenticated → recurring token minted`,
    Boolean(tokenId?.startsWith("token_")),
  );
  if (!tokenId) {
    record("upi", "auto-collect", key, {
      state: "not-measured",
      detail: "no mandate token minted",
    });
    return;
  }

  const carried = await readTokenMaxAmount(ctx, cust.providerCustomerId, tokenId);
  const clamped = carried != null && BigInt(carried) < amountMinor;
  // A mandate whose ceiling is BELOW the price it exists to collect is broken at
  // registration, however successful the registration looks. This is the failure mode
  // `createMandateOrder`'s own comment warns about, reintroduced by its clamp.
  // The ceiling is CLAMPED to the rail cap, by design (see createMandateOrder). Asserting
  // it is not clamped below the plan price is the check that matters: at or above the
  // price, the clamp is harmless; below it, this rail can never collect the plan.
  ok(
    `UPI mandate for ${label}: ceiling asked ${rupees(amountMinor)}, token carries ` +
      `${carried == null ? "unknown" : rupees(BigInt(carried))} — at or above the amount to be debited`,
    !clamped,
  );
  if (clamped) {
    warn(
      `RAIL CANNOT CARRY THIS PLAN — UPI Autopay for ${label}: the ceiling was clamped to ` +
        `${rupees(BigInt(carried ?? Number(UPI_AUTOPAY_CEILING)))}, below the ` +
        `${rupees(amountMinor)} that has to be debited (NPCI's UPI limit for this merchant category). ` +
        `The mandate registers and the buyer approves it, so nothing surfaces until the first ` +
        `renewal — at which point the engine parks the invoice with mandate_ceiling_exceeded ` +
        `(mandateRefusal in invoicing/collection.ts, pre-flight, non-retriable, so no schedule is ` +
        `burned and no subscription is cancelled). Safe, but LATE: the business should be told at ` +
        `registration that this plan needs the netbanking rail. Open item, PROGRESS.md 2026-08-19.`,
    );
  }

  const pm = await rzp.vaultPaymentMethod({
    customer: cust,
    token: tokenId,
    customerRef: `cus_upi_${key}_${uniq}`,
  });
  const debit = await debitOffSession(cust, pm, amountMinor, `upi_${key}`);
  // Above the RBI ₹15,000 AFA line the honest expectation is unknown — that is
  // operator ask 6. So the debit is REPORTED, and only the acceptance (a
  // correlatable payment id) is asserted; the settlement outcome is the finding.
  ok(
    `UPI auto-collect ${rupees(amountMinor)}: accepted with a correlatable id ` +
      `(status=${debit.status}${debit.code ? ` code=${debit.code}` : ""})`,
    debit.accepted && debit.paymentId.startsWith("pay_"),
  );
  if (!debit.accepted) {
    record("upi", "auto-collect", key, {
      state: "fail",
      detail: `${debit.status} ${debit.code ?? ""}`.trim(),
    });
    warn(
      `UPI auto-collect REFUSED at ${rupees(amountMinor)}: ${debit.status} ${debit.code ?? ""} — ` +
        `${
          overRailCap
            ? `the debit exceeds the mandate ceiling, because the ceiling was CLAMPED to ${rupees(UPI_AUTOPAY_CEILING)} at registration. ` +
              "This is the clamp above arriving as a renewal failure — exactly one month later, in production."
            : "above the RBI ₹15,000 AFA line; this is operator ask 6"
        }`,
    );
    return;
  }
  const settled = await pollSettlement(debit.paymentId, SETTLE_WAIT_MS);
  const collected = settled.captured || settled.status === "captured";
  record("upi", "auto-collect", key, {
    state: collected ? "pass" : "not-measured",
    detail: `${debit.paymentId} status=${settled.status}`,
  });
  if (collected) {
    const aboveAfa = amountMinor > RBI_AFA_EXEMPT_CEILING;
    console.log(
      `  ✅ UPI auto-collect ${rupees(amountMinor)}: SETTLED off-session (${debit.paymentId})`,
    );
    if (aboveAfa) {
      warn(
        `UPI Autopay collected ${rupees(amountMinor)} OFF-SESSION — above RBI's ₹15,000 AFA line — ` +
          `with no pre-debit notification and no AFA step from us. That answers operator ask 6 for ` +
          `THIS rail in test mode, and it contradicts RAZORPAY REPORT.md §6, which marks ₹56,118 on ` +
          `UPI Autopay as "blocked by ceiling". Re-confirm on live before relying on it.`,
      );
    }
  } else {
    warn(
      `UPI auto-collect ${rupees(amountMinor)} did not settle within ${SETTLE_WAIT_MS / 1000}s ` +
        `(status=${settled.status}). UPI debits are asynchronous — raise RZP_SETTLE_WAIT_MS. The ` +
        `engine's contract (accepted + correlatable id) is already satisfied.`,
    );
  }
}

/**
 * Register a CARD mandate at the plan price and debit it off-session.
 *
 * This is where RBI's ₹15,000 exemption bites hardest: both amounts are above it, so
 * a success here would be more surprising than a refusal. Either way it is measured
 * rather than assumed — and the refusal CODE is the part worth having, because it is
 * what dunning has to route on.
 */
async function cardMandateAtCeiling(
  key: string,
  label: string,
  amountMinor: bigint,
): Promise<void> {
  const cust = await rzp.ensureCustomer({
    customerRef: `cus_card_${key}_${uniq}`,
    email,
    name: `tmbilling card ${key}`,
    phone: contact,
  });
  const setup = await rzp.initiateVaultSetup({
    customer: cust,
    returnUrl: "https://tmbilling.test/return",
    cancelUrl: "https://tmbilling.test/cancel",
    methodTypes: ["card"],
    maxAmountMinor: amountMinor,
  });
  const carried = await readOrderMaxAmount(ctx, setup.setupTokenId);
  const clamped = carried != null && BigInt(carried) < amountMinor;
  ok(
    `card mandate for ${label}: ceiling asked ${rupees(amountMinor)}, carried ` +
      `${carried == null ? "unknown" : rupees(BigInt(carried))} — not silently clamped below the plan price`,
    !clamped,
  );
  if (clamped) {
    warn(
      `card mandate for ${label}: ceiling CLAMPED from ${rupees(amountMinor)} to ` +
        `${rupees(BigInt(carried!))} (RazorPay's ${rupees(RZP_MANDATE_CAP)} API cap). Same silent-clamp ` +
        `failure as UPI: registration succeeds, every renewal then exceeds the mandate.`,
    );
  }

  const auth = await cardMandateAuthorize(
    ctx,
    setup.setupTokenId,
    cust.providerCustomerId,
    TEST_CARDS.subsDomesticVisa.number,
    100, // the ₹1 auth amount `createMandateOrder` registers a card mandate against
  );
  if (!auth.paymentId) {
    // A throttle or an edge block is NOT evidence about the rail.
    warn(`card mandate for ${label}: NOT MEASURED — ${auth.detail}`);
    record("card", "auto-collect", key, { state: "not-measured", detail: auth.detail });
    return;
  }
  let tokenId: string | null = null;
  const deadline = Date.now() + MANDATE_WAIT_MS;
  while (Date.now() < deadline) {
    const p = await rzp.getPayment(auth.paymentId);
    if (p.tokenId) {
      tokenId = p.tokenId;
      break;
    }
    if (p.status === "failed") break;
    await sleep(POLL_MS);
  }
  ok(
    `card mandate for ${label}: registered → recurring token minted (challenge=${auth.detail})`,
    Boolean(tokenId?.startsWith("token_")),
  );
  if (!tokenId) {
    record("card", "auto-collect", key, {
      state: "not-measured",
      detail: "no mandate token minted",
    });
    return;
  }

  const pm = await rzp.vaultPaymentMethod({
    customer: cust,
    token: tokenId,
    customerRef: `cus_card_${key}_${uniq}`,
  });
  const debit = await debitOffSession(cust, pm, amountMinor, `card_${key}`);
  if (!debit.accepted) {
    // Expected above ₹15,000 — but recorded as a measured refusal WITH its code, not
    // as a pass, because "the rail cannot collect this price" is the answer either way.
    record("card", "auto-collect", key, {
      state: "fail",
      detail: `${debit.status} ${debit.code ?? ""}`.trim(),
    });
    // Attribute the refusal to the ceiling that actually caused it. The account's
    // per-payment maximum and RBI's AFA exemption are different problems with different
    // owners — one is a support ticket, the other is a rail choice — and `order_failed`
    // is the same opaque code for both.
    const accountCapped = amountMinor > ACCOUNT_MAX_PAYMENT;
    warn(
      `card auto-collect REFUSED at ${rupees(amountMinor)}: status=${debit.status} ` +
        `code=${debit.code ?? "none"} — ${
          accountCapped
            ? `attributable to the ACCOUNT per-payment maximum (${rupees(ACCOUNT_MAX_PAYMENT)}), NOT to RBI's ` +
              "₹15,000 AFA rule: the same amount is refused on every rail and on pay-now too, and the " +
              `card mandate itself registered a full ${rupees(amountMinor)} ceiling without complaint.`
            : "above RBI's ₹15,000 AFA exemption, so an off-session card debit at this price needs " +
              "per-debit authentication and is not off-session at all (operator ask 6)."
        }` +
        ` Either way: check ${debit.code ?? "this code"} is mapped in src/providers/decline-codes.ts —` +
        " an unmapped code takes the liberal retry default and burns the dunning schedule on a" +
        " refusal no interval can fix.",
    );
    return;
  }
  const settled = await pollSettlement(debit.paymentId, SETTLE_WAIT_MS);
  const collected = settled.captured || settled.status === "captured";
  // ⚠️ A CARD debit settles in minutes — unlike netbanking's two working days — so a card
  // payment still at `created` after the budget is a STALL, not latency, and it is the
  // worst of the three outcomes: `charge()` returned an accepted, correlatable payment,
  // so the engine books a pending payment and waits for a webhook that never comes.
  // Reporting it as "async, give it longer" would launder a hang into a pass.
  ok(
    `card auto-collect ${rupees(amountMinor)}: SETTLED, not merely accepted ` +
      `(${debit.paymentId}, status=${settled.status})`,
    collected,
  );
  record("card", "auto-collect", key, {
    state: collected ? "pass" : "fail",
    detail: `${debit.paymentId} status=${settled.status}${collected ? "" : " — accepted but never captured"}`,
  });
  if (!collected) {
    warn(
      `card auto-collect ${rupees(amountMinor)} was ACCEPTED AND NEVER CAPTURED — ` +
        `${debit.paymentId} is still \`${settled.status}\` after ${SETTLE_WAIT_MS / 1000}s. A card debit ` +
        `settles in minutes, so this is a stall rather than latency, and it is above RBI's ₹15,000 AFA ` +
        `line — the shape you would expect if the debit is silently waiting for an authentication that ` +
        `nobody will perform. This is the dangerous case: the adapter returned \`pending\` with a real ` +
        `payment id, so the engine has booked a pending payment against the invoice and is waiting for ` +
        `a settlement webhook that may never arrive. The stale-pending sweep is what has to resolve it. ` +
        `Operator ask 6 — and the reason a Pro-priced card renewal cannot be called supported.`,
    );
  }
  if (collected && amountMinor > RBI_AFA_EXEMPT_CEILING) {
    warn(
      `⚠️ FINDING CHANGED: a CARD mandate collected ${rupees(amountMinor)} off-session, above RBI's ` +
        `₹15,000 AFA exemption. If that reproduces, the ₹15,000 card ceiling in the gateway README and ` +
        `RAZORPAY REPORT.md §6 is wrong for this integration. Re-run before changing the docs — test ` +
        `mode not enforcing an RBI rule is the likelier explanation.`,
    );
  }
}

/**
 * Netbanking e-mandate at the plan price — registered and DEBITED, unattended.
 *
 * ⚠️ This rail was believed to be browser-only. `POST /payments/create/emandate` is
 * 404, and both `verify-razorpay-emandate-live.ts` and the gateway README concluded
 * from that that a registration needs a real browser. It does not: `emandateRegister`
 * posts `method: 'emandate'` to the CHECKOUT ajax endpoint against the order the
 * auth-link invoice wraps, and the mandate reaches `recurring: true, confirmed`.
 *
 * That upgrade matters more here than on any other rail, because netbanking is the
 * only one that collects a Pro-sized amount off-session — so it was the rail we could
 * least afford to leave unmeasured.
 */
async function emandateAtCeiling(key: string, label: string, amountMinor: bigint): Promise<void> {
  const cust = await rzp.ensureCustomer({
    customerRef: `cus_nb_${key}_${uniq}`,
    email,
    name: `tmbilling emandate ${key}`,
    phone: contact,
  });
  let setup;
  try {
    setup = await rzp.initiateVaultSetup({
      customer: cust,
      returnUrl: "https://tmbilling.test/return",
      cancelUrl: "https://tmbilling.test/cancel",
      methodTypes: ["bank_transfer"],
      maxAmountMinor: amountMinor,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    warn(`netbanking e-mandate for ${label}: NOT MEASURED — ${detail}`);
    record("netbanking", "auto-collect", key, { state: "not-measured", detail });
    return;
  }
  ok(
    `netbanking e-mandate for ${label}: registration is a hosted auth link (mode=${setup.mode})`,
    setup.mode === "redirect" && Boolean(setup.approvalUrl),
  );

  const orderId = await readInvoiceOrderId(ctx, setup.setupTokenId);
  ok(
    `netbanking e-mandate for ${label}: auth link wraps an order (${orderId ?? "none"})`,
    Boolean(orderId?.startsWith("order_")),
  );
  if (!orderId) {
    record("netbanking", "auto-collect", key, {
      state: "not-measured",
      detail: "auth link exposed no order",
    });
    return;
  }

  const reg = await emandateRegister(ctx, orderId, cust.providerCustomerId);
  if (!reg.paymentId) {
    warn(`netbanking e-mandate for ${label}: NOT MEASURED — ${reg.detail}`);
    record("netbanking", "auto-collect", key, { state: "not-measured", detail: reg.detail });
    return;
  }
  let tokenId: string | null = null;
  const deadline = Date.now() + MANDATE_WAIT_MS;
  while (Date.now() < deadline) {
    const p = await rzp.getPayment(reg.paymentId);
    if (p.tokenId) {
      tokenId = p.tokenId;
      break;
    }
    if (p.status === "failed") break;
    await sleep(POLL_MS);
  }
  ok(
    `netbanking e-mandate for ${label}: registered → bank token minted (${reg.detail})`,
    Boolean(tokenId?.startsWith("token_")),
  );
  if (!tokenId) {
    record("netbanking", "auto-collect", key, {
      state: "not-measured",
      detail: "no bank token minted",
    });
    return;
  }

  // ⚠️ A minted token is NOT a usable mandate. On this rail the registration payment
  // reports `captured` with a real token id even when the bank REJECTED the mandate —
  // the token then reads `recurring: false, status: "rejected"` and the first debit
  // fails with a message about a missing `bank_account` field, which looks like an
  // adapter bug and is not one. Assert the mandate state, not the token's existence.
  const state = await readTokenRecurringState(ctx, cust.providerCustomerId, tokenId);
  ok(
    `netbanking mandate for ${label}: token is a CONFIRMED recurring mandate ` +
      `(recurring=${state.recurring}, status=${state.status ?? "none"}` +
      `${state.failureReason ? `, reason=${state.failureReason}` : ""})`,
    state.recurring && state.status === "confirmed",
  );
  const clamped = state.maxAmount != null && BigInt(state.maxAmount) < amountMinor;
  ok(
    `netbanking mandate for ${label}: ceiling asked ${rupees(amountMinor)}, token carries ` +
      `${state.maxAmount == null ? "unknown" : rupees(BigInt(state.maxAmount))} — not silently clamped ` +
      "below the plan price",
    !clamped,
  );
  if (!state.recurring) {
    record("netbanking", "auto-collect", key, {
      state: "fail",
      detail: `mandate ${state.status ?? "unusable"}${state.failureReason ? `: ${state.failureReason}` : ""}`,
    });
    return;
  }

  const pm = await rzp.vaultPaymentMethod({
    customer: cust,
    token: tokenId,
    customerRef: `cus_nb_${key}_${uniq}`,
  });
  ok(
    `netbanking mandate for ${label}: vaulted as a bank instrument (type=${pm.display.type})`,
    pm.display.type === "bank_transfer",
  );
  const debit = await debitOffSession(cust, pm, amountMinor, `nb_${key}`);
  if (!debit.accepted) {
    record("netbanking", "auto-collect", key, {
      state: "fail",
      detail: `${debit.status} ${debit.code ?? ""}`.trim(),
    });
    const accountCapped = amountMinor > ACCOUNT_MAX_PAYMENT;
    warn(
      `netbanking auto-collect REFUSED at ${rupees(amountMinor)}: status=${debit.status} ` +
        `code=${debit.code ?? "none"}${
          accountCapped
            ? ` — attributable to the ACCOUNT per-payment maximum (${rupees(ACCOUNT_MAX_PAYMENT)}), not to the rail`
            : ""
        }`,
    );
    return;
  }
  ok(
    `netbanking auto-collect ${rupees(amountMinor)}: accepted with a correlatable id ` +
      `(status=${debit.status})`,
    debit.paymentId.startsWith("pay_"),
  );
  // ⚠️ `pending` is a legitimate outcome here and NOT a failure: RazorPay must receive a
  // netbanking debit by 08:59 on a bank working day and settlement can take two working
  // days. Unlike the card rail, a pending netbanking debit is the documented behaviour,
  // so it is recorded as accepted-and-pending rather than as a stall.
  const settled = await pollSettlement(debit.paymentId, SETTLE_WAIT_MS);
  const collected = settled.captured || settled.status === "captured";
  record("netbanking", "auto-collect", key, {
    state: collected ? "pass" : "not-measured",
    detail: `${debit.paymentId} status=${settled.status}`,
  });
  if (collected) {
    console.log(
      `  ✅ netbanking auto-collect ${rupees(amountMinor)}: SETTLED off-session (${debit.paymentId})`,
    );
    if (amountMinor > RBI_AFA_EXEMPT_CEILING) {
      warn(
        `NETBANKING E-MANDATE collected ${rupees(amountMinor)} OFF-SESSION — above RBI's ₹15,000 ` +
          "AFA line, with no AFA step and no pre-debit notice from us. This is the rail that can bill " +
          "a Pro-priced INR plan on autopilot, and it is the first time we have measured it ABOVE " +
          `₹15,000 (the standing proof, 2026-08-13, was ₹13,870 — below the line). It supports ` +
          "RAZORPAY REPORT.md §6, which recommends e-NACH for exactly this band.",
      );
    }
  } else {
    warn(
      `netbanking auto-collect ${rupees(amountMinor)} is ${settled.status} after ` +
        `${SETTLE_WAIT_MS / 1000}s — EXPECTED on this rail, not a failure (RazorPay must receive it by ` +
        "08:59 on a bank working day; settlement can take 2 working days). The stale-pending clock " +
        "pass is what resolves it.",
    );
  }
}

function finish() {
  console.log(`\n${"─".repeat(74)}`);
  console.log("VERDICT — can RazorPay collect a Pro-plan-sized INR payment?\n");
  const rails = [
    ["card", "card"],
    ["netbanking", "netbanking"],
    ["upi", "UPI"],
  ] as const;
  const sym = (v?: Verdict) =>
    v == null
      ? "· not run"
      : v.state === "pass"
        ? "✅ yes"
        : v.state === "fail"
          ? "❌ no"
          : "⚠️  not measured";
  for (const path of ["pay-now", "auto-collect"] as const) {
    console.log(`  ${path}:`);
    for (const [key, name] of rails) {
      for (const amt of AMOUNTS) {
        const v = grid.get(`${key}|${path}|${amt.key}`);
        console.log(
          `    ${name.padEnd(11)} ${rupees(amt.minor).padEnd(12)} ${sym(v)}${v ? `  (${v.detail})` : ""}`,
        );
      }
    }
  }

  const failed = checks.filter(([, c]) => !c);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed, ${warns.length} warning(s)`,
  );
  if (warns.length) for (const w of warns) console.log(`  ⚠️  ${w}`);
  if (failed.length) {
    console.log("\n❌ RAZORPAY PRO AMOUNTS: FAIL");
    for (const [n] of failed) console.log(`   - ${n}`);
  } else {
    console.log("\n✅ RAZORPAY PRO AMOUNTS: PASS");
  }
  return failed.length === 0;
}

const passed = await main();
await closeDb();
process.exit(passed ? 0 : 1);
