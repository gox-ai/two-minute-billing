/**
 * RazorPay CHECKOUT-side helpers for the live verification suites.
 *
 * Everything here talks to `/payments/create/ajax` and the auto-submitting form
 * chain behind it — RazorPay's browser surface, not their REST API. It is
 * deliberately separate from `src/providers/razorpay.ts`: the engine never drives
 * Checkout (a buyer's browser does), so this logic belongs to the harnesses that
 * have to *stand in* for that browser, and to nothing that ships.
 *
 * Extracted from `scripts/verify-razorpay-live.ts` so the Pro-amount suite does not
 * re-derive it. Both the throttle handling and the challenge walk below cost real
 * debugging time; a second copy is how that knowledge rots out of one of them.
 * ⚠️ `verify-razorpay-live.ts` still carries its own copies — it was mid-change when
 * this was extracted. Fold it onto these when that branch settles.
 */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test-mode OTP: RazorPay accepts any 4–10 digit code as success. */
export const TEST_OTP = "1234";

/**
 * RazorPay's OWN published test cards, from
 * https://razorpay.com/docs/payments/payments/test-card-details (read 2026-07-30).
 *
 * Use these and nothing else. A generic number like `4111111111111111` is on none of
 * their lists: it charges fine (flagged `international: true`, so the domestic path
 * was never covered) but is INELIGIBLE FOR RECURRING, and RazorPay reports that as
 * `recurring_payment_not_enabled` — an error about the merchant, for a problem with
 * the card.
 *
 * `domestic` is what RazorPay reports as `international: false` on the payment.
 */
export const TEST_CARDS = {
  domesticVisaDebit: { number: "4100280000001007", label: "domestic Visa debit", domestic: true },
  domesticMcCredit: {
    number: "5555510000081006",
    label: "domestic Mastercard credit",
    domestic: true,
  },
  domesticRupayCredit: {
    number: "6527658900001005",
    label: "domestic RuPay credit",
    domestic: true,
  },
  /** "Test Cards for Subscriptions" — the only ones eligible for a card MANDATE. */
  subsDomesticVisa: {
    number: "4718609108204366",
    label: "subscriptions domestic Visa credit",
    domestic: true,
  },
} as const;

