/**
 * Cross-tenant object authorization (W8) — the BOLA matrix, over real HTTP.
 *
 * ── WHY THIS EXISTS WHEN `verify:rls` ALREADY PASSES ────────────────────────────
 * They test different layers, and only one of them is what an attacker touches.
 * `verify-rls.ts` proves the Postgres POLICY: inside a tenant context, an unfiltered
 * `select *` returns only that tenant's rows. That is the mechanism, and it is sound.
 *
 * This proves the CONSEQUENCE at the edge: an authenticated caller who names another
 * organization's id gets nothing. Those are not the same claim. A route that reads with
 * the base `db` handle instead of `withTenant`, or resolves a business before checking
 * who owns it, satisfies the first and fails the second — and that gap is precisely
 * SR-2026-008, where every endpoint was authenticated and none checked ownership:
 *
 *   "Endpoint accepts clientId from request / No verification that clientId belongs to
 *    user's team / Repository queries only by clientId, not by (clientId + teamId)"
 *
 * Until now our answer to that report was an architectural argument. This makes it a
 * measurement.
 *
 * ── TWO ATTACK SHAPES, BOTH TESTED ──────────────────────────────────────────────
 *   1. A's key + A's business + B's OBJECT id   → object-within-business scoping
 *   2. A's key + B's BUSINESS + B's object id   → the tenant boundary itself
 * The second is the literal shape of the report ("attacker obtains target's teamId").
 *
 * ── WHAT IS COVERED, AND HOW DEEPLY ─────────────────────────────────────────────
 * 14 families have a real object of B's to aim at, on every route that names it:
 *   catalog / CRM  customer, product, price, coupon, invoice, subscription, gateway_account
 *   money          refund (the payment it moves), credit_note, transaction, payment_intent
 *   provider / promo  dispute, coupon_set, coupon_code
 * The second and third rows were added 2026-08-28 and are the ones that need something to
 * have HAPPENED — a card charged, a chargeback delivered, a note issued — which is why
 * they were swept-only until now and why they matter more: a transaction carries the
 * payer's email, a credit note carries money owed, and an authorized payment intent is a
 * hold a stranger could still capture into an invoice of their own.
 *
 * Then a SWEEP over all 23 per-business resources with an `/:id` route (the 11 with no
 * fixture included), and finally one scan over the bytes of every response A ever
 * received, looking for values that exist exactly once in the database and belong to B.
 *
 * ── WHAT A MUTATION TEST REVEALED, AND WHAT THIS SUITE THEREFORE PROVES ─────────
 * Injecting the SR-2026-008 defect into `resolveBusiness` — falling back to resolving a
 * business by id alone when the tenant-scoped lookup misses — did NOT make this suite
 * fail. That is not a weakness in the assertions; it is the answer to a question worth
 * having asked.
 *
 * The boundary is defended TWICE, independently. `resolveBusiness` checks that the
 * business belongs to the caller, and every object lookup then takes the ORGANIZATION id
 * separately (`getCustomerByPublicId(organizationId, businessId, …)`) and runs under
 * `withTenant`, where RLS filters the row regardless of which business was resolved. Break
 * either one and the other still returns nothing.
 *
 * So this suite asserts the OUTCOME — a caller naming another tenant's id gets nothing —
 * rather than any single mechanism. That is the right thing to assert: it is what an
 * attacker experiences, it survives a refactor that moves the check between layers, and
 * it fails only if BOTH layers are gone, which is the only state that actually leaks.
 *
 * ── WHY 404 AND NOT 403 ─────────────────────────────────────────────────────────
 * A 403 confirms the id exists. Across a tenant boundary that is itself a disclosure:
 * it turns any endpoint into an oracle for enumerating another organization's ids, which
 * is how the reconnaissance half of that report worked. 404 says only "not here".
 *
 *   pnpm verify:bola
 */
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization, getBusinessByPublicId } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { Tmbilling } from "../sdk/index";
import { randomBytes } from "node:crypto";

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(3).toString("hex");

/**
 * Set to A's key once A exists. From that point every response A receives is recorded
 * in `attackerSaw` and scanned once, at the end, for B's globally-unique values — a
 * single control that covers every request in this file, including the ones whose
 * status code happened to be the only thing an individual assertion looked at.
 */
let attacker: string | null = null;
const attackerSaw: Array<{ path: string; text: string }> = [];

/** Raw HTTP, not the SDK: the assertion IS the status code, and the SDK wraps errors. */
async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      // Writes need one; the value is irrelevant to what is being asserted.
      ...(method !== "GET" ? { "idempotency-key": randomBytes(8).toString("hex") } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (attacker && key === attacker) attackerSaw.push({ path: `${method} ${path}`, text });
  return { status: res.status, text };
}

/** Build one tenant with an object of every family we care about. */
async function tenant(label: string) {
  const org = await createOrganization({ name: `BOLA ${label} ${uniq}` });
  const sdk = new Tmbilling({ apiKey: org.secret, baseUrl: base });
  const biz = await sdk.businesses.create({
    name: `${label}-biz`,
    default_currency: "USD",
    livemode: "test",
  });
  const customer = await sdk.customers.create(biz.id, {
    email: `${label}-${uniq}@acme.test`,
    first_name: label,
  });
  const product = await sdk.products.create(biz.id, { name: `${label} plan` });
  // NAMED, so A's and B's slugs differ. Left unnamed they both auto-slug to
  // `usd-month-flat` — see the shared-id section at the bottom, which turns that
  // collision into an assertion rather than a nuisance.
  const price = await sdk.prices.create(biz.id, {
    product: product.id,
    name: `${label} monthly`,
    model: "flat",
    currency: "USD",
    amount_minor: 1000,
    interval: "month",
    interval_count: 1,
  });
  const coupon = await sdk.coupons.create(biz.id, {
    code: `CPN${label}${uniq}`.toUpperCase(),
    name: `${label} coupon`,
    kind: "percentage",
    percent_off_bps: 1000,
  });
  const invoice = await sdk.invoices.create(biz.id, {
    customer: customer.id,
    lines: [{ description: "BOLA fixture", amount_minor: 5000, quantity: 1 }],
  });
  // `trial_days` so no payment method is needed — the fixture exists to be TARGETED, not to bill.
  const subscription = await sdk.subscriptions.create(biz.id, customer.id, {
    items: [{ price: price.id }],
    trial_days: 14,
  });
  /**
   * A gateway account, and it is the highest-value row in this file.
   *
   * Every other family here leaks a customer, a price or a document. This one holds the
   * business's PROVIDER CREDENTIALS — a secret key and a webhook secret. A cross-tenant read
   * here is not a privacy incident, it is the other tenant's Stripe account. It had no BOLA
   * coverage at all before 2026-08-28.
   *
   * Created through the service rather than the API because the route requires `admin` and the
   * point here is the READ boundary, not the create path.
   */
  const gatewayAccount = await createGatewayAccount({
    organizationId: org.organization.id,
    businessId: (await getBusinessByPublicId(org.organization.id, biz.id))!.id,
    gatewayKey: "stripe",
    label: `BOLA ${label} gateway`,
    credentials: {
      secret_key: `sk_test_bola_${label}_${uniq}`,
      webhook_secret: `whsec_bola_${label}_${uniq}`,
    },
  });
  return {
    org,
    sdk,
    key: org.secret,
    biz,
    customer,
    product,
    price,
    coupon,
    invoice,
    subscription,
    gatewayAccount,
  };
}

