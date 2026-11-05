/**
 * PayU adapter, offline. No network: `fetch` is replaced by a stub that answers each
 * postservice command with a fixture shaped on the answers measured on test.payu.in.
 *
 * Covers the request, reverse, command and mandate hashes (valid, tampered, wrong salt),
 * payment / refund / mandate webhook parsing and event mapping, the hosted-checkout forms
 * (one-off vs SI), the pre-debit capability and schedule, renewals, refunds, decline
 * mapping and the catalogue entry.
 *
 *   pnpm verify:payu
 */
import {
  PAYU_LIVE_CHECKOUT,
  PAYU_TEST_CHECKOUT,
  PayuProvider,
  fromPayuAmount,
  normalizePayuPayment,
  parsePayuInstrument,
  payuCommandHash,
  payuDebitSchedule,
  payuMandateStatus,
  payuMandateWebhookHash,
  payuUpiMandateWebhookHash,
  payuMethodUsed,
  payuRefundToken,
  payuRequestHash,
  payuReturnUrl,
  payuReverseHash,
  payuTxnKind,
  payuTxnid,
  sha512,
  toPayuAmount,
} from "@/providers/payu";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizePayuDecline,
} from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES, GatewayResolveError } from "@/providers/gateways";
import { ProviderIndeterminateError, ProviderRefusalError, preDebitRule } from "@/providers/types";
import type { ProviderPaymentMethodRef } from "@/providers/types";
import { flushGatewayRequestLogs } from "@/providers/http";
import { closeDb } from "@/platform/db";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const throwsSync = (fn: () => unknown, re?: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test(String((e as Error).message)) : true;
  }
};
const rejects = async (p: Promise<unknown>, cls?: new (...a: never[]) => Error) => {
  try {
    await p;
    return false;
  } catch (e) {
    return cls ? e instanceof cls : true;
  }
};

const KEY = "pyKey1";
const SALT = "offline_salt_XXXXXXXXXXXXXXXXXXXX";
const NOW = Date.parse("2026-10-25T04:30:00Z"); // 10:00 IST
const POST = "https://payu.invalid/merchant/postservice.php?form=2";
const payu = new PayuProvider({
  merchantKey: KEY,
  merchantSalt: SALT,
  livemode: false,
  postserviceUrl: POST,
  now: () => NOW,
});

// ── fetch stub ───────────────────────────────────────────────────────────────

type Answer = unknown | ((var1: string, form: URLSearchParams) => unknown);
let answers: Record<string, Answer> = {};
let calls: { command: string; var1: string; form: URLSearchParams }[] = [];
let failTransport = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (!String(url).startsWith("https://payu.invalid")) return realFetch(url, init);
  if (failTransport) throw new TypeError("fetch failed");
  const form = new URLSearchParams(String(init?.body ?? ""));
  const command = form.get("command") ?? "";
  const var1 = form.get("var1") ?? "";
  calls.push({ command, var1, form });
  const a = answers[command];
  const body =
    typeof a === "function" ? (a as (v: string, f: URLSearchParams) => unknown)(var1, form) : a;
  if (body === undefined) return new Response("{}", { status: 200 });
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;
const reset = (a: Record<string, Answer> = {}) => {
  answers = a;
  calls = [];
  failTransport = false;
};

// ── fixtures (measured shapes, fake ids) ─────────────────────────────────────

const CUSTOMER = "cus_XXXXXXXXXXXX01";
const AUTH_ID = "20000000001";
const notFound = (txnid: string) => ({
  status: 0,
  msg: "0 out of 1 Transactions Fetched Successfully",
  transaction_details: { [txnid]: { mihpayid: "Not Found", status: "Not Found" } },
});
const found = (txnid: string, row: Record<string, unknown>) => ({
  status: 1,
  msg: "1 out of 1 Transactions Fetched Successfully",
  transaction_details: {
    [txnid]: {
      mihpayid: AUTH_ID,
      txnid,
      amt: "1.00",
      mode: "CC",
      status: "success",
      unmappedstatus: "captured",
      payment_source: "sist",
      card_type: "VISA",
      card_no: "XXXXXXXXXXXX1112",
      error_code: "E000",
      error_Message: "NO ERROR",
      udf1: "pi_XXXXXXXXXXXX01",
      udf2: CUSTOMER,
      addedon: "2026-10-25 00:12:13",
      ...row,
    },
  },
});

/** A payment webhook / surl POST, signed the way PayU signs it. */
function paymentPost(fields: Record<string, string>, salt = SALT): Record<string, string> {
  const f: Record<string, string> = {
    mihpayid: AUTH_ID,
    mode: "CC",
    status: "success",
    unmappedstatus: "captured",
    key: KEY,
    amount: "1.00",
    addedon: "2026-10-25 00:12:13",
    productinfo: "Payment authorization",
    firstname: "Test",
    email: "payer@example.com",
    phone: "9999999999",
    udf1: "pi_XXXXXXXXXXXX01",
    udf2: CUSTOMER,
    udf3: "",
    udf4: "",
    udf5: "",
    field9: "Transaction is Successful",
    payment_source: "sist",
    error: "E000",
    error_Message: "No Error",
    ...fields,
  };
  f.hash = payuReverseHash(salt, f);
  return f;
}
const formBody = (f: Record<string, string>) => new URLSearchParams(f).toString();
const card = (id = `card:${AUTH_ID}`): ProviderPaymentMethodRef => ({
  providerKey: "payu",
  providerPaymentMethodId: id,
  display: { type: id.startsWith("upi") ? "upi" : id.startsWith("nb") ? "bank_transfer" : "card" },
});