export function basicAuth(keyId: string, keySecret: string): string {
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

/**
 * Walk the auto-submitting form chain a browser would post through for a REDIRECT
 * challenge (3DS on cards, the mock bank page on netbanking): RazorPay's page → its
 * `mocksharp` test-mode bank page → callback. The bank page's Success button only
 * copies its `data-val` into a hidden `success` field, so setting `success=S` is
 * exactly what clicking it does.
 *
 * Skipping this on a MANDATE registration is subtle and costly: the token is still
 * minted, but the payment stays `created` and the token never reaches
 * `recurring_details.status: confirmed`, so the first off-session debit fails
 * `token_not_eligible` — a symptom that looks nothing like "you forgot the browser
 * step".
 *
 * ⚠️ `seed` is `request.content` from the ajax response and is NOT optional in
 * practice — it just happens to be absent on the card redirect. NETBANKING returns
 * `type: 'first'` with the first hop's fields in `request.content`, and posting that
 * hop with an empty body answers
 *   {"error":{"description":"Input fields not set properly", …}}
 * after which the payment sits at `created` forever. That reads exactly like a rail
 * that cannot take the payment — the payment id is real, nothing errors, the status
 * is simply never `captured` — which is why it is called out here rather than left
 * to whoever debugs it next.
 */
export async function walkChallengeChain(
  url: string,
  httpMethod?: string,
  seed?: Record<string, unknown>,
): Promise<void> {
  const seedBody = new URLSearchParams();
  for (const [k, v] of Object.entries(seed ?? {})) seedBody.append(k, String(v));
  let html = await fetch(url, {
    method: httpMethod === "get" ? "GET" : "POST",
    ...(seed
      ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: seedBody }
      : {}),
  }).then((r) => r.text());
  for (let hop = 0; hop < 6; hop++) {
    const form = html.match(/<form[\s\S]*?<\/form>/i)?.[0];
    const action = form?.match(/action=["']([^"']+)["']/i)?.[1];
    if (!form || !action) break;
    const body = new URLSearchParams();
    // ⚠️ Parse name and value SEPARATELY, and keep valueless inputs.
    //
    // A single regex requiring `value=` silently drops `<input type="hidden"
    // name="emandate_success">` — the field the e-mandate page expects the button to
    // fill in — so the very fields that decide the mock bank's verdict were the ones
    // being discarded. A form field with no value attribute is still a form field.
    for (const tag of form.matchAll(/<input\b[^>]*>/gi)) {
      const name = tag[0].match(/\bname=["']([^"']+)["']/i)?.[1];
      if (!name) continue;
      body.append(name, tag[0].match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "");
    }
    // ⚠️ Set EVERY `*success` field the mock bank page offers, not just `success`.
    //
    // The page's buttons only copy their `data-val` into hidden inputs, so writing the
    // field is exactly what clicking does. But the E-MANDATE page carries TWO of them —
    // `success` and `emandate_success` — matching its three buttons:
    //     Success (S) · "Payment successful but e-Mandate failed" (M) · Failure (F)
    // Setting only `success` therefore selects the MIDDLE button. The registration then
    // reports `status: captured` with a real token id, and that token comes back
    // `recurring: false, recurring_details.status: "rejected", failure_reason:
    // "Rejected by bank"` — a mandate that looks registered and can never be debited.
    // Measured 2026-08-19: the first off-session debit against it fails with
    // "The bank_account field is required when method is emandate", which reads as an
    // adapter bug and is not one.
    if (/mocksharp\/payment\/submit/.test(action)) {
      for (const name of [...body.keys()]) {
        if (/success$/i.test(name)) body.set(name, "S");
      }
      if (!body.has("success")) body.set("success", "S");
    }
    html = await fetch(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }).then((r) => r.text());
  }
}

export type CheckoutAttempt =
  | { ok: true; json: any }
  | { ok: false; throttled: boolean; detail: string };

/**
 * POST to `/payments/create/ajax`, RazorPay's CHECKOUT endpoint, with rate-limit
 * tolerance.
 *
 * This endpoint is throttled far more tightly than the REST API and it does not
 * report throttling in JSON: it answers HTTP 403 with an nginx HTML page, or a JSON
 * body whose only clue is `Too many requests`. A throttled run *looks exactly like a
 * merchant that refuses the card*, so an exhausted budget says THROTTLED rather than
 * returning a refusal the caller would read as a verdict.
 *
 * A THROTTLE and an EDGE BLOCK arrive at the same door and mean opposite things, so
 * they are separated by evidence rather than lumped under "403 = try later":
 *   • 429, or a body saying `Too many requests` → genuinely rate-limited; backing off
 *     can clear it.
 *   • 403 with an nginx HTML page → NOT a throttle. On this account it tracks the
 *     CARD (international BINs), so no amount of waiting helps.
 */
export async function postCheckoutAjax(
  apiBase: string,
  body: URLSearchParams,
): Promise<CheckoutAttempt> {
  const backoffMs = [8_000, 20_000, 45_000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${apiBase}/payments/create/ajax`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const snippet = raw.slice(0, 160).replace(/\s+/g, " ");
    const rateLimited = res.status === 429 || /too many requests/i.test(raw);
    const edgeBlocked = res.status === 403 && /<html/i.test(raw);
    if (edgeBlocked) {
      return {
        ok: false,
        throttled: true,
        detail:
          `BLOCKED at RazorPay's edge (HTTP 403, nginx HTML — not a throttle, not a JSON ` +
          `refusal): ${snippet}`,
      };
    }
    if (!rateLimited) {
      if (json) return { ok: true, json };
      return {
        ok: false,
        throttled: false,
        detail: `non-JSON response (HTTP ${res.status}): ${snippet}`,
      };
    }
    if (attempt >= backoffMs.length) {
      return {
        ok: false,
        throttled: true,
        detail: `THROTTLED by RazorPay after ${attempt + 1} attempts (HTTP ${res.status}): ${snippet}`,
      };
    }
    await sleep(backoffMs[attempt]!);
  }
}