const A = await tenant("A");
const B = await tenant("B");

/**
 * ── SECOND-TIER FIXTURES: the families MONEY and PROVIDERS create ─────────────
 *
 * The seven families above are all reachable from a catalog/CRM write, which is why
 * they got deep coverage first. Everything below needs something to have actually
 * HAPPENED — a card charged, a chargeback delivered, a credit note issued — and that
 * is exactly why they were left swept-only, and exactly why they matter more: a
 * transaction row carries the payer's email, a credit note carries money owed, and a
 * payment intent is an authorization someone can still capture.
 *
 * The whole chain is built through the PUBLIC API wherever one exists, so the fixture
 * exercises the same routes an attacker would. Two exceptions, both deliberate:
 *   - the `tmtest` gateway account (the create route requires `admin`, and the point
 *     here is the READ boundary — same reasoning as the stripe account above);
 *   - the dispute, which has NO write surface at all by design (disputes are
 *     gateway-driven; `dispute-routes.ts` is read-only), so it is injected through the
 *     same `handleDisputeEvent` the inbound webhook pipeline calls.
 *
 * Note what vaulting a card does here: `POST …/payment_methods` runs Billing LogIQ's
 * "collect on payment-method update", so the 9000 invoice is paid on the spot. That
 * one call is what produces the payment, the transaction and the refund capacity.
 */
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function deepFixture(t: Tenant, label: string) {
  const orgId = t.org.organization.id;
  const bizRow = (await getBusinessByPublicId(orgId, t.biz.id))!;
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, t.key, body);
    if (r.status >= 300)
      throw new Error(`fixture ${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
    return JSON.parse(r.text);
  };

  const tmAcct = await createGatewayAccount({
    organizationId: orgId,
    businessId: bizRow.id,
    gatewayKey: "tmtest",
    label: `BOLA ${label} ${uniq} tmtest`,
    credentials: {},
  });

  // An invoice that will really be PAID — the 5000 one above stays open on purpose.
  const invoice = await json("POST", `/v1/businesses/${t.biz.id}/invoices`, {
    customer: t.customer.id,
    collect: false,
    lines: [{ description: "BOLA money fixture", amount_minor: 9000, quantity: 1 }],
  });
  // Vaulting collects the open invoice against the new card → payment + transaction.
  const pm = await json(
    "POST",
    `/v1/businesses/${t.biz.id}/customers/${t.customer.id}/payment_methods`,
    {
      token: "4242424242424242",
      gateway_account: tmAcct.publicId,
    },
  );
  const txns = await json("GET", `/v1/businesses/${t.biz.id}/transactions?invoice=${invoice.id}`);
  const txn = txns.data.find((x: { type: string }) => x.type === "payment");
  if (!txn?.reference_payment)
    throw new Error(`no payment transaction for ${invoice.id}: ${JSON.stringify(txns)}`);

  // `refundable`, not `adjustment`: the invoice is already paid, so what is owed is
  // cash back, and `refund` / `record_refund` only exist on a refundable note.
  const creditNote = await json("POST", `/v1/businesses/${t.biz.id}/credit_notes`, {
    invoice: invoice.id,
    kind: "refundable",
    reason_code: "other",
    reason: `bolacn-${label}-${uniq}`,
    items: [{ description: "BOLA cn fixture", amount_minor: 2000 }],
  });

  // An AUTHORIZED intent — a hold that has not been captured. The interesting one:
  // it is money a stranger could still consume into an invoice of their own.
  const intent = await json("POST", `/v1/businesses/${t.biz.id}/payment_intents`, {
    purpose: "payment",
    payment_method: pm.id,
    amount_minor: 1500,
    currency: "USD",
  });

  /**
   * A coupon set, and the `uniq` in its NAME is load-bearing.
   *
   * Coupon-set ids are slugs derived from the name and unique per business, not
   * globally — the same trap the shared-catalog-id section below turns into an
   * assertion. Named `BOLA set ${label}` both tenants would slug to different ids
   * only by accident of the label; with `uniq` they cannot collide at all, so a
   * refusal here means the boundary held rather than that the id was never shared.
   */
  const couponSet = await json("POST", `/v1/businesses/${t.biz.id}/coupon_sets`, {
    coupon: t.coupon.id,
    name: `BOLA set ${label} ${uniq}`,
    count: 3,
    code_prefix: `S${label}${uniq}`.toUpperCase(),
  });
  const codes = await json("GET", `/v1/businesses/${t.biz.id}/coupon_sets/${couponSet.id}/codes`);

  // Disputes have no write API on purpose (gateway-driven). This is the same entry
  // point `gateway/inbound.ts` calls, with the business it resolved from the VERIFIED
  // gateway account — the `ctx.businessId` correlation path.
  const { handleDisputeEvent, listDisputes } = await import("@/modules/disputes/service");
  const handled = await handleDisputeEvent(
    {
      providerEventId: `evt_bola_${label}_${uniq}`,
      occurredAt: new Date(),
      type: "dispute.created",
      providerDisputeId: `dp_bola_${label}_${uniq}`,
      disputeAmountMinor: 9000n,
      disputeCurrency: "USD",
      disputeReason: `boladsp-${label}-${uniq}`,
      raw: {},
    },
    { businessId: bizRow.id, providerKey: "tmtest" },
  );
  if (handled !== "processed") throw new Error(`dispute fixture not processed: ${handled}`);
  const dispute = (await listDisputes(orgId, bizRow.id, {})).find(
    (d) => d.providerDisputeId === `dp_bola_${label}_${uniq}`,
  );
  if (!dispute) throw new Error("dispute fixture missing");

  return {
    bizRow,
    tmAcct: tmAcct.publicId,
    invoice: invoice.id as string,
    paymentMethod: pm.id as string,
    payment: txn.reference_payment as string,
    transaction: txn.id as string,
    creditNote: creditNote.id as string,
    intent: intent.id as string,
    couponSet: couponSet.id as string,
    couponCode: codes.data[0].code as string,
    dispute: dispute.publicId,
  };
}

// From here on every response A receives is recorded and scanned at the end. Set
// BEFORE A's own fixture so the scan's mechanism control has something to find.
attacker = A.key;

const deepA = await deepFixture(A, "A");
const deepB = await deepFixture(B, "B");

/**
 * Values that exist EXACTLY ONCE in the whole database and belong to B.
 *
 * Every one is globally unique, which is the only kind of value a leak control can be
 * keyed on. The lesson came from invoice NUMBERS: they are per-business, so A's first
 * invoice and B's first are both `INV-1`, and a control asserting "A never sees INV-1"
 * passes while proving nothing at all. Ids and emails are the safe currency here.
 *
 * None of these is ever echoed back by a route — that rules out B's ids (an error body
 * names the id you asked for) and B's coupon CODE (same, on the archive route), which
 * is why they are absent from this list even though they are unique.
 */
/** Rendered to B by some route — so a scan for them has a needle that provably exists. */
const B_SECRETS: Array<[string, string]> = [
  ["B's customer email", `B-${uniq}@acme.test`],
  ["B's tmtest gateway label", `BOLA B ${uniq} tmtest`],
  ["B's credit-note reason", `bolacn-B-${uniq}`],
  ["B's dispute reason", `boladsp-B-${uniq}`],
];
/**
 * Rendered to NOBODY — provider credentials, redacted by the gateway serializer. Kept
 * separate because they cannot be self-tested the same way (see the leak scan's own
 * controls at the bottom of this file, which assert their absence for B as well as A).
 */
const B_CREDENTIALS: Array<[string, string]> = [
  ["B's gateway secret key", `sk_test_bola_B_${uniq}`],
  ["B's gateway webhook secret", `whsec_bola_B_${uniq}`],
];

/**
 * Every family, as (name, path-builder). The builder takes a business id and an object
 * id so the same row can be aimed at either attack shape.
 */
const FAMILIES: Array<{ name: string; path: (biz: string) => string; patch?: unknown }> = [
  {
    name: "customer",
    path: (biz) => `/v1/businesses/${biz}/customers/${B.customer.id}`,
    patch: { first_name: "pwned" },
  },
  {
    name: "product",
    path: (biz) => `/v1/businesses/${biz}/products/${B.product.id}`,
    patch: { name: "pwned" },
  },
  {
    name: "price",
    path: (biz) => `/v1/businesses/${biz}/prices/${B.price.id}`,
    patch: { name: "pwned" },
  },
  {
    name: "coupon",
    path: (biz) => `/v1/businesses/${biz}/coupons/${B.coupon.id}`,
    patch: { name: "pwned" },
  },
  { name: "invoice", path: (biz) => `/v1/businesses/${biz}/invoices/${B.invoice.id}` },
  // Added 2026-08-28. `verify:bola` covered 5 of the 23 per-business resources that expose an
  // `/:id` route; these two are the ones whose contents matter most.
  {
    name: "subscription",
    path: (biz) => `/v1/businesses/${biz}/subscriptions/${B.subscription.id}`,
    patch: { po_number: "pwned" },
  },
  {
    name: "gateway_account",
    path: (biz) => `/v1/businesses/${biz}/gateway_accounts/${B.gatewayAccount.publicId}`,
  },
];

/** Anything but 2xx/3xx is a refusal; 404 specifically is the one that leaks least. */
const refused = (s: number) => s === 404;

for (const f of FAMILIES) {
  // ── Shape 1: A's own business, B's object id ──────────────────────────────────
  const read1 = await call("GET", f.path(A.biz.id), A.key);
  ok(`${f.name}: A cannot READ B's id inside A's business (404)`, refused(read1.status));
  ok(
    `${f.name}: …and the body discloses nothing about it`,
    !read1.text.includes(uniq) || read1.status === 404,
  );

  // ── Shape 2: B's business id, using A's key. The report's literal shape. ───────
  const read2 = await call("GET", f.path(B.biz.id), A.key);
  ok(`${f.name}: A cannot READ B's id via B's business (404)`, refused(read2.status));

  if (f.patch) {
    const w1 = await call("PATCH", f.path(A.biz.id), A.key, f.patch);
    ok(`${f.name}: A cannot WRITE B's id inside A's business (404)`, refused(w1.status));
    const w2 = await call("PATCH", f.path(B.biz.id), A.key, f.patch);
    ok(`${f.name}: A cannot WRITE B's id via B's business (404)`, refused(w2.status));

    const d1 = await call("DELETE", f.path(A.biz.id), A.key);
    ok(`${f.name}: A cannot DELETE B's id inside A's business (404)`, refused(d1.status));
    const d2 = await call("DELETE", f.path(B.biz.id), A.key);
    ok(`${f.name}: A cannot DELETE B's id via B's business (404)`, refused(d2.status));
  }
}

/**
 * ── DEEP COVERAGE, SECOND TIER: refunds, credit notes, transactions, payment
 *    intents, disputes, coupon sets ────────────────────────────────────────────
 *
 * Same two attack shapes as above, but these families are not a single `/:id` GET —
 * a credit note has five routes that name it, a payment intent six — and the write
 * ones are where the money is. `/consume` is the sharpest: it captures an authorized
 * hold INTO an invoice you name, so shape 1 hands it B's intent and A's OWN invoice.
 * That is not a read of someone else's data, it is their money in your ledger.
 *
 * ── THE ORACLE, PER SHAPE ────────────────────────────────────────────────────────
 * A refusal alone proves very little; what it must be is INDISTINGUISHABLE from the
 * same request against something that does not exist. The comparison differs by shape,
 * and getting it wrong is how an earlier version of this file flagged 19 resources as
 * broken when nothing was:
 *   - shape 1 (A's own business, B's object id) → compare with A's own business and a
 *     MADE-UP object id. Both stop at the RESOURCE lookup, so they must match.
 *   - shape 2 (B's business, B's object id) → compare with a NONEXISTENT business.
 *     Both stop at the BUSINESS check, so they must match.
 * Comparing across those two levels is the mistake: they SHOULD differ.
 */
{
  /** A body may depend on the shape — see `/consume` above. */
  type Route = [method: string, suffix: string, body?: (ownBusiness: boolean) => unknown];

  const FAKE = `nosuch${uniq}`;
  const ghostBiz = `biz_ghost2${uniq}`;

  const MONEY: Array<{
    name: string;
    collection: string;
    real: string;
    fake: string;
    routes: Route[];
  }> = [
    {
      // No `/:id` READ route exists for a refund at all (`refund-routes.ts` is one
      // POST), so the object under test is the PAYMENT and the surface is the write
      // that moves cash out of it.
      name: "refund",
      collection: "payments",
      real: deepB.payment,
      fake: `pay_${FAKE}`,
      routes: [["POST", "/refund", () => ({ amount_minor: 100 })]],
    },
    {
      name: "credit_note",
      collection: "credit_notes",
      real: deepB.creditNote,
      fake: `cn_${FAKE}`,
      routes: [
        ["GET", ""],
        ["GET", "/pdf"],
        ["POST", "/refund", () => ({ amount_minor: 100 })],
        ["POST", "/record_refund", () => ({ amount_minor: 100, method: "cash" })],
        ["POST", "/void", () => ({})],
      ],
    },
    {
      name: "transaction",
      collection: "transactions",
      real: deepB.transaction,
      fake: `txn_${FAKE}`,
      routes: [["GET", ""]],
    },
    {
      name: "payment_intent",
      collection: "payment_intents",
      real: deepB.intent,
      fake: `pi_${FAKE}`,
      routes: [
        ["GET", ""],
        ["GET", "/attempts"],
        ["POST", "/authorize", () => ({})],
        ["POST", "/retry", () => ({})],
        // Shape 1 names A's OWN invoice: capture B's hold into A's ledger.
        ["POST", "/consume", (own) => ({ invoice: own ? deepA.invoice : deepB.invoice })],
        ["POST", "/void", () => ({})],
      ],
    },
    {
      name: "dispute",
      collection: "disputes",
      real: deepB.dispute,
      fake: `dsp_${FAKE}`,
      routes: [["GET", ""]],
    },
    {
      name: "coupon_set",
      collection: "coupon_sets",
      real: deepB.couponSet,
      fake: `bola-set-${FAKE}`,
      routes: [
        ["GET", ""],
        ["GET", "/codes"],
        ["POST", "/codes", () => ({ count: 1 })],
        ["DELETE", "/unused_codes"],
      ],
    },
    {
      name: "coupon_code",
      collection: "coupon_codes",
      real: deepB.couponCode,
      fake: `NOSUCHCODE${uniq}`.toUpperCase(),
      routes: [["POST", "/archive", () => ({})]],
    },
  ];

  /**
   * Ids are substituted by EXACT string, not by regex.
   *
   * Two of these families are keyed on a slug (`coupon_sets`) or a bare code string
   * (`coupon_codes`), which no `prefix_[A-Za-z0-9]+` pattern matches — a regex
   * normalizer would leave the real id in one body and the fake id in the other and
   * report a mismatch that is purely its own doing.
   */
  const scrub = (t: string, real: string, fake: string) => {
    let out = t;
    for (const [from, to] of [
      [real, "OBJ"],
      [fake, "OBJ"],
      [A.biz.id, "BIZ"],
      [B.biz.id, "BIZ"],
      [ghostBiz, "BIZ"],
      [deepA.invoice, "INV"],
      [deepB.invoice, "INV"],
    ] as Array<[string, string]>) {
      out = out.split(from).join(to);
    }
    return out;
  };

  /** Not 2xx and not 5xx. A 5xx means the request reached code that assumed it resolved. */
  const isRefusal = (s: number) => !(s >= 200 && s < 300) && s < 500;

  const statuses = new Set<string>();
  for (const f of MONEY) {
    let reached1 = 0,
      oracle1 = 0,
      reached2 = 0,
      oracle2 = 0;
    for (const [method, suffix, body] of f.routes) {
      const at = (biz: string, id: string) =>
        `/v1/businesses/${biz}/${f.collection}/${id}${suffix}`;

      // ── Shape 1: A's own business, B's object id ────────────────────────────
      const r1 = await call(method, at(A.biz.id, f.real), A.key, body?.(true));
      const r1fake = await call(method, at(A.biz.id, f.fake), A.key, body?.(true));
      if (!isRefusal(r1.status)) {
        reached1++;
        console.log(
          `    ↳ ${f.name}: ${method} …${suffix} on A's business with B's id → ${r1.status} ${r1.text.slice(0, 120)}`,
        );
      }
      if (
        r1.status !== r1fake.status ||
        scrub(r1.text, f.real, f.fake) !== scrub(r1fake.text, f.real, f.fake)
      ) {
        oracle1++;
        console.log(
          `    ↳ ${f.name}: ${method} …${suffix} real-foreign ${r1.status} ${JSON.stringify(scrub(r1.text, f.real, f.fake).slice(0, 90))} ` +
            `vs made-up ${r1fake.status} ${JSON.stringify(scrub(r1fake.text, f.real, f.fake).slice(0, 90))}`,
        );
      }

      // ── Shape 2: B's business id, using A's key. The report's literal shape. ──
      const r2 = await call(method, at(B.biz.id, f.real), A.key, body?.(false));
      const r2ghost = await call(method, at(ghostBiz, f.fake), A.key, body?.(false));
      if (!isRefusal(r2.status)) {
        reached2++;
        console.log(
          `    ↳ ${f.name}: ${method} …${suffix} via B's business → ${r2.status} ${r2.text.slice(0, 120)}`,
        );
      }
      if (
        r2.status !== r2ghost.status ||
        scrub(r2.text, f.real, f.fake) !== scrub(r2ghost.text, f.real, f.fake)
      ) {
        oracle2++;
        console.log(
          `    ↳ ${f.name}: ${method} …${suffix} real-but-foreign business ${r2.status} ${JSON.stringify(scrub(r2.text, f.real, f.fake).slice(0, 90))} ` +
            `vs nonexistent business ${r2ghost.status} ${JSON.stringify(scrub(r2ghost.text, f.real, f.fake).slice(0, 90))}`,
        );
      }
      statuses.add(`${f.name} ${method}${suffix}=${r1.status}/${r2.status}`);
    }
    const n = f.routes.length;
    ok(
      `${f.name}: A cannot reach B's object on any of its ${n} route(s), inside A's business`,
      reached1 === 0,
    );
    ok(`${f.name}: …and B's real id is indistinguishable from a made-up one`, oracle1 === 0);
    ok(
      `${f.name}: A cannot reach B's object on any of its ${n} route(s), via B's business`,
      reached2 === 0,
    );
    ok(`${f.name}: …and B's business is indistinguishable from a nonexistent one`, oracle2 === 0);
  }

  /**
   * 404 EVERYWHERE — no exceptions left (fixed 2026-08-28).
   *
   * Recorded as `family METHOD/suffix=shape1/shape2`, and the set of allowed non-404s is
   * pinned EXACTLY so a NEW status on any of these routes fails this check rather than
   * passing quietly. That pin is the drift guard and it stays even now that it is empty:
   * `unexpected` is what refuses a 400 that creeps back in later.
   *
   * ── WHAT USED TO BE HERE, AND WHY IT IS GONE ────────────────────────────────────
   * Four routes answered 400 where their 20+ siblings answered 404, all in shape 1 (your
   * own business, someone else's object id):
   *
   *   refund      POST /payments/{pay}/refund
   *   credit_note POST /credit_notes/{cn}/refund
   *   credit_note POST /credit_notes/{cn}/record_refund
   *   credit_note POST /credit_notes/{cn}/void
   *
   * Same mechanism in all four: the service raised a domain error for a missing object —
   * `RefundError('No such payment: …')`, `CreditNoteError('No such credit note: …')` —
   * and the route mapped EVERY error of that class to 400. (Shape 2 never reached them;
   * `resolveBusiness` 404s first, which is why the pin read `400/404`.)
   *
   * It was never a disclosure — the oracle above asserts each was byte-identical to the
   * same call with a made-up id — but a 400 meant the caller got as far as the engine,
   * which is a longer path than a 404 and therefore more code that has to keep being
   * right. Both error classes now carry an optional `code: 'not_found'`, set ONLY at the
   * object-lookup misses, and `refund-routes.ts` / `credit-note-routes.ts` map that one
   * code to `notFound`. Structural, not a message match: rephrasing "No such payment"
   * cannot silently undo it.
   *
   * The `FIXED_404` pin below asserts those four routes are PRESENT and 404/404, so the
   * fix is asserted positively rather than merely not contradicted — a route that
   * vanished from `statuses` would otherwise satisfy `unexpected` by absence.
   */
  const EXPECTED_400 = new Set<string>([
    // Empty on purpose. Nothing in the money families is allowed to refuse with anything
    // but 404 any more. KEEP THE SET AND THE CHECK: adding a line here must be a
    // deliberate, argued exception, and `unexpected` fails until someone does.
  ]);
  const FIXED_404 = [
    "refund POST/refund=404/404",
    "credit_note POST/refund=404/404",
    "credit_note POST/record_refund=404/404",
    "credit_note POST/void=404/404",
  ];
  const unexpected = [...statuses].filter((x) => !/=404\/404$/.test(x) && !EXPECTED_400.has(x));
  const missing = [...EXPECTED_400].filter((x) => !statuses.has(x));
  const notFixed = FIXED_404.filter((x) => !statuses.has(x));
  ok("money families: every refusal is a 404, with no pinned exceptions", unexpected.length === 0);
  ok(
    "money families: …and each pinned exception is still exactly that (no silent drift)",
    missing.length === 0,
  );
  ok(
    "money families: the four formerly-400 money writes now answer 404 on both shapes",
    notFixed.length === 0,
  );
  if (unexpected.length) console.log(`    ↳ unexpected statuses: ${unexpected.join(", ")}`);
  if (missing.length) console.log(`    ↳ pinned statuses that changed: ${missing.join(", ")}`);
  if (notFixed.length) {
    const recorded = (pin: string) =>
      [...statuses].find((s) => s.startsWith(`${pin.split("=")[0]!}=`)) ?? "ABSENT";
    console.log(
      `    ↳ expected 404/404 but recorded: ${notFixed.map((x) => `${x} → ${recorded(x)}`).join(", ")}`,
    );
  }

  /**
   * ── POSITIVE CONTROLS: the OWNER's genuine bad request must STILL be 400 ─────────
   *
   * Mapping "not found" to 404 is only correct if it is narrow. Mapping the whole error
   * class to 404 would make every assertion above green while destroying the API's error
   * contract: "Refund amount must be positive" and "exceeds available" would start
   * claiming the object does not exist. So each of the four routes is exercised a second
   * time — by A, on A's OWN object, with a request that is genuinely invalid — and must
   * answer 400.
   *
   * Every case here refuses BEFORE any mutation (over-amount guards sit above the
   * earmark/ledger writes in both services), except the void, whose first call is
   * expected to succeed and is itself a control that the route still works at all.
   */
  const aOwn = async (method: string, path: string, body?: unknown) =>
    await call(method, `/v1/businesses/${A.biz.id}${path}`, A.key, body);

  const HUGE = 999_999_999; // far above any fixture amount; refused on arithmetic, not shape

  const pos1 = await aOwn("POST", `/payments/${deepA.payment}/refund`, { amount_minor: HUGE });
  ok("positive: A over-refunding A's OWN payment is still a 400, not a 404", pos1.status === 400);
  const pos2 = await aOwn("POST", `/credit_notes/${deepA.creditNote}/refund`, {
    amount_minor: HUGE,
  });
  ok(
    "positive: A over-refunding A's OWN credit note is still a 400, not a 404",
    pos2.status === 400,
  );
  const pos3 = await aOwn("POST", `/credit_notes/${deepA.creditNote}/record_refund`, {
    amount_minor: HUGE,
    method: "cash",
  });
  ok(
    "positive: A over-recording an offline refund on A's OWN credit note is still a 400",
    pos3.status === 400,
  );
  // Void has no amount to get wrong, so the invalid request is a REPEAT: the first void
  // succeeds (the route still works for its owner), the second is refused for state.
  const voidOk = await aOwn("POST", `/credit_notes/${deepA.creditNote}/void`, {});
  ok(
    "positive: A can still void A's own credit note (the route works, it is not 404 for everyone)",
    voidOk.status >= 200 && voidOk.status < 300,
  );
  const pos4 = await aOwn("POST", `/credit_notes/${deepA.creditNote}/void`, {});
  ok("positive: A re-voiding A's OWN credit note is still a 400, not a 404", pos4.status === 400);
  for (const [n, r] of [
    ["refund", pos1],
    ["cn refund", pos2],
    ["cn record_refund", pos3],
    ["cn void(2nd)", pos4],
    ["cn void(1st)", voidOk],
  ] as const) {
    if (!(n === "cn void(1st)" ? r.status >= 200 && r.status < 300 : r.status === 400)) {
      console.log(`    ↳ positive control ${n} → ${r.status} ${r.text.slice(0, 160)}`);
    }
  }

  // ── B IS UNTOUCHED, per family ──────────────────────────────────────────────
  //
  // Every write above was expected to fail, and a 404 returned AFTER the row changed
  // looks exactly like a 404 returned instead of changing it. B looks at its own rows.
  const bGet = async (path: string) => {
    const r = await call("GET", `/v1/businesses/${B.biz.id}${path}`, B.key);
    return { status: r.status, body: r.status === 200 ? JSON.parse(r.text) : null, text: r.text };
  };
  const cn = await bGet(`/credit_notes/${deepB.creditNote}`);
  ok(
    "integrity: B's credit note is still refund_due with all 2000 available",
    cn.body?.status === "refund_due" &&
      cn.body?.available_minor === 2000 &&
      cn.body?.refunded_minor === 0,
  );
  const pi = await bGet(`/payment_intents/${deepB.intent}`);
  ok(
    "integrity: B's payment intent is still authorized and unvoided",
    pi.body?.status === "authorized" && pi.body?.voided_at === null,
  );
  const codes = await bGet(`/coupon_sets/${deepB.couponSet}/codes`);
  ok(
    "integrity: none of B's coupon codes was archived",
    codes.body?.data?.length === 3 &&
      codes.body.data.every((c: { status: string }) => c.status === "not_redeemed"),
  );
  const dsp = await bGet(`/disputes/${deepB.dispute}`);
  ok("integrity: B's dispute is still needs_response", dsp.body?.status === "needs_response");
  const txnAfter = await bGet(`/transactions?type=refund`);
  ok("integrity: no refund transaction exists on B's business", txnAfter.body?.data?.length === 0);

  // ── POSITIVE CONTROLS ───────────────────────────────────────────────────────
  //
  // Without these the whole section is satisfied by a route that 404s for everyone.
  // Reads first, then one WRITE per family that has one — a refusal only means
  // something if the same call succeeds for the owner.
  ok(
    "positive: B can read its own transaction, and it carries B's payer email",
    (await bGet(`/transactions/${deepB.transaction}`)).body?.customer_email ===
      `B-${uniq}@acme.test`,
  );
  ok("positive: B can read its own credit note", cn.status === 200);
  ok("positive: B can read its own payment intent", pi.status === 200);
  ok(
    "positive: B can read its own dispute, and it carries B's reason",
    dsp.body?.reason === `boladsp-B-${uniq}`,
  );
  ok(
    "positive: B can read its own coupon set",
    (await bGet(`/coupon_sets/${deepB.couponSet}`)).status === 200,
  );

  /**
   * The credit-note PDF, asserted on the two things a CORRECT response actually has.
   *
   * A pdfkit document is DEFLATE-compressed, so no fixture string is findable in it —
   * searching for one and "passing" because it is absent proves the opposite of what it
   * looks like. The honest assertions are the magic bytes and a length floor.
   */
  const pdf = await call(
    "GET",
    `/v1/businesses/${B.biz.id}/credit_notes/${deepB.creditNote}/pdf`,
    B.key,
  );
  ok(
    "positive: B can render its own credit-note PDF (%PDF- + a real document)",
    pdf.status === 200 && pdf.text.startsWith("%PDF-") && pdf.text.length > 2000,
  );

  // Writes. Ordered so each one is still legal when it runs: archive a code, refund
  // 500 of the payment (the CN claims 2000 of the 9000, leaving 7000 unclaimed), pay
  // out 100 of the credit note, then release the intent.
  const wArchive = await call(
    "POST",
    `/v1/businesses/${B.biz.id}/coupon_codes/${deepB.couponCode}/archive`,
    B.key,
    {},
  );
  ok("positive: B can archive its OWN coupon code", wArchive.status === 200);
  const wRefund = await call(
    "POST",
    `/v1/businesses/${B.biz.id}/payments/${deepB.payment}/refund`,
    B.key,
    { amount_minor: 500 },
  );
  ok("positive: B can refund its OWN payment", wRefund.status === 201);
  const wCnRefund = await call(
    "POST",
    `/v1/businesses/${B.biz.id}/credit_notes/${deepB.creditNote}/record_refund`,
    B.key,
    { amount_minor: 100, method: "cash" },
  );
  ok("positive: B can record an offline refund of its OWN credit note", wCnRefund.status === 200);
  const wVoid = await call(
    "POST",
    `/v1/businesses/${B.biz.id}/payment_intents/${deepB.intent}/void`,
    B.key,
    {},
  );
  ok("positive: B can void its OWN payment intent", wVoid.status === 200);

  /**
   * `POST /v1/transactions/:txn/reconcile` — the one route in this family that is NOT
   * business-scoped. It takes an organization id and a transaction public id, and its
   * only tenancy defence is the RLS context `withTenant` opens: no `organization_id`
   * appears in its WHERE clause at all. So it is the route where a missing `withTenant`
   * would be a straight cross-tenant write, and it earns its own case.
   *
   * It also supplies its own positive control for free. A reconcile is legal only from
   * `needs_attention` / `timeout`, so a settled transaction answers 400 "…is success and
   * cannot be reconciled" — for its OWNER. A stranger's gets 404 "Transaction not
   * found". The route therefore demonstrably reaches the row for one caller and not the
   * other, which is exactly what a positive control has to show.
   */
  const recForeign = await call("POST", `/v1/transactions/${deepB.transaction}/reconcile`, A.key, {
    outcome: "succeeded",
  });
  const recGhost = await call("POST", `/v1/transactions/txn_${FAKE}/reconcile`, A.key, {
    outcome: "succeeded",
  });
  const recOwn = await call("POST", `/v1/transactions/${deepA.transaction}/reconcile`, A.key, {
    outcome: "succeeded",
  });
  ok(
    "reconcile (org-scoped, RLS-only): A cannot reconcile B's transaction (404)",
    recForeign.status === 404,
  );
  ok(
    "reconcile: …and B's transaction is indistinguishable from a nonexistent one",
    recForeign.status === recGhost.status &&
      scrub(recForeign.text, deepB.transaction, `txn_${FAKE}`) ===
        scrub(recGhost.text, deepB.transaction, `txn_${FAKE}`),
  );
  ok(
    "reconcile: …while A's OWN transaction reaches the row (400, wrong state)",
    recOwn.status === 400,
  );
  ok(
    "integrity: B's transaction was not reconciled",
    (await bGet(`/transactions/${deepB.transaction}`)).body?.status === "succeeded",
  );
}