async function main() {
  // ── A. hashes ──────────────────────────────────────────────────────────────
  const siDetails = '{"billingAmount":"1000.00"}';
  const req = {
    key: KEY,
    txnid: "tmsuX1",
    amount: "1.00",
    productinfo: "P",
    firstname: "F",
    email: "e@example.com",
    udf1: "u1",
    si_details: siDetails,
  };
  ok(
    "request hash: key|txnid|amount|productinfo|firstname|email|udf1..udf5|5 empty|si_details|salt",
    payuRequestHash(SALT, req) ===
      sha512(
        [
          KEY,
          "tmsuX1",
          "1.00",
          "P",
          "F",
          "e@example.com",
          "u1",
          ...Array(9).fill(""),
          siDetails,
          SALT,
        ].join("|"),
      ),
  );
  ok(
    "request hash without si keeps the empty si_details slot (measured with api_version 7)",
    payuRequestHash(SALT, { ...req, si_details: undefined }) ===
      sha512(
        [KEY, "tmsuX1", "1.00", "P", "F", "e@example.com", "u1", ...Array(10).fill(""), SALT].join(
          "|",
        ),
      ),
  );
  ok(
    "a tampered amount changes the request hash",
    payuRequestHash(SALT, { ...req, amount: "2.00" }) !== payuRequestHash(SALT, req),
  );
  ok(
    "another salt changes the request hash",
    payuRequestHash("other", req) !== payuRequestHash(SALT, req),
  );
  ok(
    "command hash is sha512(key|command|var1|salt)",
    payuCommandHash(KEY, "verify_payment", "t1", SALT) ===
      sha512(`${KEY}|verify_payment|t1|${SALT}`),
  );
  const ret = paymentPost({ txnid: "tmsuREG1" });
  ok(
    "reverse hash: salt|status|5 empty|udf5..udf1|email|firstname|productinfo|amount|txnid|key",
    ret.hash ===
      sha512(
        [
          SALT,
          "success",
          ...Array(5).fill(""),
          "",
          "",
          "",
          CUSTOMER,
          "pi_XXXXXXXXXXXX01",
          "payer@example.com",
          "Test",
          "Payment authorization",
          "1.00",
          "tmsuREG1",
          KEY,
        ].join("|"),
      ),
  );
  ok("a signed return verifies", !throwsSync(() => payu.verifyPaymentHash(ret)));
  ok(
    "a tampered status is refused",
    throwsSync(() => payu.verifyPaymentHash({ ...ret, status: "failure" }), /hash/),
  );
  ok(
    "a tampered amount is refused",
    throwsSync(() => payu.verifyPaymentHash({ ...ret, amount: "100.00" }), /hash/),
  );
  ok(
    "a return signed with another salt is refused",
    throwsSync(
      () => payu.verifyPaymentHash(paymentPost({ txnid: "tmsuREG1" }, "wrong_salt")),
      /hash/,
    ),
  );
  ok(
    "another merchant key is refused even with a matching hash",
    throwsSync(
      () => payu.verifyPaymentHash(paymentPost({ txnid: "tmsuREG1", key: "otherK" })),
      /merchant key/,
    ),
  );
  ok(
    "a body without a hash is refused",
    throwsSync(() => payu.verifyPaymentHash({ ...ret, hash: "" }), /hash/),
  );
  const charges = paymentPost({ txnid: "tmpyX", additionalCharges: "10.00" });
  ok(
    "additionalCharges is prepended to the reverse hash",
    !throwsSync(() => payu.verifyPaymentHash(charges)) &&
      throwsSync(() => payu.verifyPaymentHash({ ...charges, additionalCharges: "0.00" })),
  );
  const mandateBody: Record<string, unknown> = {
    status: "deleted",
    authPayuId: AUTH_ID,
    si_details: {
      billingAmount: "1000.00",
      paymentStartDate: "2026-10-25",
      paymentEndDate: "2036-10-25",
    },
    message: "Mandate cancelled",
    eventDate: "2026-10-26",
    notificationType: "MANDATE_CANCELLATION",
    key: KEY,
    udf1: "",
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
  };
  mandateBody.hash = payuMandateWebhookHash(SALT, mandateBody);
  ok(
    "mandate webhook hash follows PayU's field order",
    mandateBody.hash ===
      sha512(
        `deleted|${AUTH_ID}|MANDATE_CANCELLATION|1000.00|2026-10-25|2036-10-25|Mandate cancelled|2026-10-26|${KEY}||||||${SALT}`,
      ),
  );

  // ── B. hosted checkout ─────────────────────────────────────────────────────
  const contact = { email: "payer@example.com", phone: "+91 99999 99999", name: "Test Payer" };
  const oneOff = await payu.createIntent({
    purpose: "payment",
    amountMinor: 49_900n,
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    idempotencyKey: "pi_create_pi_XXXXXXXXXXXX02_a1",
    ownershipRef: "pi_XXXXXXXXXXXX02",
    contact,
    returnUrl: "https://pay.example.com/gateway-return?next=%2Fpay%2Finv_1%3Fa%3D1%26b%3D2",
    description: "Invoice INV-0001 & more",
  });
  const of = oneOff.authorization?.formPost?.fields ?? {};
  ok(
    "a one-off is a form_post to test _payment",
    oneOff.authorization?.mode === "form_post" &&
      oneOff.authorization.formPost?.action === PAYU_TEST_CHECKOUT,
  );
  ok(
    "a one-off has no si and no method restriction",
    !("si" in of) && !("si_details" in of) && !("enforce_paymethod" in of),
  );
  ok(
    "a one-off txnid is ours, ≤ 25 and alphanumeric",
    payuTxnKind(oneOff.intentId) === "payment" && /^[A-Za-z0-9]{1,25}$/.test(oneOff.intentId),
  );
  ok("the amount is decimal rupees", of.amount === "499.00");
  ok("the one-off form hash verifies", of.hash === payuRequestHash(SALT, of));
  ok(
    "productinfo keeps PayU's character set",
    /^[A-Za-z0-9\-_@()/ .]+$/.test(of.productinfo ?? ""),
  );
  ok("the phone is 10 digits", of.phone === "9999999999");
  ok(
    "surl escapes % so PayU's one decode leaves the return URL intact",
    of.surl ===
      "https://pay.example.com/gateway-return?next=%252Fpay%252Finv_1%253Fa%253D1%2526b%253D2" &&
      decodeURIComponent(of.surl!) ===
        "https://pay.example.com/gateway-return?next=%2Fpay%2Finv_1%3Fa%3D1%26b%3D2",
  );
  ok(
    "payuReturnUrl only touches %",
    payuReturnUrl("https://a.example.com/x?y=1") === "https://a.example.com/x?y=1",
  );
  ok(
    "same key, same txnid",
    (
      await payu.createIntent({
        purpose: "payment",
        amountMinor: 49_900n,
        currency: "INR",
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        idempotencyKey: "pi_create_pi_XXXXXXXXXXXX02_a1",
        contact,
        returnUrl: "https://pay.example.com/r",
      })
    ).intentId === oneOff.intentId,
  );

  const setup = await payu.createIntent({
    purpose: "setup",
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    idempotencyKey: "pi_create_pi_XXXXXXXXXXXX03_a1",
    contact,
    returnUrl: "https://pay.example.com/r",
    methodTypes: ["upi"],
    maxAmountMinor: 9_000_000n,
  });
  const sf = setup.authorization?.formPost?.fields ?? {};
  const si = JSON.parse(sf.si_details ?? "{}") as Record<string, unknown>;
  ok("a setup is si=1 with api_version 7", sf.si === "1" && sf.api_version === "7");
  ok(
    "a setup is ADHOC so PayU never debits on its own",
    si.billingCycle === "ADHOC" && si.billingCurrency === "INR",
  );
  ok("a UPI-only ceiling is capped at ₹15,000", si.billingAmount === "15000.00");
  ok("UPI registration debits ₹1", sf.amount === "1.00");
  ok("UPI start date is today (IST)", si.paymentStartDate === "2026-10-25");
  ok("the setup restricts the hosted page to the rails asked for", sf.enforce_paymethod === "upi");
  ok("the setup form hash covers si_details", sf.hash === payuRequestHash(SALT, sf));
  ok("a setup txnid is ours", payuTxnKind(setup.intentId) === "setup");
  const firstSetup = await payu.createIntent({
    purpose: "setup",
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    idempotencyKey: "pi_create_pi_XXXXXXXXXXXX05_a1",
    contact,
    returnUrl: "https://pay.example.com/r",
    methodTypes: ["card"],
    maxAmountMinor: 15_000n,
    firstChargeMinor: 20_000n,
  });
  const ff = firstSetup.authorization?.formPost?.fields ?? {};
  const fsi = JSON.parse(ff.si_details ?? "{}") as Record<string, unknown>;
  ok(
    "a first-charge registration collects the first invoice, marked in udf3, signed",
    ff.amount === "200.00" && ff.udf3 === "tmfirst" && ff.hash === payuRequestHash(SALT, ff),
  );
  ok("…and its mandate ceiling covers that charge", fsi.billingAmount === "200.00");
  ok(
    "an email over 50 characters is refused, never cut",
    await rejects(
      payu.createIntent({
        purpose: "payment",
        amountMinor: 100n,
        currency: "INR",
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        idempotencyKey: "pi_create_pi_XXXXXXXXXXXX06_a1",
        contact: { ...contact, email: `${"a".repeat(45)}@example.com` },
        returnUrl: "https://pay.example.com/r",
      }),
      ProviderRefusalError,
    ),
  );
  reset({
    verify_payment: (v: string) => found(v, { amt: "200.00" }),
    getAllRefundsFromTxnIds: { status: 1, msg: "No Refunds Found" },
  });
  const cleanState = await payu.setupChargeState("tmsuFIRST1");
  reset({
    verify_payment: (v: string) => found(v, { amt: "200.00" }),
    getAllRefundsFromTxnIds: {
      status: 1,
      "Refund Details": {
        [AUTH_ID]: [{ RequestID: "1", RefundToken: "t", Amount: "200.00", Status: "queued" }],
      },
    },
  });
  const refundedState = await payu.setupChargeState("tmsuFIRST1");
  ok(
    "setupChargeState reads the captured amount and any refund on the registration",
    cleanState?.capturedMinor === 20_000n &&
      cleanState.refunded === false &&
      refundedState?.refunded === true,
  );
  const nb = await payu.initiateVaultSetup({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    contact,
    returnUrl: "https://pay.example.com/r",
    cancelUrl: "https://pay.example.com/c",
    methodTypes: ["bank_transfer"],
  });
  ok(
    "net banking registers at ₹0",
    nb.formPost?.fields.amount === "0.00" && nb.mode === "form_post",
  );
  ok("the cancel URL goes in curl", nb.formPost?.fields.curl === "https://pay.example.com/c");
  ok(
    "card methods map to creditcard|debitcard",
    (
      await payu.initiateVaultSetup({
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        contact,
        returnUrl: "https://x.example.com",
        cancelUrl: "https://x.example.com",
        methodTypes: ["card"],
      })
    ).formPost?.fields.enforce_paymethod === "creditcard|debitcard",
  );
  ok(
    "a checkout without a phone is refused with a 400",
    await rejects(
      payu.createIntent({
        purpose: "payment",
        amountMinor: 100n,
        currency: "INR",
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        idempotencyKey: "k",
        contact: { email: "a@example.com" },
        returnUrl: "https://x.example.com",
      }),
      ProviderRefusalError,
    ),
  );
  ok(
    "a USD payment is refused with a 400",
    await rejects(
      payu.createIntent({
        purpose: "payment",
        amountMinor: 100n,
        currency: "USD",
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        idempotencyKey: "k",
        contact,
        returnUrl: "https://x.example.com",
      }),
      ProviderRefusalError,
    ),
  );
  ok(
    "a live account posts to secure.payu.in",
    new PayuProvider({ merchantKey: KEY, merchantSalt: SALT, livemode: true }).checkoutForm({
      txnid: "tmpyX",
      amountMinor: 100n,
      contact,
      returnUrl: "https://x.example.com",
      ownershipRef: "r",
      customerId: CUSTOMER,
    }).action === PAYU_LIVE_CHECKOUT,
  );

  // ── C. completing setups and one-offs ──────────────────────────────────────
  reset({ verify_payment: (v: string) => found(v, {}) });
  const consumed = await payu.consumeIntent({
    intentId: "tmsuREG1",
    idempotencyKey: "c1",
    purpose: "setup",
  });
  ok(
    "a sist registration vaults card:<authpayuid>",
    consumed.purpose === "setup" &&
      consumed.paymentMethod?.providerPaymentMethodId === `card:${AUTH_ID}` &&
      consumed.paymentMethod.mandate?.reference === AUTH_ID &&
      consumed.paymentMethod.display.last4 === "1112" &&
      consumed.paymentMethod.display.brand === "visa",
  );
  reset({ verify_payment: (v: string) => found(v, { amt: "200.00", udf3: "tmfirst" }) });
  const firstVault = await payu.consumeIntent({
    intentId: "tmsuFIRST1",
    idempotencyKey: "c-first",
    purpose: "setup",
  });
  ok(
    "a first-charge registration is reported as the first charge, not a ₹1 auth",
    firstVault.purpose === "setup" &&
      firstVault.paymentMethod?.setupAuthCharge?.firstCharge === true &&
      firstVault.paymentMethod.setupAuthCharge.amountMinor === 20_000n,
  );
  reset({
    verify_payment: (v: string) =>
      found(v, { payment_source: "payu", amt: "200.00", error_code: "E755" }),
    cancel_refund_transaction: { status: 1, msg: "Refund Request Queued", error_code: 102 },
  });
  const nm = await payu.consumeIntent({
    intentId: "tmsuNOMANDATE",
    idempotencyKey: "c-nm",
    purpose: "setup",
  });
  ok(
    "a registration paid without a mandate is reported for the engine's durable refund (no fire-and-forget call)",
    nm.purpose === "setup" &&
      !!nm.failure &&
      nm.setupAuthCharge?.providerChargeId === "tmsuNOMANDATE" &&
      nm.setupAuthCharge.amountMinor === 20_000n &&
      !calls.some((c) => c.command === "cancel_refund_transaction"),
  );
  const nmHook = normalizePayuPayment({
    txnid: "tmsuNOMANDATE",
    status: "success",
    mihpayid: AUTH_ID,
    payment_source: "payu",
    amount: "200.00",
    error: "E755",
  });
  ok(
    "…and its webhook carries the payment to refund",
    nmHook.type === "intent.setup_failed" && nmHook.setupAuthCharge?.amountMinor === 20_000n,
  );
  ok(
    "the ₹1 registration payment is reported for the engine to refund",
    consumed.purpose === "setup" &&
      consumed.paymentMethod?.setupAuthCharge?.providerChargeId === "tmsuREG1" &&
      consumed.paymentMethod.setupAuthCharge.amountMinor === 100n,
  );
  reset({
    verify_payment: (v: string) =>
      found(v, {
        payment_source: "payu",
        error_code: "E755",
        error_Message:
          "Payment was successful but mandate failed due to card not supported for recurring transactions",
      }),
  });
  const refused = await payu.consumeIntent({
    intentId: "tmsuREG2",
    idempotencyKey: "c2",
    purpose: "setup",
  });
  ok(
    "money taken with no mandate (payment_source payu) is a setup failure",
    refused.purpose === "setup" &&
      !refused.paymentMethod &&
      refused.failure?.code === "recurring_not_enabled" &&
      refused.failure.retriable === false,
  );
  ok(
    "a one-off payment is never vaulted",
    await rejects(
      payu.vaultPaymentMethod({
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        token: "tmpyPAID",
      }),
    ),
  );
  reset({ verify_payment: (v: string) => found(v, { udf2: "cus_XXXXXXXXXXXX99" }) });
  ok(
    "another customer's registration is refused",
    await rejects(
      payu.vaultPaymentMethod({
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        token: "tmsuREG1",
      }),
      Error,
    ),
  );
  reset({
    verify_payment: (v: string) => found(v, { payment_source: "payu", mode: "UPI", amt: "499.00" }),
  });
  const paid = await payu.consumeIntent({
    intentId: oneOff.intentId,
    idempotencyKey: "c3",
    purpose: "payment",
  });
  ok(
    "a paid one-off is a succeeded charge on the txnid, with the method used",
    paid.purpose === "payment" &&
      paid.charge.status === "succeeded" &&
      paid.charge.providerChargeId === oneOff.intentId &&
      paid.charge.methodUsed === "upi",
  );
  const fetched = await payu.fetchIntent({ intentId: oneOff.intentId, resolveOwnership: true });
  ok(
    "a paid one-off polls as consumed (captured, not a hold)",
    fetched.status === "consumed" &&
      fetched.amountMinor === 49_900n &&
      fetched.ownership === "ours",
  );
  reset({ verify_payment: (v: string) => notFound(v) });
  ok(
    "an unknown txnid polls as unknown",
    (await payu.fetchIntent({ intentId: "tmpyNONE" })).status === "unknown",
  );
  reset({ verify_payment: (v: string) => found(v, {}) });
  ok(
    "a sist registration polls as authorized",
    (await payu.fetchIntent({ intentId: "tmsuREG1" })).status === "authorized",
  );
  ok(
    "methods used map onto ours, else a lowercase label",
    payuMethodUsed("CC") === "card" &&
      payuMethodUsed("DC") === "card" &&
      payuMethodUsed("UPI") === "upi" &&
      payuMethodUsed("NB") === "bank_transfer" &&
      payuMethodUsed("CASH") === "wallet" &&
      payuMethodUsed("EMI") === "emi" &&
      payuMethodUsed("BNPL") === "bnpl" &&
      payuMethodUsed("NEFTRTGS") === "neft_rtgs" &&
      payuMethodUsed("??1") === undefined &&
      payuMethodUsed("") === undefined,
  );

  // ── D. pre-debit notice ────────────────────────────────────────────────────
  const cap = payu.capabilities.preDebitNotice!;
  ok(
    "pre-debit: card 24 h / 1 debit, UPI 25 h / first try + 3 retries, exact amount",
    JSON.stringify(cap.methods) === '["card","upi"]' &&
      JSON.stringify(preDebitRule(cap, "card")) === '{"minLeadHours":24,"maxDebitsPerNotice":1}' &&
      JSON.stringify(preDebitRule(cap, "upi")) === '{"minLeadHours":25,"maxDebitsPerNotice":4}' &&
      preDebitRule(cap).minLeadHours === 25 &&
      cap.exactAmount,
  );
  ok(
    "PayU notifies no payer itself outside the notice rails",
    payu.capabilities.gatewayNotifiesPayer === undefined,
  );
  reset({
    pre_debit_SI: {
      status: 1,
      action: "MANDATE_PRE_DEBIT",
      message: "Invoice Created Successfully",
      invoiceStatus: "Unpaid",
      approvedStatus: "Not_applicable",
    },
  });
  const debitAt = new Date(NOW + 48 * 3_600_000 + 600_000);
  const notice = await payu.notifyUpcomingDebit({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(),
    amountMinor: 99_900n,
    currency: "INR",
    debitAt,
    idempotencyKey: "pdn:pm_XXXXXXXXXXXX01:99900:INR:collect:1792800000000",
  });
  const pv = JSON.parse(calls[0]?.var1 ?? "{}") as Record<string, unknown>;
  ok(
    "the notice names the mandate, amount, IST debit date and invoice number",
    calls[0]?.command === "pre_debit_SI" &&
      pv.authpayuid === AUTH_ID &&
      pv.amount === "999.00" &&
      pv.debitDate === "2026-10-27" &&
      pv.invoiceDisplayNumber === notice.notificationRef,
  );
  ok("the invoice number is ≤ 25 alphanumeric", /^[A-Za-z0-9]{1,25}$/.test(notice.notificationRef));
  ok(
    "an accepted notice is sent, executable after the lead, until the end of the IST day",
    notice.status === "sent" &&
      notice.executableAfter!.getTime() >= NOW + 48 * 3_600_000 &&
      notice.expiresAt!.toISOString() === new Date("2026-10-28T00:00:00+05:30").toISOString(),
  );
  // PayU integration support, 2026-11-02: cards 24 h; UPI 25 h (a re-notice after the retries).
  const soon = await payu.notifyUpcomingDebit({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(),
    amountMinor: 99_900n,
    currency: "INR",
    debitAt: new Date(NOW),
    idempotencyKey: "pdn:pm_XXXXXXXXXXXX01:99900:INR:collect:1792800000001",
  });
  const upiSoon = payuDebitSchedule(
    new Date(NOW),
    new Date(NOW),
    preDebitRule(cap, "upi").minLeadHours,
    true,
  );
  ok(
    "a card notice is executable 24 h after it is sent; a UPI one 25 h (here moved past the 11:00 peak)",
    soon.executableAfter!.getTime() === NOW + 24 * 3_600_000 &&
      upiSoon.executableAfter.toISOString() === new Date("2026-10-26T13:00:00+05:30").toISOString(),
  );
  reset({
    pre_debit_SI: {
      status: 0,
      action: "MANDATE_PRE_DEBIT",
      message: "Consent is Not Enrolled Or Not IN Active State",
    },
  });
  const refusedNotice = await payu.notifyUpcomingDebit({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(`upi:${AUTH_ID}`),
    amountMinor: 1n,
    currency: "INR",
    debitAt,
    idempotencyKey: "pdn:x",
  });
  ok(
    "a refused notice is failed with PayU's words",
    refusedNotice.status === "failed" && /Not Enrolled/.test(refusedNotice.failure?.message ?? ""),
  );
  ok(
    "a notice refused because the mandate is not active is a dead mandate, not retriable",
    refusedNotice.status === "failed" &&
      refusedNotice.failure?.code === "mandate_expired" &&
      refusedNotice.failure?.retriable === false,
  );
  reset({
    pre_debit_SI: (v: string) =>
      JSON.parse(v).action === "Retrieve"
        ? { status: 1, invoiceStatus: "Unpaid" }
        : { status: "E9254", message: "duplicate" },
  });
  const repeat = await payu.notifyUpcomingDebit({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(),
    amountMinor: 1n,
    currency: "INR",
    debitAt,
    idempotencyKey: "pdn:y",
  });
  ok(
    "a repeated card notice that PayU already holds is sent",
    repeat.status === "sent" && calls.length === 2,
  );
  ok(
    "the Retrieve carries a requestId (PayU: requestId is mandatory)",
    !!JSON.parse(calls[1]?.var1 ?? "{}").requestId,
  );
  const upiPeak = payuDebitSchedule(
    new Date("2026-10-25T09:00:00+05:30"),
    new Date("2026-10-27T11:10:00+05:30"),
    48,
    true,
  );
  ok(
    "UPI skips the 10:00–13:00 peak",
    upiPeak.executableAfter.toISOString() === new Date("2026-10-27T13:00:00+05:30").toISOString() &&
      upiPeak.debitDate === "2026-10-27",
  );
  const upiLate = payuDebitSchedule(
    new Date("2026-10-25T23:30:00+05:30"),
    new Date("2026-10-27T23:40:00+05:30"),
    48,
    true,
  );
  ok(
    "a UPI window with under an hour left moves to the next day",
    upiLate.debitDate === "2026-10-28",
  );
  const cardLate = payuDebitSchedule(
    new Date("2026-10-25T23:55:00+05:30"),
    new Date("2026-10-27T23:55:00+05:30"),
    48,
    false,
  );
  ok(
    "a card debit due in the last hour of an IST day moves to the next day (the notice ends at midnight)",
    cardLate.debitDate === "2026-10-28",
  );

  // ── E. renewals ────────────────────────────────────────────────────────────
  const chargeInput = {
    amountMinor: 99_900n,
    currency: "INR",
    customer: { providerKey: "payu" as const, providerCustomerId: CUSTOMER },
    paymentMethod: card(),
    idempotencyKey: "inv_XXXXXXXXXXXX01_attempt_1",
    preDebitNotice: { notificationRef: "tminABC", amountMinor: 99_900n, debitNumber: 1 },
    email: "payer@example.com",
    phone: "+919999999999",
  };
  const rc = payuTxnid("renewal", chargeInput.idempotencyKey);
  const siAnswer = (status: string, field9: string) => () => ({
    status: 1,
    message: "Transaction Processed successfully",
    details: { [rc]: { authpayuid: AUTH_ID, transactionid: rc, amount: "999.00", status, field9 } },
  });
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: siAnswer("captured", "Transaction Completed Successfully"),
  });
  const won = await payu.charge(chargeInput);
  const sv = JSON.parse(calls.find((c) => c.command === "si_transaction")?.var1 ?? "{}") as Record<
    string,
    unknown
  >;
  ok(
    "a captured debit succeeds on our txnid",
    won.status === "succeeded" && won.providerChargeId === rc,
  );
  ok(
    "si_transaction carries the mandate, amount, txnid and the notice's invoice number",
    sv.authpayuid === AUTH_ID &&
      sv.amount === "999.00" &&
      sv.txnid === rc &&
      sv.invoiceDisplayNumber === "tminABC" &&
      sv.phone === "9999999999",
  );
  ok("the charge asked verify_payment before debiting", calls[0]?.command === "verify_payment");
  reset({ verify_payment: (v: string) => found(v, { payment_source: "", status: "success" }) });
  const replay = await payu.charge(chargeInput);
  ok(
    "a retry of a debit PayU already has is answered without a second debit",
    replay.status === "succeeded" && !calls.some((c) => c.command === "si_transaction"),
  );
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: siAnswer("in progress", "92|Transaction Initiated"),
  });
  ok("an in-progress debit is pending", (await payu.charge(chargeInput)).status === "pending");
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: siAnswer("failed", "Invalid/missing card token"),
  });
  const dead = await payu.charge(chargeInput);
  ok(
    "a missing card token is a dead mandate the payer is told about",
    dead.status === "failed" &&
      dead.failure?.code === "mandate_expired" &&
      dead.failure.retriable === false,
  );
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: siAnswer(
      "failed",
      "Mandated SI transactions, consent transaction is not enrolled for SI",
    ),
  });
  const notEnrolled = await payu.charge(chargeInput);
  ok(
    "a debit on a revoked mandate (measured text) is a dead mandate",
    notEnrolled.failure?.code === "mandate_expired" && notEnrolled.failure.retriable === false,
  );
  reset({ verify_payment: (v: string) => notFound(v), si_transaction: siAnswer("", "") });
  ok("a blank status is failed (PayU docs)", (await payu.charge(chargeInput)).status === "failed");
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: { status: 0, msg: "Invalid Hash." },
  });
  const badHash = await payu.charge(chargeInput);
  ok(
    "Invalid Hash is our fault and hidden from the payer",
    badHash.failure?.code === "gateway_request_rejected" &&
      declineHiddenFromPayer(badHash.failure.code),
  );
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: () => {
      throw new TypeError("fetch failed");
    },
  });
  const indeterminate = await rejects(payu.charge(chargeInput), ProviderIndeterminateError);
  ok("a lost debit answer is indeterminate, never failed", indeterminate);
  let reads = 0;
  reset({
    verify_payment: (v: string) =>
      ++reads === 1 ? notFound(v) : found(v, { payment_source: "", amt: "999.00" }),
    si_transaction: () => {
      throw new TypeError("fetch failed");
    },
  });
  ok(
    "a lost debit answer that PayU then lists is booked from the read",
    (await payu.charge(chargeInput)).status === "succeeded",
  );
  ok(
    "a USD renewal fails without a call",
    (await payu.charge({ ...chargeInput, currency: "USD" })).failure?.retriable === false,
  );

  reset({ verify_payment: (v: string) => notFound(v), si_transaction: siAnswer("captured", "") });
  const noNotice = await payu.charge({ ...chargeInput, preDebitNotice: undefined });
  ok(
    "a card debit without a pre-debit notice is refused without calling si_transaction",
    noNotice.status === "failed" && !calls.some((c) => c.command === "si_transaction"),
  );
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: { status: 0, msg: "Something went wrong" },
  });
  ok(
    "an answer with no outcome and no known refusal is indeterminate",
    await rejects(payu.charge(chargeInput), ProviderIndeterminateError),
  );
  for (const http of [409, 429, 502]) {
    reset({ verify_payment: (v: string) => notFound(v) });
    const realStub = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const f = new URLSearchParams(String(init?.body ?? ""));
      if (f.get("command") === "si_transaction")
        return new Response(JSON.stringify({ status: 0, msg: "x" }), { status: http });
      return realStub(url, init);
    }) as typeof fetch;
    const r = await rejects(payu.charge(chargeInput), ProviderIndeterminateError);
    globalThis.fetch = realStub;
    ok(`HTTP ${http} on a debit is indeterminate`, r);
  }
  reset({
    verify_payment: () => {
      throw new TypeError("fetch failed");
    },
    si_transaction: siAnswer("captured", "Transaction Completed Successfully"),
  });
  ok(
    "a failed pre-check read sends no debit: indeterminate, retried later",
    (await rejects(payu.charge(chargeInput), ProviderIndeterminateError)) &&
      !calls.some((c) => c.command === "si_transaction"),
  );
  reset({ verify_payment: (v: string) => notFound(v) });
  ok(
    "locateCharge: PayU has no such txnid → null",
    (await payu.locateCharge({ idempotencyKey: chargeInput.idempotencyKey })) === null &&
      calls[0]?.var1 === rc,
  );
  reset({ verify_payment: (v: string) => found(v, { payment_source: "", amt: "999.00" }) });
  const located = await payu.locateCharge({ idempotencyKey: chargeInput.idempotencyKey });
  ok(
    "locateCharge: the debit made from the key is found",
    located?.status === "succeeded" && located.providerChargeId === rc,
  );
  reset({ verify_payment: (v: string) => notFound(v), si_transaction: siAnswer("captured", "") });
  await payu.charge({ ...chargeInput, email: `${"a".repeat(45)}@example.com` });
  ok(
    "an email over 50 characters is left out of the debit",
    !("email" in JSON.parse(calls.find((c) => c.command === "si_transaction")?.var1 ?? "{}")),
  );

  // ── F. refunds ─────────────────────────────────────────────────────────────
  reset({
    verify_payment: (v: string) =>
      found(v, { payment_source: "payu", amt: "150.00", mihpayid: "20000000020" }),
    cancel_refund_transaction: {
      status: 1,
      msg: "Refund Request Queued",
      request_id: "900000000000000001",
      mihpayid: 20000000020,
      error_code: 102,
    },
  });
  const rf = await payu.refund({
    providerChargeId: "tmpyPAID",
    amountMinor: 12_000n,
    idempotencyKey: "rf_XXXXXXXXXXXX01",
  });
  const rcall = calls.find((c) => c.command === "cancel_refund_transaction");
  ok(
    "a refund posts mihpayid, a ≤ 23 token and decimal rupees",
    rcall?.var1 === "20000000020" &&
      (rcall.form.get("var2") ?? "").length <= 23 &&
      rcall.form.get("var3") === "120.00",
  );
  ok(
    "a queued refund is pending under <txnid>:<token>",
    rf.status === "pending" &&
      rf.providerRefundId === `tmpyPAID:${payuRefundToken("rf_XXXXXXXXXXXX01")}`,
  );
  const token = payuRefundToken("rf_XXXXXXXXXXXX01");
  const list = (status: string) => ({
    status: 1,
    msg: "Refunds fetched successfully.",
    "Refund Details": {
      "20000000020": [
        {
          PayuID: "20000000020",
          RequestID: "900000000000000001",
          RefundToken: token,
          Amount: "120.00",
          Status: status,
        },
      ],
    },
  });
  reset({
    verify_payment: (v: string) =>
      found(v, { payment_source: "payu", amt: "150.00", mihpayid: "20000000020" }),
    cancel_refund_transaction: {
      status: 0,
      msg: "Refund FAILURE - Transactions with same amount and same token not allowed",
      error_code: 227,
    },
    getAllRefundsFromTxnIds: list("queued"),
  });
  const again = await payu.refund({
    providerChargeId: "tmpyPAID",
    amountMinor: 12_000n,
    idempotencyKey: "rf_XXXXXXXXXXXX01",
  });
  ok("a repeated refund finds the one PayU holds", again.status === "pending");
  reset({ getAllRefundsFromTxnIds: list("success") });
  ok(
    "fetchRefundStatus: success → succeeded",
    (await payu.fetchRefundStatus({ providerRefundId: `tmpyPAID:${token}` })).status ===
      "succeeded",
  );
  reset({ getAllRefundsFromTxnIds: list("failure") });
  ok(
    "fetchRefundStatus: failure → failed",
    (await payu.fetchRefundStatus({ providerRefundId: `tmpyPAID:${token}` })).status === "failed",
  );
  reset({ getAllRefundsFromTxnIds: list("success") });
  ok(
    "a refund PayU does not list was never created",
    (await payu.fetchRefundStatus({ providerRefundId: "tmpyPAID:tmrfOTHER" })).status === "failed",
  );
  const paidTxn = (v: string) =>
    found(v, { payment_source: "payu", amt: "150.00", mihpayid: "20000000020" });
  reset({
    verify_payment: paidTxn,
    cancel_refund_transaction: {
      status: 0,
      msg: "Refund amount greater than amount",
      error_code: 105,
    },
    getAllRefundsFromTxnIds: { status: 1, msg: "No Refunds Found" },
  });
  ok(
    "a refund PayU refused and does not list is a refusal",
    await rejects(
      payu.refund({ providerChargeId: "tmpyPAID", amountMinor: 1n, idempotencyKey: "rf3" }),
      ProviderRefusalError,
    ),
  );
  reset({
    verify_payment: paidTxn,
    cancel_refund_transaction: {
      status: 1,
      msg: "Capture is done today, please check for refund status tomorrow",
      error_code: 226,
    },
    getAllRefundsFromTxnIds: { status: 1, msg: "No Refunds Found" },
  });
  const r226 = await payu.refund({
    providerChargeId: "tmpyPAID",
    amountMinor: 1n,
    idempotencyKey: "rf4",
  });
  ok(
    "error_code 226 (documented pending, with a request_id) is pending",
    r226.status === "pending",
  );
  reset({
    verify_payment: paidTxn,
    cancel_refund_transaction: { status: 1, msg: "Refund Request Queued" },
  });
  ok(
    "status 1 with no error_code is pending, never assumed done",
    (await payu.refund({ providerChargeId: "tmpyPAID", amountMinor: 1n, idempotencyKey: "rf6" }))
      .status === "pending",
  );
  reset({ getAllRefundsFromTxnIds: { status: 1, msg: "No Refunds Found" } });
  const young = await payu.fetchRefundStatus({
    providerRefundId: "tmpyPAID:tmrfYOUNG",
    requestedAt: new Date(NOW - 3_600_000),
  });
  const old = await payu.fetchRefundStatus({
    providerRefundId: "tmpyPAID:tmrfOLD",
    requestedAt: new Date(NOW - 3 * 86_400_000),
  });
  ok(
    "an unlisted refund asked for an hour ago is still pending; three days on it was never created",
    young.status === "pending" && old.status === "failed",
  );
  reset({
    verify_payment: paidTxn,
    cancel_refund_transaction: { status: 0, msg: "x" },
    getAllRefundsFromTxnIds: () => {
      throw new TypeError("fetch failed");
    },
  });
  ok(
    "a refusal we cannot check against the list stays pending",
    (await payu.refund({ providerChargeId: "tmpyPAID", amountMinor: 1n, idempotencyKey: "rf5" }))
      .status === "pending",
  );
  reset({ getAllRefundsFromTxnIds: list("REJECTED") });
  ok(
    "fetchRefundStatus: REJECTED → failed",
    (await payu.fetchRefundStatus({ providerRefundId: `tmpyPAID:${token}` })).status === "failed",
  );
  reset({ getAllRefundsFromTxnIds: list("od_hit") });
  ok(
    "fetchRefundStatus: od_hit → pending",
    (await payu.fetchRefundStatus({ providerRefundId: `tmpyPAID:${token}` })).status === "pending",
  );
  reset({ getAllRefundsFromTxnIds: { status: 1, msg: "No Refunds Found" } });
  ok(
    "fetchRefundStatus: No Refunds Found → never created",
    (await payu.fetchRefundStatus({ providerRefundId: `tmpyPAID:${token}` })).status === "failed",
  );
  reset({
    verify_payment: (v: string) => found(v, { payment_source: "", mode: "ENACH", amt: "999.00" }),
  });
  ok(
    "a net banking renewal is not refundable (banks refuse it)",
    await rejects(
      payu.refund({ providerChargeId: rc, idempotencyKey: "rf2" }),
      ProviderRefusalError,
    ),
  );

  // ── G. webhooks ────────────────────────────────────────────────────────────
  const wh = (f: Record<string, string>) => ({
    payload: formBody(f),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const renewalOk = await payu.normalizeWebhook(
    wh(
      paymentPost({
        txnid: rc,
        payment_source: "",
        amount: "999.00",
        udf1: "inv_XXXXXXXXXXXX01_attempt_1",
      }),
    ),
  );
  ok(
    "a renewal success → charge.succeeded on the txnid, ours",
    renewalOk[0]?.type === "charge.succeeded" &&
      renewalOk[0].providerChargeId === rc &&
      renewalOk[0].ownership === "ours" &&
      !renewalOk[0].providerIntentId,
  );
  const stored = (renewalOk[0]?.raw ?? {}) as object;
  ok(
    "the stored webhook keeps neither the key nor the hash",
    !("key" in stored) && !("hash" in stored),
  );
  const renewalFail = await payu.normalizeWebhook(
    wh(
      paymentPost({
        txnid: rc,
        status: "failure",
        unmappedstatus: "failed",
        error: "E706",
        error_Message: "Insufficient funds",
        payment_source: "",
      }),
    ),
  );
  ok(
    "a renewal failure → charge.failed, insufficient_funds, retriable",
    renewalFail[0]?.type === "charge.failed" &&
      renewalFail[0].failureCode === "insufficient_funds" &&
      renewalFail[0].failureRetriable === true &&
      renewalFail[0].providerFailureCode === "E706",
  );
  ok(
    "a pending renewal → charge.pending",
    (
      await payu.normalizeWebhook(
        wh(paymentPost({ txnid: rc, status: "pending", unmappedstatus: "pending" })),
      )
    )[0]?.type === "charge.pending",
  );
  ok(
    "a sist registration → intent.setup_succeeded",
    (await payu.normalizeWebhook(wh(paymentPost({ txnid: "tmsuREG1" }))))[0]?.type ===
      "intent.setup_succeeded",
  );
  ok(
    "a registration paid without a mandate → intent.setup_failed",
    (
      await payu.normalizeWebhook(
        wh(paymentPost({ txnid: "tmsuREG2", payment_source: "payu", error: "E755" })),
      )
    )[0]?.type === "intent.setup_failed",
  );
  const oneOffEv = await payu.normalizeWebhook(
    wh(
      paymentPost({ txnid: oneOff.intentId, payment_source: "payu", mode: "NB", amount: "499.00" }),
    ),
  );
  ok(
    "a one-off success names the intent too",
    oneOffEv[0]?.type === "charge.succeeded" && oneOffEv[0].providerIntentId === oneOff.intentId,
  );
  ok(
    "a txnid we did not mint is foreign",
    normalizePayuPayment({ txnid: "ORDER_123", status: "success", mihpayid: "1" }).ownership ===
      "foreign",
  );
  ok(
    "a tampered webhook is refused",
    await rejects(payu.normalizeWebhook(wh({ ...paymentPost({ txnid: rc }), amount: "5.00" }))),
  );
  const a1 = payu.webhookEventId(wh(paymentPost({ txnid: rc })));
  ok(
    "event id: same delivery, same id; other status, other id",
    a1 === payu.webhookEventId(wh(paymentPost({ txnid: rc }))) &&
      a1 !== payu.webhookEventId(wh(paymentPost({ txnid: rc, status: "failure" }))) &&
      a1.startsWith("payu:payment:"),
  );

  const refundHook = JSON.stringify({
    bank_arn: null,
    refund_mode: "Back to Source",
    bank_ref_num: "1",
    key: KEY,
    amt: "120.00",
    remark: null,
    status: "success",
    token,
    mihpayid: " 20000000020 ",
    request_id: "900000000000000001",
    merchantTxnId: "tmpyPAID",
    action: "refund",
  });
  reset({
    getAllRefundsFromTxnIds: {
      status: 1,
      "Refund Details": {
        "20000000020": [
          {
            RequestID: "900000000000000001",
            RefundToken: token,
            Amount: "120.00",
            Status: "success",
          },
          {
            RequestID: "900000000000000002",
            RefundToken: "tmrfEARLIER",
            Amount: "10.00",
            Status: "success",
          },
        ],
      },
    },
  });
  const rEv = await payu.normalizeWebhook({ payload: refundHook, headers: {} });
  ok(
    "a refund webhook is confirmed with PayU, each listed refund at its own amount",
    rEv[0]?.type === "charge.refunded" &&
      rEv[0].providerChargeId === "tmpyPAID" &&
      rEv[0].amountRefundedMinor === undefined &&
      rEv[0].providerRefundId === `tmpyPAID:${token}` &&
      JSON.stringify(
        rEv[0].refunds?.map((x) => [x.providerRefundId, String(x.amountMinor), x.status]),
      ) ===
        JSON.stringify([
          [`tmpyPAID:${token}`, "12000", "succeeded"],
          ["tmpyPAID:tmrfEARLIER", "1000", "succeeded"],
        ]),
  );
  const dashboardHook = JSON.stringify({
    ...JSON.parse(refundHook),
    token: "",
    request_id: "900000000000000002",
  });
  reset({
    getAllRefundsFromTxnIds: {
      status: 1,
      "Refund Details": {
        "20000000020": [
          { RequestID: "900000000000000002", RefundToken: "", Amount: "10.00", Status: "success" },
        ],
      },
    },
  });
  const dEv = await payu.normalizeWebhook({ payload: dashboardHook, headers: {} });
  ok(
    "a refund with no token of ours (dashboard) is keyed by PayU's request id",
    dEv[0]?.providerRefundId === "tmpyPAID:rq900000000000000002" &&
      dEv[0].refunds?.[0]?.amountMinor === 1_000n,
  );
  ok(
    "a refund post naming another merchant key is refused",
    await rejects(
      payu.normalizeWebhook({
        payload: JSON.stringify({ ...JSON.parse(refundHook), key: "otherKey" }),
        headers: {},
      }),
    ),
  );
  reset({
    getAllRefundsFromTxnIds: () => {
      throw new TypeError("fetch failed");
    },
  });
  const unres = await payu.normalizeWebhook({ payload: refundHook, headers: {} });
  ok(
    "a refund post PayU cannot be asked about is unresolved, not refused",
    !!unres[0]?.unresolved && unres[0].refunds === undefined,
  );
  const autoRefund = normalizePayuPayment({
    txnid: rc,
    status: "failure",
    unmappedstatus: "autoRefund",
    mihpayid: "1",
    amount: "999.00",
  });
  ok(
    "autoRefund is a late reversal with the request's amount",
    autoRefund.type === "charge.failed" &&
      autoRefund.lateReversal === true &&
      autoRefund.amountMinor === 99_900n,
  );
  reset({ getAllRefundsFromTxnIds: { status: 1, "Refund Details": { "1": [] } } });
  ok(
    "an unsigned refund PayU does not confirm is refused",
    await rejects(payu.normalizeWebhook({ payload: refundHook, headers: {} })),
  );
  ok(
    "refund event ids carry the request id and status",
    payu.webhookEventId({ payload: refundHook, headers: {} }) ===
      "payu:refund:900000000000000001:success:",
  );

  const mEv = await payu.normalizeWebhook({ payload: JSON.stringify(mandateBody), headers: {} });
  ok(
    "a signed card mandate cancellation → mandate_updated cancelled on card:<id>",
    mEv[0]?.type === "payment_method.mandate_updated" &&
      mEv[0].providerPaymentMethodId === `card:${AUTH_ID}` &&
      mEv[0].mandate?.status === "cancelled",
  );
  ok(
    "a tampered card mandate webhook is refused",
    await rejects(
      payu.normalizeWebhook({
        payload: JSON.stringify({ ...mandateBody, status: "active" }),
        headers: {},
      }),
    ),
  );
  reset({
    NB_mandate_status: { status: "CANCEL_SUCCESS", action: "NB_mandate_status", amount: "5000.00" },
  });
  const nbEv = await payu.normalizeWebhook({
    payload: JSON.stringify({
      statusCode: 1,
      notificationType: "MANDATE_CANCELLATION",
      status: "CANCEL_SUCCESS",
      authPayuId: AUTH_ID,
    }),
    headers: {},
  });
  ok(
    "an unsigned net banking cancellation is read back from PayU",
    nbEv[0]?.type === "payment_method.mandate_updated" &&
      nbEv[0].providerPaymentMethodId === `nb:${AUTH_ID}` &&
      nbEv[0].mandate?.status === "cancelled" &&
      calls[0]?.command === "NB_mandate_status",
  );
  ok(
    "a dispute (unsigned, nothing to read back) is kept as unknown",
    (
      await payu.normalizeWebhook({
        payload: JSON.stringify({
          type: "payments",
          event: "dispute",
          cb_id: 1,
          txn_id: "tmpyPAID",
          cb_status: "New",
          updated_at: "x",
        }),
        headers: {},
      })
    )[0]?.type === "unknown",
  );

  // ── H2. UPI AutoPay ────────────────────────────────────────────────────────
  ok(
    "UPI mandate words: pause → paused, revoked → cancelled, active → confirmed",
    payuMandateStatus("pause") === "paused" &&
      payuMandateStatus("revoked") === "cancelled" &&
      payuMandateStatus("active") === "confirmed",
  );
  const upiHook = (status: string, action: string, salt = SALT) => {
    const b: Record<string, string> = {
      status,
      authpayuid: AUTH_ID,
      action,
      dateTime: "2026-10-30 18:18:21",
      amount: "100.00",
      endDate: "2036-10-30 00:00:00",
      mandateNumber: "upimandate0001@testbank",
      key: KEY,
      udf1: "",
    };
    return { ...b, hash: payuUpiMandateWebhookHash(salt, b) };
  };
  const paused = await payu.normalizeWebhook({
    payload: JSON.stringify(upiHook("pause", "MANDATE_PAUSE")),
    headers: {},
  });
  ok(
    "a signed UPI pause post → mandate_updated, upi:<authpayuid>, paused",
    paused[0]?.type === "payment_method.mandate_updated" &&
      paused[0].providerPaymentMethodId === `upi:${AUTH_ID}` &&
      paused[0].mandate?.status === "paused" &&
      paused[0].mandate.rail === "upi" &&
      paused[0].providerEventId.startsWith(`payu:upi-mandate:${AUTH_ID}:MANDATE_PAUSE:`),
  );
  const revokedForm = await payu.normalizeWebhook({
    payload: formBody(upiHook("revoked", "MANDATE_REVOKE")),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  ok(
    "the same post as a form (the reference says HTTP form) is read too",
    revokedForm[0]?.mandate?.status === "cancelled",
  );
  ok(
    "a UPI mandate post hashed with another salt is refused",
    await rejects(
      payu.normalizeWebhook({
        payload: JSON.stringify(upiHook("revoked", "MANDATE_REVOKE", "wrong")),
        headers: {},
      }),
    ),
  );
  const upiFirst = await payu.createIntent({
    purpose: "setup",
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    idempotencyKey: "pi_create_pi_XXXXXXXXXXXX07_a1",
    contact: { email: "payer@example.com", phone: "+91 99999 99999", name: "Test Payer" },
    returnUrl: "https://pay.example.com/r",
    methodTypes: ["upi"],
    maxAmountMinor: 10_000n,
    firstChargeMinor: 10_000n,
  });
  const uf = upiFirst.authorization?.formPost?.fields ?? {};
  const usi = JSON.parse(uf.si_details ?? "{}") as Record<string, unknown>;
  ok(
    "a UPI first-charge registration: the page takes UPI only, amount = billing amount (₹100)",
    uf.enforce_paymethod === "upi" &&
      uf.amount === "100.00" &&
      usi.billingAmount === "100.00" &&
      uf.udf3 === "tmfirst" &&
      payu.capabilities.setupCollectsFirstCharge?.includes("upi") === true,
  );
  reset({
    verify_payment: (v: string) => notFound(v),
    si_transaction: {
      status: 1,
      message: "Transaction Processed successfully",
      details: {
        [payuTxnid("renewal", "inv_upi_1")]: {
          status: "in progress",
          field9: "92|Transaction Initiated",
        },
      },
    },
  });
  const upiDebit = await payu.charge({
    amountMinor: 10_000n,
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(`upi:${AUTH_ID}`),
    idempotencyKey: "inv_upi_1",
    preDebitNotice: { notificationRef: "tminUPI", amountMinor: 10_000n, debitNumber: 1 },
  });
  ok(
    "a UPI debit answered in progress is pending (settled by webhook)",
    upiDebit.status === "pending",
  );

  // Notice refusals on UPI (pre_debit_notification_api error table, read 2026-10-30).
  const upiNotice = async (answer: unknown) => {
    reset({ pre_debit_SI: answer });
    return payu.notifyUpcomingDebit({
      customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
      paymentMethod: card(`upi:${AUTH_ID}`),
      amountMinor: 10_000n,
      currency: "INR",
      debitAt: new Date(NOW + 49 * 3_600_000),
      idempotencyKey: `upi_notice_${Math.random()}`,
    });
  };
  const qc = await upiNotice({
    status: "QC",
    action: "MANDATE_PRE_DEBIT",
    message: "MANDATE HAS BEEN REVOKED",
  });
  ok(
    "a notice refused with status QC (bank/NPCI) is a dead mandate, final, not retriable",
    qc.status === "failed" &&
      qc.failure?.code === "mandate_expired" &&
      qc.failure.retriable === false &&
      qc.failure.final === true,
  );
  const dup = await upiNotice({
    status: "E9254",
    action: "MANDATE_PRE_DEBIT",
    message: "Predebit notification already sent for the mandate sequence no.:2",
  });
  const exe = await upiNotice({
    status: "E9256",
    action: "MANDATE_PRE_DEBIT",
    message: "Execution already sent for the mandate sequence no.:2",
  });
  ok(
    "E9254 / E9256 → pre_debit_cycle_open, retriable (an open cycle, not a dead mandate)",
    dup.failure?.code === "pre_debit_cycle_open" &&
      dup.failure.retriable &&
      exe.failure?.code === "pre_debit_cycle_open",
  );
  const period = await upiNotice({
    status: "E9263",
    action: "MANDATE_PRE_DEBIT",
    message: "Predebit for calculated sequence sent during incorrect period",
  });
  ok("E9263 → pre_debit_not_due (timing)", period.failure?.code === "pre_debit_not_due");
  const far = await upiNotice({
    status: "E9260",
    action: "MANDATE_PRE_DEBIT",
    message: "Predebit notification can only be sent for a maximum 30 days in advance.",
  });
  const seq = await upiNotice({
    status: 0,
    message: "Invalid value for mandateSeqNo",
    action: "MANDATE_PRE_DEBIT",
  });
  ok(
    "E9260 and an invalid mandateSeqNo are our request → gateway_request_rejected",
    far.failure?.code === "gateway_request_rejected" &&
      seq.failure?.code === "gateway_request_rejected",
  );
  reset({
    pre_debit_SI: {
      status: 1,
      action: "MANDATE_PRE_DEBIT",
      message: "Pre Debit deleted successfully",
    },
  });
  const withdrawn = await payu.withdrawPreDebitNotice({
    paymentMethod: card(`upi:${AUTH_ID}`),
    notificationRef: "tminUPI0001",
    amountMinor: 10_000n,
    debitAt: new Date("2026-10-27T13:00:00+05:30"),
  });
  const del = JSON.parse(calls[0]?.var1 ?? "{}") as Record<string, unknown>;
  ok(
    "a UPI notice is withdrawn with action Delete, by authpayuid and invoice number, with its amount and debit date (PayU asks for both)",
    withdrawn === "withdrawn" &&
      del.action === "Delete" &&
      del.amount === "100.00" &&
      del.debitDate === "2026-10-27" &&
      del.authpayuid === AUTH_ID &&
      del.invoiceDisplayNumber === "tminUPI0001",
  );
  reset({});
  ok(
    "a card notice needs no withdrawal (no call)",
    (await payu.withdrawPreDebitNotice({
      paymentMethod: card(`card:${AUTH_ID}`),
      notificationRef: "tminCARD01",
      amountMinor: 10_000n,
      debitAt: new Date(NOW),
    })) === "not_needed" && calls.length === 0,
  );
  ok(
    "capabilities: one open notice per UPI mandate; UPI capped at ₹15,000 per debit",
    payu.capabilities.preDebitNotice?.oneOpenPerMandate?.join() === "upi" &&
      payu.capabilities.mandateCeilingCapMinor?.upi === 1_500_000n &&
      GATEWAYS.payu.mandateCeilingCapMinor?.upi === 1_500_000,
  );
  const slackAm = payuDebitSchedule(
    new Date("2026-10-25T09:45:00+05:30"),
    new Date("2026-10-27T09:45:00+05:30"),
    48,
    true,
  );
  const slackPm = payuDebitSchedule(
    new Date("2026-10-25T16:40:00+05:30"),
    new Date("2026-10-27T16:40:00+05:30"),
    48,
    true,
  );
  ok(
    "a UPI debit that could run into a blocked hour (margin + tick) moves past it: 09:45 → 13:00, 16:40 → 21:30",
    slackAm.executableAfter.toISOString() === new Date("2026-10-27T13:00:00+05:30").toISOString() &&
      slackPm.executableAfter.toISOString() === new Date("2026-10-27T21:30:00+05:30").toISOString(),
  );
  const live = new PayuProvider({
    merchantKey: KEY,
    merchantSalt: SALT,
    livemode: true,
    postserviceUrl: POST,
    now: () => Date.parse("2026-10-27T11:00:00+05:30"),
  });
  reset({});
  const blocked = await live.charge({
    amountMinor: 10_000n,
    currency: "INR",
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(`upi:${AUTH_ID}`),
    idempotencyKey: "inv_upi_peak",
    preDebitNotice: { notificationRef: "tminUPI", amountMinor: 10_000n, debitNumber: 1 },
  });
  ok(
    "a live UPI debit inside 10:00–13:00 IST is not sent: not due, retried after 13:00",
    blocked.status === "failed" &&
      blocked.failure?.code === "pre_debit_not_due" &&
      blocked.failure.retryAfterMs === 2 * 3_600_000 + 60_000 &&
      calls.length === 0,
  );
  ok(
    "a UPI first payment above ₹15,000 is refused, not registered",
    await rejects(
      payu.createIntent({
        purpose: "setup",
        currency: "INR",
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        idempotencyKey: "pi_create_pi_XXXXXXXXXXXX08_a1",
        contact: { email: "payer@example.com", phone: "+91 99999 99999", name: "Test Payer" },
        returnUrl: "https://pay.example.com/r",
        methodTypes: ["upi"],
        maxAmountMinor: 2_600_000n,
        firstChargeMinor: 2_000_000n,
      }),
      ProviderRefusalError,
    ),
  );
  const startDate = "2026-10-30 00:00:00";
  const upiHookAt = (status: string, action: string, extra: Record<string, string>) => {
    const b: Record<string, string> = {
      status,
      authpayuid: AUTH_ID,
      action,
      dateTime: startDate,
      amount: "100.00",
      endDate: "2036-10-30 00:00:00",
      ...extra,
    };
    return { ...b, hash: payuUpiMandateWebhookHash(SALT, b) };
  };
  const p1 = await payu.normalizeWebhook({
    payload: JSON.stringify(upiHookAt("pause", "MANDATE_PAUSE", { pauseStartDate: "2026-11-01" })),
    headers: {},
  });
  const p2 = await payu.normalizeWebhook({
    payload: JSON.stringify(upiHookAt("pause", "MANDATE_PAUSE", { pauseStartDate: "2026-11-10" })),
    headers: {},
  });
  ok(
    "UPI mandate posts: no key needed; two pauses with one start date stay two events; time = receipt",
    p1[0]?.mandate?.status === "paused" &&
      p1[0].providerEventId !== p2[0]?.providerEventId &&
      p1[0].occurredAt.getTime() > Date.parse("2026-10-30T00:00:00+05:30") + 3_600_000,
  );

  // ── H. mandates ────────────────────────────────────────────────────────────
  ok(
    "mandate statuses map onto ours",
    payuMandateStatus("active") === "confirmed" &&
      payuMandateStatus("SUCCESS") === "confirmed" &&
      payuMandateStatus("paused") === "paused" &&
      payuMandateStatus("deleted") === "cancelled" &&
      payuMandateStatus("CANCEL_SUCCESS") === "cancelled" &&
      payuMandateStatus("failed") === "rejected" &&
      payuMandateStatus("INITIATED") === "initiated" &&
      payuMandateStatus("Mandate entry not found") === undefined,
  );
  reset({
    upi_mandate_status: {
      status: "active",
      action: "MANDATE_STATUS",
      authpayuid: AUTH_ID,
      amount: "1500.00",
      mandateEndDate: "2036-10-25",
    },
  });
  const m = await payu.fetchMandate({ providerCustomerId: CUSTOMER, token: `upi:${AUTH_ID}` });
  ok(
    "fetchMandate asks the rail's own command and reads the ceiling",
    calls[0]?.command === "upi_mandate_status" &&
      m?.maxAmountMinor === 150_000n &&
      m.status === "confirmed",
  );
  reset({ check_mandate_status: { status: 0, message: "Consent is Not Mandated" } });
  ok(
    "no mandate at PayU is null, not dead",
    (await payu.fetchMandate({ providerCustomerId: CUSTOMER, token: `card:${AUTH_ID}` })) === null,
  );
  reset({ upi_mandate_revoke: { status: 1, message: "Mandate Revoked Successfully" } });
  await payu.deletePaymentMethod({
    customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
    paymentMethod: card(`upi:${AUTH_ID}`),
  });
  ok("UPI revokes with upi_mandate_revoke", calls[0]?.command === "upi_mandate_revoke");
  reset({
    mandate_revoke: { status: 0, message: "Mandate not in appropriate state to perform action" },
    check_mandate_status: { status: "active" },
  });
  ok(
    "a revoke PayU refuses on a live mandate throws",
    await rejects(
      payu.deletePaymentMethod({
        customer: { providerKey: "payu", providerCustomerId: CUSTOMER },
        paymentMethod: card(),
      }),
    ),
  );
  ok(
    "instrument ids parse",
    JSON.stringify(parsePayuInstrument("nb:123")) === '{"rail":"nb","authpayuid":"123"}' &&
      parsePayuInstrument("pm_x") === null,
  );

  // ── I. declines ────────────────────────────────────────────────────────────
  const d = (code: string | null, message: string | null = null) =>
    normalizePayuDecline({ code, message });
  ok(
    "E706 → insufficient_funds, retriable",
    d("E706").code === "insufficient_funds" && d("E706").retriable,
  );
  ok("E311 → expired_card, terminal", d("E311").code === "expired_card" && !d("E311").retriable);
  ok(
    "UPI debit after a revoke → mandate_expired, terminal",
    d(null, "Mandate is already revoked").code === "mandate_expired" &&
      !d(null, "Mandate is already revoked").retriable,
  );
  ok("E324 → fraudulent, terminal", d("E324").code === "fraudulent" && !d("E324").retriable);
  ok(
    "E755 → recurring_not_enabled, terminal, told to the payer",
    d("E755").code === "recurring_not_enabled" &&
      !d("E755").retriable &&
      d("E755").exposedToPayer === true,
  );
  ok("E4111 → mandate_expired", d("E4111").code === "mandate_expired");
  ok("E1203 → mandate_ceiling_exceeded", d("E1203").code === "mandate_ceiling_exceeded");
  ok(
    "E4112 (amount ≠ notice) is ours",
    d("E4112").code === "gateway_request_rejected" && d("E4112").exposedToPayer === false,
  );
  ok(
    "'entry not found in si_txn' → payment_method_not_found",
    d(null, "entry not found in si_txn").code === "payment_method_not_found",
  );
  ok(
    "an unmapped code passes through, retriable",
    d("E9999").code === "E9999" && d("E9999").retriable,
  );
  ok("no code and no message → charge_failed", d(null).code === "charge_failed");
  ok(
    "the PayU set is registered",
    DECLINE_SETS.payu.rules.length > 0 && Object.keys(DECLINE_SETS.payu.table).length > 0,
  );
  ok(
    "every PayU rule id is namespaced",
    DECLINE_SETS.payu.rules.every((r) => /^payu\.[a-z_]+\.[a-z0-9_]+$/.test(r.id)),
  );

  // ── J. catalogue and factory ───────────────────────────────────────────────
  const def = GATEWAYS.payu;
  ok(
    "catalogue: PayU, merchant_key + merchant_salt",
    def.displayName === "PayU" &&
      def.credentialFields.map((f) => f.key).join(",") === "merchant_key,merchant_salt",
  );
  ok(
    "webhooks are signed with the salt (credential) and the account id rides in the path",
    def.webhook.secret === "credential" && def.webhook.accountIdInPath === true,
  );
  ok(
    "INR-bound rails, phone required, no customer ids",
    def.currencyBoundMethods?.upi === "INR" &&
      def.recurringNeedsPhone === true &&
      def.noCustomerIds === true,
  );
  ok(
    "UPI and net banking settle asynchronously",
    JSON.stringify(def.settlement.asyncMethods) === '["upi","bank_transfer"]',
  );
  const built = GATEWAY_FACTORIES.payu.build(
    { merchant_key: " k ", merchant_salt: "s" },
    { businessId: "b", livemode: false },
  );
  ok(
    "the factory builds from the setup fields",
    built.key === "payu" &&
      JSON.stringify(built.capabilities.methods) === JSON.stringify(def.advertisedMethods),
  );
  ok(
    "missing credentials are a resolve error",
    throwsSync(() =>
      GATEWAY_FACTORIES.payu.build({ merchant_key: "k" }, { businessId: "b", livemode: false }),
    ) &&
      (() => {
        try {
          GATEWAY_FACTORIES.payu.build({}, { businessId: "b", livemode: false });
          return false;
        } catch (e) {
          return e instanceof GatewayResolveError;
        }
      })(),
  );
  ok(
    "capabilities: form-post return, intent status, no void",
    payu.capabilities.buyerReturnByPost === true &&
      payu.capabilities.intentStatus === true &&
      payu.capabilities.intentVoid === false &&
      payu.capabilities.mandates === true,
  );
  ok(
    "amounts are exact",
    toPayuAmount(1n) === "0.01" &&
      toPayuAmount(99_900n) === "999.00" &&
      fromPayuAmount("999.00") === 99_900n &&
      fromPayuAmount("10.5") === 1_050n &&
      fromPayuAmount(150) === 15_000n,
  );
  ok(
    "txnids are ≤ 25 alphanumeric and keep their kind",
    ["setup", "payment", "renewal"].every((k) => {
      const t = payuTxnid(k as "setup", "a-very-long-idempotency-key-that-cannot-fit:1");
      return /^[A-Za-z0-9]{1,25}$/.test(t) && payuTxnKind(t) === k;
    }),
  );
  ok("refund tokens are ≤ 23", payuRefundToken("x".repeat(80)).length <= 23);

  await flushGatewayRequestLogs();
  globalThis.fetch = realFetch;
  let failedCount = 0;
  for (const [label, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${!pass && detail ? `  (${detail})` : ""}`);
    if (!pass) failedCount++;
  }
  console.log(`\n${checks.length - failedCount}/${checks.length} passed`);
  console.log(failedCount ? "❌ PAYU: FAIL" : "✅ PAYU: PASS");
  await closeDb();
  process.exit(failedCount ? 1 : 0);
}

await main();