export interface RailContext {
  apiBase: string;
  keyId: string;
  auth: string;
  email: string;
  contact: string;
}

/**
 * RazorPay REFUSED, definitively, with a reason — as opposed to a throttle, an edge
 * block, or a harness bug.
 *
 * Distinct from a plain `Error` so a caller can tell "the gateway answered no" from
 * "we never got an answer". A refusal is a MEASUREMENT and belongs in a results
 * table; a missing answer must never be recorded as one. (An account's maximum
 * payment amount arrives this way, at order creation, before any rail is involved.)
 */
export class GatewayRefusalError extends Error {
  constructor(
    readonly description: string,
    readonly httpStatus: number,
  ) {
    super(description);
    this.name = "GatewayRefusalError";
  }
}

/** Create an auto-capturing order — the shape a one-off "pay now" rides. */
async function createCaptureOrder(
  ctx: RailContext,
  currency: string,
  amountMinor: number,
  receipt: string,
): Promise<{ id: string }> {
  const res = await fetch(`${ctx.apiBase}/orders`, {
    method: "POST",
    headers: { Authorization: ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountMinor, currency, payment_capture: true, receipt }),
  });
  const json = (await res.json()) as { id?: string; error?: { description?: string } };
  if (!json.id) {
    const description = json?.error?.description ?? JSON.stringify(json).slice(0, 160);
    // A 4xx here is the account answering about the AMOUNT — every rail is downstream
    // of it, so this is the one refusal that is not about a rail at all.
    if (res.status >= 400 && res.status < 500)
      throw new GatewayRefusalError(description, res.status);
    throw new Error(`order failed (HTTP ${res.status}): ${description}`);
  }
  return { id: json.id };
}

export interface CaptureResult {
  paymentId: string;
  status: string;
  captured: boolean;
  amountMinor: number;
  currency: string;
  international: boolean;
  method: string;
}

async function readPayment(ctx: RailContext, paymentId: string): Promise<CaptureResult> {
  const p = (await fetch(`${ctx.apiBase}/payments/${paymentId}`, {
    headers: { Authorization: ctx.auth },
  }).then((r) => r.json())) as Record<string, unknown>;
  return {
    paymentId,
    status: String(p.status),
    captured: Boolean(p.captured),
    amountMinor: Number(p.amount ?? 0),
    currency: String(p.currency),
    international: Boolean(p.international),
    method: String(p.method ?? ""),
  };
}

/**
 * One-off CARD payment, buyer-present, driven all the way to captured.
 *
 * Two challenge shapes are handled because RazorPay picks per card: domestic credit
 * cards take an INLINE OTP branch (`type: 'otp'` + `submit_url`), everything else
 * takes the redirect chain. Without the OTP branch the suite could only ever cover
 * no-challenge cards.
 */