// ── The business itself ──────────────────────────────────────────────────────────
{
  const read = await call("GET", `/v1/businesses/${B.biz.id}`, A.key);
  ok("business: A cannot read B's business (404)", refused(read.status));
  const list = await call("GET", "/v1/businesses", A.key);
  ok("business: A's list does not contain B's business", !list.text.includes(B.biz.id));
}

// ── The refusals must be indistinguishable from a nonexistent id ─────────────────
//
// This is the part that keeps 404 honest. If a REAL id belonging to another tenant
// answered differently from a made-up one — a different status, a different body, even a
// different length — the endpoint would still be an enumeration oracle, just a quieter
// one.
{
  const real = await call("GET", `/v1/businesses/${A.biz.id}/customers/${B.customer.id}`, A.key);
  const fake = await call(
    "GET",
    `/v1/businesses/${A.biz.id}/customers/cus_definitelynotreal${uniq}`,
    A.key,
  );
  ok("oracle: a real foreign id and a fake id share a status", real.status === fake.status);
  // Bodies name the id back, so compare shape rather than bytes.
  const shape = (t: string) => t.replace(/cus_[A-Za-z0-9]+/g, "ID");
  ok("oracle: …and the same body shape", shape(real.text) === shape(fake.text));
}

// ── A SHARED catalog id resolves to each tenant's OWN row ────────────────────────
//
// Catalog resources (products, prices, coupons) use a USER-CHOSEN slug that is unique
// per business, not globally — locked decision #5. So two tenants can legitimately hold
// the same id, and that is not a collision to be avoided but an isolation case to be
// proved: naming it must return YOUR row, never theirs.
//
// This suite found that the hard way. With prices left unnamed, both tenants auto-slugged
// to `usd-month-flat`, and three "A cannot read B's id" checks failed — not because the
// boundary leaked, but because the id genuinely existed on both sides and each tenant was
// correctly served its own. The fixture was wrong, not the engine. Worth keeping as a
// test, since a future change that resolved catalog ids globally would pass every other
// check in this file.
{
  const shared = `shared-${uniq}`;
  // Raw, not the SDK: `ProductWrite` omits `id`, though the API accepts one (catalog
  // resources take a user-provided slug — locked decision #5). An SDK typing gap, noted
  // rather than worked around silently.
  for (const t of [A, B]) {
    await call("POST", `/v1/businesses/${t.biz.id}/products`, t.key, {
      id: shared,
      name: `${shared} in ${t.biz.name}`,
    });
  }
  const readA = await call("GET", `/v1/businesses/${A.biz.id}/products/${shared}`, A.key);
  const readB = await call("GET", `/v1/businesses/${B.biz.id}/products/${shared}`, B.key);
  ok(
    "shared id: both tenants can hold the same catalog id",
    readA.status === 200 && readB.status === 200,
  );
  ok("shared id: A sees ITS row", readA.text.includes(A.biz.name));
  ok("shared id: B sees ITS row", readB.text.includes(B.biz.name));
  ok("shared id: A's read does not contain B's row", !readA.text.includes(B.biz.name));
}

// ── EVERY per-business resource, not just the ones with a fixture ────────────────
//
// The deep cases above need a real object in B, which limits them to families this suite can
// construct — 12 of the 23 per-business resources that expose an `/:id` route (plus refunds
// and coupon_codes, which have no `/:id` READ route and so are not in this list at all).
//
// The remaining 11 are here and only here. Each one is a deliberate omission, not an
// oversight, and the reason differs:
//   - gateway_requests, gateway_webhooks — rows written by INBOUND provider traffic; a
//     fixture would need a signed delivery from a real gateway account (verify:webhook-e2e
//     is where that machinery lives).
//   - emails — written by the mail transport when something is actually sent; the send
//     paths need SMTP configured per business.
//   - audit_logs, comments — audit rows are written as a side effect of dashboard-attributed
//     mutations, and comments hang off an arbitrary parent resource; both are cheap to add
//     and worth doing next.
//   - scheduled_changes — needs a future-dated subscription change, i.e. the billing clock.
//   - product_groups, custom_field_definitions, reason_codes, tax_regions,
//     transfer_configurations — plain configuration rows with a create route; nothing blocks
//     a fixture, they are simply lower value than the money families and are next in line.
// Leaving them entirely unprobed is how a new route ships with the business check in the
// wrong place, which is what this sweep is for.
//
// What this proves WITHOUT a fixture: the business-ownership check runs BEFORE the resource
// lookup, and it answers identically whether the business is a stranger's or your own. A route
// that resolved the row first and only then checked ownership would still 404 here on a made-up
// id — so the assertion is deliberately about the SHAPE of the answer, not just its status:
//   - never a 500 (a foreign business id must not reach code that assumes it resolved)
//   - never 2xx
//   - byte-identical, modulo ids, to the same request against YOUR OWN business
// The last one is the oracle test: if a foreign business answered differently from your own,
// the endpoint would leak which businesses exist, which is the enumeration step before BOLA.
{
  const RESOURCES = [
    "audit_logs",
    "comments",
    "coupons",
    "coupon_sets",
    "credit_notes",
    "customers",
    "custom_field_definitions",
    "disputes",
    "emails",
    "gateway_accounts",
    "gateway_requests",
    "gateway_webhooks",
    "invoices",
    "payment_intents",
    "prices",
    "product_groups",
    "products",
    "reason_codes",
    "scheduled_changes",
    "subscriptions",
    "tax_regions",
    "transactions",
    "transfer_configurations",
  ] as const;

  const shape = (t: string) =>
    t
      .replace(/[a-z_]{2,4}_[A-Za-z0-9]{8,}/g, "ID")
      .replace(new RegExp(uniq, "g"), "UNIQ")
      .replace(/biz_[A-Za-z0-9]+/g, "BIZ");

  let leaks = 0;
  let mismatches = 0;
  let ownErrors = 0;
  const fake = `notreal${uniq}`;
  for (const r of RESOURCES) {
    const foreign = await call("GET", `/v1/businesses/${B.biz.id}/${r}/${fake}`, A.key);
    // ⚠ The oracle comparison is against a NONEXISTENT business, not against A's own.
    // Comparing to A's own business was wrong and I had it that way first: a foreign business
    // correctly 404s at the BUSINESS check ("No such business"), while your own business with a
    // bad id correctly 404s at the RESOURCE check ("No such customer"). Those messages SHOULD
    // differ, and demanding they match flagged 19 of 23 resources as broken when nothing was.
    // The question that actually matters for enumeration is the one below: can a caller tell a
    // business that EXISTS but is not theirs from one that does not exist at all?
    const ghost = await call("GET", `/v1/businesses/biz_ghost${uniq}/${r}/${fake}`, A.key);
    const own = await call("GET", `/v1/businesses/${A.biz.id}/${r}/${fake}`, A.key);

    if (foreign.status >= 500 || (foreign.status >= 200 && foreign.status < 300)) {
      leaks++;
      console.log(`    ↳ ${r}: foreign business answered ${foreign.status}`);
    }
    if (foreign.status !== ghost.status || shape(foreign.text) !== shape(ghost.text)) {
      mismatches++;
      console.log(
        `    ↳ ${r}: real-but-foreign ${foreign.status} ${JSON.stringify(shape(foreign.text).slice(0, 70))} ` +
          `vs nonexistent ${ghost.status} ${JSON.stringify(shape(ghost.text).slice(0, 70))}`,
      );
    }
    // A 500 on YOUR OWN business with an unknown id is a defect in its own right, and it is how
    // the uuid-cast bug in gateway_webhooks / gateway_requests / transfer_configurations was
    // found: those three compared a caller-supplied string against a raw uuid PK, so Postgres
    // `22P02` surfaced as a 500 where every sibling route answered 404.
    if (own.status >= 500) {
      ownErrors++;
      console.log(`    ↳ ${r}: OWN business + unknown id answered ${own.status} (expected 404)`);
    }
  }
  ok(
    `sweep: all ${RESOURCES.length} per-business resources refuse a foreign business id`,
    leaks === 0,
  );
  ok(
    "sweep: …and a real-but-foreign business is indistinguishable from a nonexistent one",
    mismatches === 0,
  );
  ok("sweep: …and an unknown id on your OWN business is a 404, never a 500", ownErrors === 0);
}