export async function cardCapture(
  ctx: RailContext,
  currency: string,
  amountMinor: number,
  cardNumber: string,
): Promise<CaptureResult> {
  const order = await createCaptureOrder(ctx, currency, amountMinor, `paynow_card_${Date.now()}`);
  const attempt = await postCheckoutAjax(
    ctx.apiBase,
    new URLSearchParams({
      key_id: ctx.keyId,
      amount: String(amountMinor),
      currency,
      order_id: order.id,
      email: ctx.email,
      contact: ctx.contact,
      method: "card",
      "card[number]": cardNumber,
      "card[expiry_month]": "12",
      "card[expiry_year]": "30",
      "card[cvv]": "123",
      "card[name]": "Pro Amount Buyer",
    }),
  );
  if (!attempt.ok) throw new Error(`card payment not initiated — ${attempt.detail}`);
  const created: {
    payment_id?: string;
    type?: string;
    submit_url?: string;
    request?: {
      url?: string;
      http_method?: string;
      method?: string;
      content?: Record<string, unknown>;
    };
    error?: { description?: string };
  } = attempt.json;
  if (!created.payment_id) {
    throw new Error(
      `card payment not initiated: ${created.error?.description ?? JSON.stringify(created).slice(0, 160)}`,
    );
  }

  if (created.type === "otp" && created.submit_url) {
    await fetch(created.submit_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ otp: TEST_OTP }),
    }).then((r) => r.text());
    return readPayment(ctx, created.payment_id);
  }
  if (!created.request?.url) throw new Error(`unhandled card challenge type=${created.type}`);
  await walkChallengeChain(
    created.request.url,
    created.request.http_method,
    created.request.content,
  );
  return readPayment(ctx, created.payment_id);
}

/**
 * One-off NETBANKING payment, buyer-present, driven to captured.
 *
 * ⚠️ The pay-now bank list and the E-MANDATE bank list are DIFFERENT SETS at
 * RazorPay. `GET /v1/methods` reports 64 netbanking banks for one-off payments and
 * HDFC / ICICI / SBI / Axis are absent from it, while the mandate list (297 banks, 59
 * mandate-capable) has them — which is why the HDFC fixture registers a mandate and
 * cannot take a one-off payment. Pass a code from `netbankingPayNowBanks()`, never a
 * hardcoded favourite.
 */
export async function netbankingCapture(
  ctx: RailContext,
  currency: string,
  amountMinor: number,
  bank: string,
): Promise<CaptureResult> {
  const order = await createCaptureOrder(ctx, currency, amountMinor, `paynow_nb_${Date.now()}`);
  const attempt = await postCheckoutAjax(
    ctx.apiBase,
    new URLSearchParams({
      key_id: ctx.keyId,
      amount: String(amountMinor),
      currency,
      order_id: order.id,
      email: ctx.email,
      contact: ctx.contact,
      method: "netbanking",
      bank,
    }),
  );
  if (!attempt.ok) throw new Error(`netbanking payment not initiated — ${attempt.detail}`);
  const created: {
    payment_id?: string;
    type?: string;
    request?: {
      url?: string;
      http_method?: string;
      method?: string;
      content?: Record<string, unknown>;
    };
    error?: { description?: string };
  } = attempt.json;
  if (!created.payment_id) {
    throw new Error(
      `netbanking payment not initiated: ${created.error?.description ?? JSON.stringify(created).slice(0, 160)}`,
    );
  }
  if (!created.request?.url) throw new Error(`unhandled netbanking challenge type=${created.type}`);
  // Netbanking names the verb `method`; cards name it `http_method`. Reading only the
  // card spelling silently defaulted this hop to POST — which happens to be right, so
  // the bug it hid was the missing `content` below, not the verb.
  await walkChallengeChain(
    created.request.url,
    created.request.method ?? created.request.http_method,
    created.request.content,
  );
  return readPayment(ctx, created.payment_id);
}

/**
 * The methods this MERCHANT actually has enabled, straight from the account.
 *
 * Cheaper and more honest than inferring enablement from a failed payment: the
 * absence of a key here is the account answering. (This is how International
 * Payments being live-only was confirmed without spending a payment.)
 */
export async function accountMethods(ctx: RailContext): Promise<Record<string, any>> {
  const res = await fetch(`${ctx.apiBase.replace(/\/v1$/, "")}/v1/methods?key_id=${ctx.keyId}`, {
    headers: { Authorization: ctx.auth },
  });
  return (await res.json()) as Record<string, any>;
}