// ── B is untouched ───────────────────────────────────────────────────────────────
//
// Every write above was expected to fail. Proving the refusals were real — rather than
// 404s returned after the row was already changed — needs B to look at its own data.
{
  const cus = await B.sdk.customers.get(B.biz.id, B.customer.id);
  ok("integrity: B's customer name is unchanged", cus.first_name === "B");
  ok("integrity: B's customer is not archived", cus.active !== false);
  // No `products.get` on the SDK, so read it out of B's own list — which also proves
  // the row is still there rather than merely unmodified.
  const prods = await B.sdk.products.list(B.biz.id);
  const prod = prods.data.find((x) => x.id === B.product.id);
  ok("integrity: B's product name is unchanged", prod?.name === "B plan");
}

/**
 * ── ONE SCAN OVER EVERY RESPONSE A EVER RECEIVED ──────────────────────────────
 *
 * Each assertion above looks at one call, and mostly at its status code. This looks at
 * the BYTES of all of them at once, and asks the only question that ultimately matters:
 * did any value that belongs exclusively to B ever reach A? It catches the shape no
 * per-call check can — a leak through a route nobody thought to add here, or a body that
 * refused correctly and included the row anyway.
 *
 * Every marker is GLOBALLY unique, which is the whole trick. Keyed on invoice numbers
 * this control would be worthless: numbers are per-business, so A's first invoice and
 * B's first are both `INV-1` and the scan would "pass" on a collision. (Related: the
 * rendered invoice document names the CUSTOMER id, not the invoice id — another value
 * that is not what it looks like.) None of these is ever echoed by a route either, which
 * is why B's ids and B's coupon CODE are absent: an error body names the id you asked
 * for, so a scan for one would flag A's own refused requests.
 */
{
  const scan = (marker: string) => attackerSaw.find((r) => r.text.includes(marker));

  const offenders: string[] = [];
  for (const [what, marker] of [...B_SECRETS, ...B_CREDENTIALS]) {
    const hit = scan(marker);
    if (hit) offenders.push(`${what} → ${hit.path}`);
  }
  ok(
    `leak scan: none of B's ${B_SECRETS.length + B_CREDENTIALS.length} globally-unique values appears in any of the ` +
      `${attackerSaw.length} responses A received`,
    offenders.length === 0,
  );
  for (const o of offenders) console.log(`    ↳ LEAK: ${o}`);

  // ── The scan's own controls ────────────────────────────────────────────────
  //
  // A search for a string that exists nowhere passes over a total breach, so the
  // needle has to be proved to exist. Two different proofs, because the two marker
  // sets are different kinds of thing.
  ok("leak scan: …over a corpus of real requests, not an empty list", attackerSaw.length > 150);
  // (1) The mechanism finds what IS there: A's own payer email, in A's own reads.
  ok(
    "leak scan: …and the scan does find a value that is present (A's own email, in A's own responses)",
    scan(`A-${uniq}@acme.test`) !== undefined,
  );
  // (2) Each RENDERABLE marker is one B can actually see — so its absence from A's
  // responses is a boundary holding, not a field that no route ever prints.
  {
    const visible = [
      await call("GET", `/v1/businesses/${B.biz.id}/customers/${B.customer.id}`, B.key),
      await call("GET", `/v1/businesses/${B.biz.id}/transactions/${deepB.transaction}`, B.key),
      await call("GET", `/v1/businesses/${B.biz.id}/credit_notes/${deepB.creditNote}`, B.key),
      await call("GET", `/v1/businesses/${B.biz.id}/disputes/${deepB.dispute}`, B.key),
      await call("GET", `/v1/businesses/${B.biz.id}/gateway_accounts`, B.key),
    ]
      .map((r) => r.text)
      .join("");
    const unfindable = B_SECRETS.filter(([, m]) => !visible.includes(m)).map(([w]) => w);
    ok(
      `leak scan: …and all ${B_SECRETS.length} renderable markers ARE rendered to B (the needles exist)`,
      unfindable.length === 0,
    );
    if (unfindable.length)
      console.log(`    ↳ marker never rendered to anyone: ${unfindable.join(", ")}`);

    /**
     * The credential markers are the opposite case and are asserted as such: provider
     * credentials are rendered to NOBODY, B included. So their absence from A's
     * responses is not evidence of tenancy — this line is what gives them meaning. It
     * is a redaction control, and it is the one that matters most: `gateway_accounts`
     * holds the other tenant's live Stripe keys, and the day a serializer starts
     * spreading the raw row, this fails for B and the scan above fails for A.
     */
    const leakedToOwner = B_CREDENTIALS.filter(([, m]) => visible.includes(m)).map(([w]) => w);
    ok(
      "leak scan: …while provider credentials are rendered to nobody, B included",
      leakedToOwner.length === 0,
    );
    if (leakedToOwner.length)
      console.log(`    ↳ credential rendered by a route: ${leakedToOwner.join(", ")}`);
  }
}

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(`${checks.length} checks`);
console.log(pass ? "✅ BOLA: PASS" : "❌ BOLA: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