/** Bank codes enabled for ONE-OFF netbanking on this account, per `GET /v1/methods`. */
export function netbankingPayNowBanks(methods: Record<string, any>): string[] {
  const nb = methods?.netbanking;
  if (!nb || typeof nb !== "object") return [];
  return Object.keys(nb);
}

/**
 * Authorize a MANDATE order that OUR adapter created, standing in for the buyer's
 * browser. Returns the mandate payment id; poll it for the token the mandate mints.
 *
 * The order deliberately comes from the caller (i.e. from
 * `RazorpayProvider.initiateVaultSetup`) rather than being built here — the order
 * shape *is* half of what a mandate test is checking, and building a local one would
 * verify this file instead of the adapter.
 */
export async function cardMandateAuthorize(
  ctx: RailContext,
  orderId: string,
  customerId: string,
  cardNumber: string,
  authAmountMinor: number,
  currency = "INR",
): Promise<{ paymentId: string | null; detail: string; throttled: boolean }> {
  const attempt = await postCheckoutAjax(
    ctx.apiBase,
    new URLSearchParams({
      key_id: ctx.keyId,
      amount: String(authAmountMinor),
      currency,
      order_id: orderId,
      customer_id: customerId,
      email: ctx.email,
      contact: ctx.contact,
      method: "card",
      recurring: "1",
      "card[number]": cardNumber,
      "card[expiry_month]": "12",
      "card[expiry_year]": "30",
      "card[cvv]": "123",
      "card[name]": "Pro Amount Mandate",
    }),
  );
  if (!attempt.ok) return { paymentId: null, detail: attempt.detail, throttled: attempt.throttled };
  const created: {
    payment_id?: string;
    type?: string;
    submit_url?: string;
    request?: {
      url?: string;
      http_method?: string;
      method?: string;
      content?: Record<string, unknown>;
    };
    error?: { reason?: string; description?: string };
  } = attempt.json;
  if (!created.payment_id) {
    return {
      paymentId: null,
      throttled: false,
      detail:
        created.error?.reason ??
        created.error?.description ??
        JSON.stringify(created).slice(0, 160),
    };
  }
  // The challenge must be completed even though the token is minted either way:
  // skip it and the payment stays `created`, the token never reaches
  // `recurring_details.status: confirmed`, and the first off-session debit fails
  // `token_not_eligible`.
  if (created.type === "otp" && created.submit_url) {
    await fetch(created.submit_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ otp: TEST_OTP }),
    }).then((r) => r.text());
    return { paymentId: created.payment_id, detail: "otp", throttled: false };
  }
  if (created.request?.url) {
    await walkChallengeChain(
      created.request.url,
      created.request.method ?? created.request.http_method,
      created.request.content,
    );
    return { paymentId: created.payment_id, detail: "redirect", throttled: false };
  }
  return {
    paymentId: created.payment_id,
    detail: `challenge=${created.type ?? "none"}`,
    throttled: false,
  };
}

/**
 * One-off UPI payment through the COLLECT flow, buyer-present.
 *
 * This is the pay-now counterpart to UPI Autopay registration and it is scriptable
 * for the same reason: RazorPay auto-approves `success@razorpay` in test mode. The
 * INTENT flow (a QR code) is not — nothing in a headless harness can scan one — so
 * collect is the only UPI pay-now path a suite can actually drive.
 *
 * Note there is no `recurring` flag here. Setting it is what makes this a mandate
 * registration instead of a payment.
 */
export async function upiCollectCapture(
  ctx: RailContext,
  amountMinor: number,
  vpa: string,
): Promise<{ paymentId: string | null; detail: string }> {
  let order: { id: string };
  try {
    order = await createCaptureOrder(ctx, "INR", amountMinor, `paynow_upi_${Date.now()}`);
  } catch (e) {
    // An order refusal is the gateway answering about the amount. Return it as a
    // refusal rather than throwing, so the caller can record a verdict instead of
    // aborting the run — the shape that used to discard every later section.
    if (e instanceof GatewayRefusalError) return { paymentId: null, detail: e.description };
    throw e;
  }
  const res = await fetch(`${ctx.apiBase}/payments/create/upi`, {
    method: "POST",
    headers: { Authorization: ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountMinor,
      currency: "INR",
      order_id: order.id,
      email: ctx.email,
      contact: ctx.contact,
      method: "upi",
      upi: { flow: "collect", vpa },
    }),
  });
  const json = (await res.json()) as {
    razorpay_payment_id?: string;
    error?: { description?: string };
  };
  if (!json.razorpay_payment_id) {
    return {
      paymentId: null,
      detail: `HTTP ${res.status}: ${json?.error?.description ?? JSON.stringify(json).slice(0, 160)}`,
    };
  }
  return { paymentId: json.razorpay_payment_id, detail: "collect request sent" };
}

/** Read a mandate order back from RazorPay — the ceiling it actually carries. */
export async function readOrderMaxAmount(
  ctx: RailContext,
  orderId: string,
): Promise<number | null> {
  const json = (await fetch(`${ctx.apiBase}/orders/${orderId}`, {
    headers: { Authorization: ctx.auth },
  }).then((r) => r.json())) as { token?: { max_amount?: number } };
  return typeof json?.token?.max_amount === "number" ? json.token.max_amount : null;
}

/**
 * Can this account create an order for `amountMinor` at all?
 *
 * RazorPay enforces a per-payment MAXIMUM per merchant (₹5,00,000 on this test key,
 * measured 2026-08-19 by bisection). It is enforced at ORDER CREATION, upstream of
 * every rail, so an amount over it fails identically on card, UPI and netbanking —
 * and reads as three broken rails unless something checks the amount itself first.
 */
export async function probeOrderAmount(
  ctx: RailContext,
  amountMinor: number,
): Promise<{ ok: boolean; description?: string }> {
  try {
    await createCaptureOrder(ctx, "INR", amountMinor, `probe_${Date.now()}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof GatewayRefusalError) return { ok: false, description: e.description };
    throw e;
  }
}

/**
 * The ceiling a MINTED mandate token actually carries.
 *
 * The authoritative read, and the only one that works on every rail: `GET /orders/:id`
 * does NOT echo the `token` block back for a UPI mandate order (it needs `customer_id`
 * alongside `token`, and the echo is absent), so reading the order is enough for cards
 * and silently returns "unknown" for UPI — the rail where the ceiling is most likely to
 * have been clamped. Read the token instead.
 */
export async function readTokenMaxAmount(
  ctx: RailContext,
  customerId: string,
  tokenId: string,
): Promise<number | null> {
  const res = await fetch(`${ctx.apiBase}/customers/${customerId}/tokens/${tokenId}`, {
    headers: { Authorization: ctx.auth },
  });
  if (res.status >= 300) return null;
  const json = (await res.json()) as {
    max_amount?: number;
    recurring_details?: { max_amount?: number };
  };
  return json?.max_amount ?? json?.recurring_details?.max_amount ?? null;
}

/**
 * RazorPay's documented test bank account for e-mandate registration.
 *
 * An invented account number is accepted by the request and then REJECTED by the mock
 * bank (`recurring_details.status: "rejected"`, "Rejected by bank"), so the account
 * details are load-bearing even in test mode.
 */
export const TEST_BANK_ACCOUNT = {
  bank: "HDFC",
  ifsc: "HDFC0000053",
  accountNumber: "1112220041",
  accountType: "savings",
  name: "Gaurav Kumar",
} as const;

/** The order an e-mandate AUTH LINK (`inv_…`) wraps — what a registration pays against. */
export async function readInvoiceOrderId(
  ctx: RailContext,
  invoiceId: string,
): Promise<string | null> {
  const json = (await fetch(`${ctx.apiBase}/invoices/${invoiceId}`, {
    headers: { Authorization: ctx.auth },
  }).then((r) => r.json())) as { order_id?: string };
  return json?.order_id ?? null;
}

/**
 * Register a NETBANKING E-MANDATE from a script — no browser.
 *
 * ⚠️ This contradicts what the other suites assume. `verify-razorpay-emandate-live.ts`
 * and the gateway README both state that e-mandate registration is browser-only
 * because `POST /payments/create/emandate` is 404. That endpoint is indeed 404 — but
 * `POST /payments/create/ajax` with `method: 'emandate'`, `auth_type: 'netbanking'` and
 * the `bank_account[...]` block, posted against the ORDER the auth-link invoice wraps,
 * registers a mandate that reaches `recurring: true, status: "confirmed"`.
 * Measured 2026-08-19: `token_XXXXXXXXXXXX01`, ceiling ₹56,118, then debited ₹56,118
 * off-session and captured within seconds (`pay_XXXXXXXXXXXX01`).
 *
 * That makes netbanking the third unattended-verifiable rail, which matters because it
 * is the only rail that collects a Pro-sized INR amount off-session.
 *
 * The mandate rides an amount-0 order, so pass 0 unless the caller registered otherwise.
 */
export async function emandateRegister(
  ctx: RailContext,
  orderId: string,
  customerId: string,
  authAmountMinor = 0,
  acct: typeof TEST_BANK_ACCOUNT = TEST_BANK_ACCOUNT,
): Promise<{ paymentId: string | null; detail: string; throttled: boolean }> {
  const attempt = await postCheckoutAjax(
    ctx.apiBase,
    new URLSearchParams({
      key_id: ctx.keyId,
      amount: String(authAmountMinor),
      currency: "INR",
      order_id: orderId,
      customer_id: customerId,
      email: ctx.email,
      contact: ctx.contact,
      method: "emandate",
      recurring: "1",
      auth_type: "netbanking",
      bank: acct.bank,
      "bank_account[bank_name]": acct.bank,
      "bank_account[name]": acct.name,
      "bank_account[account_number]": acct.accountNumber,
      "bank_account[account_type]": acct.accountType,
      "bank_account[ifsc]": acct.ifsc,
    }),
  );
  if (!attempt.ok) return { paymentId: null, detail: attempt.detail, throttled: attempt.throttled };
  const created: {
    payment_id?: string;
    type?: string;
    request?: {
      url?: string;
      http_method?: string;
      method?: string;
      content?: Record<string, unknown>;
    };
    error?: { reason?: string; description?: string };
  } = attempt.json;
  if (!created.payment_id) {
    return {
      paymentId: null,
      throttled: false,
      detail:
        created.error?.description ??
        created.error?.reason ??
        JSON.stringify(created).slice(0, 160),
    };
  }
  if (!created.request?.url) {
    return {
      paymentId: created.payment_id,
      detail: `no challenge (type=${created.type})`,
      throttled: false,
    };
  }
  await walkChallengeChain(
    created.request.url,
    created.request.method ?? created.request.http_method,
    created.request.content,
  );
  return { paymentId: created.payment_id, detail: "registered via mock bank", throttled: false };
}

/** Is a minted mandate token actually usable for an off-session debit? */
export async function readTokenRecurringState(
  ctx: RailContext,
  customerId: string,
  tokenId: string,
): Promise<{
  recurring: boolean;
  status: string | null;
  failureReason: string | null;
  maxAmount: number | null;
}> {
  const json = (await fetch(`${ctx.apiBase}/customers/${customerId}/tokens/${tokenId}`, {
    headers: { Authorization: ctx.auth },
  }).then((r) => r.json())) as {
    recurring?: boolean;
    max_amount?: number;
    recurring_details?: { status?: string; failure_reason?: string };
  };
  return {
    recurring: Boolean(json?.recurring),
    status: json?.recurring_details?.status ?? null,
    failureReason: json?.recurring_details?.failure_reason ?? null,
    maxAmount: json?.max_amount ?? null,
  };
}
