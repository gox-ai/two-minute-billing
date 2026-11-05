/**
 * verify:settings-invoice-rules — `businesses.invoice_rules_config` and the customer copy lists
 * (0486): small invoices, charge timing under net terms, and per-customer CC/BCC on document
 * emails.
 *
 * Each option must change behaviour, and an unset business must behave as before.
 *
 *   pnpm verify:settings-invoice-rules
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { runWithClockScope } from "@/platform/clock";
import {
  collectionDecision,
  resolveInvoiceRulesConfig,
} from "@/modules/invoicing/invoice-rules-config";
import {
  businesses,
  customers,
  emailMessages,
  invoices,
  payments,
  subscriptions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok]);
  if (!ok && detail) console.log(`    ✗ ${name}: ${detail}`);
};

type Res = { statusCode: number; payload: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => {
  try {
    return JSON.parse(r.payload);
  } catch {
    return {};
  }
};

const HOUR = 3_600_000;
const app = await buildApp({ logger: false });
const org = await createOrganization({ name: "Invoice Rules Co" });
const orgId = org.organization.id;
const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  }) as unknown as Promise<Res>;

async function newBiz(rules?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Rules",
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (rules || Object.keys(extra).length)
    await systemDb
      .update(businesses)
      .set({ ...(rules ? { invoiceRulesConfig: rules } : {}), ...extra })
      .where(eq(businesses.id, biz.id));
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  return { biz, price };
}

type Price = Awaited<ReturnType<typeof createPrice>>;

/** An active monthly subscription whose term ended a minute ago, ready to renew. */
async function dueSub(
  bizId: string,
  price: Price,
  opts: {
    token?: string;
    customer?: Record<string, unknown>;
    /** Reuse a customer (several subscriptions of one customer). */
    c?: Awaited<ReturnType<typeof createCustomer>>;
    /** The term end the renewal starts from; default a minute ago. */
    end?: Date;
    extra?: Price[];
  } = {},
) {
  let c = opts.c;
  if (!c) {
    c = await createCustomer({
      organizationId: orgId,
      businessId: bizId,
      email: `c${Math.random().toString(36).slice(2)}@example.com`,
    });
    if (opts.customer)
      await systemDb.update(customers).set(opts.customer).where(eq(customers.id, c.id));
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer: c,
      token: opts.token ?? "tok_4242",
    });
  }
  const { subscription, items } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: c.id,
    now: new Date(),
    items: [price, ...(opts.extra ?? [])].map((p) => ({ price: p, quantity: 1 })),
  });
  const end = opts.end ?? new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodStart: new Date(end.getTime() - 30 * 24 * HOUR), currentPeriodEnd: end })
    .where(eq(subscriptions.id, subscription.id));
  return { c, sub: subscription, items };
}

const subInvoices = (subId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subId))
      .orderBy(invoices.createdAt),
  );
const invoicePayments = (invId: string) =>
  withTenant(orgId, (tx) => tx.select().from(payments).where(eq(payments.invoiceId, invId)));
const reload = async (invId: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, invId)).limit(1))[0]!,
  );

// ── 1. Resolver ──────────────────────────────────────────────────────────────
{
  const d = resolveInvoiceRulesConfig(null);
  check(
    "resolver: unset = today (charge every amount, charge at creation)",
    d.smallInvoiceAction === "charge" && d.chargeTiming === "at_creation",
  );
  const bad = resolveInvoiceRulesConfig({
    invoiceRulesConfig: {
      small_invoice_action: "roll",
      small_invoice_thresholds: { usd: -1, EUR: 5 },
    },
  });
  check(
    "resolver: unknown values fall back; thresholds keep only positive integers",
    bad.smallInvoiceAction === "charge" &&
      JSON.stringify(bad.smallInvoiceThresholds) === JSON.stringify({ EUR: 5 }),
  );
  const now = new Date();
  const wo = {
    ...d,
    smallInvoiceAction: "write_off" as const,
    smallInvoiceThresholds: { USD: 100 },
  };
  check(
    "decision: below the limit writes off, at the limit charges",
    collectionDecision(
      wo,
      { status: "payment_due", amountDueMinor: 99n, currency: "usd", dueDate: now },
      now,
    ) === "write_off" &&
      collectionDecision(
        wo,
        { status: "payment_due", amountDueMinor: 100n, currency: "USD", dueDate: now },
        now,
      ) === "charge",
  );
}

// ── 2. API ───────────────────────────────────────────────────────────────────
{
  const { biz } = await newBiz();
  const before = json(await req("GET", `/v1/businesses/${biz.publicId}`));
  check(
    "API: an untouched business reads the resolved defaults",
    before.invoice_rules_config?.small_invoice_action === "charge" &&
      before.invoice_rules_config?.charge_timing === "at_creation",
    JSON.stringify(before.invoice_rules_config),
  );
  const patched = await req("PATCH", `/v1/businesses/${biz.publicId}`, {
    invoice_rules_config: {
      small_invoice_action: "write_off",
      small_invoice_thresholds: { usd: 2500 },
    },
  });
  const after = json(await req("GET", `/v1/businesses/${biz.publicId}`)).invoice_rules_config;
  check(
    "API: PATCH stores every key (thresholds upper-cased)",
    patched.statusCode === 200 &&
      after?.small_invoice_action === "write_off" &&
      after?.small_invoice_thresholds?.USD === 2500,
    `${patched.statusCode} ${JSON.stringify(after)}`,
  );
  const partial = await req("PATCH", `/v1/businesses/${biz.publicId}`, {
    invoice_rules_config: { charge_timing: "on_due_date" },
  });
  const merged = json(await req("GET", `/v1/businesses/${biz.publicId}`)).invoice_rules_config;
  check(
    "API: a partial PATCH keeps the other keys",
    partial.statusCode === 200 &&
      merged?.charge_timing === "on_due_date" &&
      merged?.small_invoice_action === "write_off",
  );
  for (const [key, value] of [
    ["small_invoice_action", "roll"],
    ["charge_timing", "customer_chooses"],
    ["hold_hours", 2],
  ] as const) {
    const r = await req("PATCH", `/v1/businesses/${biz.publicId}`, {
      invoice_rules_config: { [key]: value },
    });
    const kept = json(await req("GET", `/v1/businesses/${biz.publicId}`)).invoice_rules_config;
    check(
      `API: ${key}=${value} (no backend) is refused or ignored`,
      r.statusCode === 400 || (kept && !(key in kept)),
      `${r.statusCode}`,
    );
  }

  const created = await req("POST", `/v1/businesses/${biz.publicId}/customers`, {
    email: "copies@example.com",
    billing_cc_emails: ["finance@example.com"],
    billing_bcc_emails: ["audit@example.com"],
  });
  const cus = json(created);
  check(
    "API: a customer stores the copy lists",
    created.statusCode === 201 &&
      cus.billing_cc_emails?.[0] === "finance@example.com" &&
      cus.billing_bcc_emails?.[0] === "audit@example.com",
    `${created.statusCode} ${created.payload.slice(0, 200)}`,
  );
  const badEmail = await req("PATCH", `/v1/businesses/${biz.publicId}/customers/${cus.id}`, {
    billing_bcc_emails: ["not-an-email"],
  });
  check("API: a malformed BCC address is a 400", badEmail.statusCode === 400);

  const viaKey = json(
    await req("POST", "/v1/businesses", { name: "Key-made", default_currency: "USD" }),
  );
  check(
    "API: a new business keeps today's rules",
    viaKey.invoice_rules_config?.small_invoice_action === "charge" &&
      viaKey.invoice_rules_config?.charge_timing === "at_creation",
    JSON.stringify(viaKey.invoice_rules_config),
  );
}

// ── 3. Unset business: renewal charges at once (today) ───────────────────────
{
  const { biz, price } = await newBiz();
  const { sub } = await dueSub(biz.id, price);
  await renewSubscription(orgId, sub.id, new Date());
  const [inv] = await subInvoices(sub.id);
  const pays = inv ? await invoicePayments(inv.id) : [];
  check(
    "unset: the renewal invoice is finalized and paid at once",
    inv?.status === "paid" && pays.some((p) => p.status === "succeeded"),
    `${inv?.status} pays=${pays.length}`,
  );
}

// ── 7. Charge timing under net terms ─────────────────────────────────────────
{
  const { biz, price } = await newBiz({ charge_timing: "on_due_date" });
  const { sub } = await dueSub(biz.id, price, { customer: { netTermDays: 15 } });
  const t0 = new Date();
  await renewSubscription(orgId, sub.id, t0);
  let [inv] = await subInvoices(sub.id);
  check(
    "on due date: a Net 15 auto-collected invoice is not charged at creation",
    inv?.status === "posted" && (await invoicePayments(inv.id)).length === 0,
    `${inv?.status}`,
  );
  const due = new Date(inv!.dueDate!.getTime() + 60_000);
  await runWithClockScope({ onlyBusinessId: biz.id, now: due }, () =>
    runInvoiceDueTransitions(due),
  );
  inv = await reload(inv!.id);
  check("on due date: the due-date pass charges it", inv.status === "paid", inv.status);

  const { sub: s2 } = await dueSub(biz.id, price);
  await renewSubscription(orgId, s2.id, t0);
  const [net0] = await subInvoices(s2.id);
  check("on due date: an invoice with no net terms is charged at once", net0?.status === "paid");

  const { biz: b2, price: p2 } = await newBiz();
  const { sub: s3 } = await dueSub(b2.id, p2, { customer: { netTermDays: 15 } });
  await renewSubscription(orgId, s3.id, t0);
  const [atCreation] = await subInvoices(s3.id);
  check(
    "at creation (unset): a Net 15 auto-collected invoice is charged at once",
    atCreation?.status === "paid",
    atCreation?.status,
  );
}

// ── 8. Small invoices ────────────────────────────────────────────────────────
{
  const { biz, price } = await newBiz({
    small_invoice_action: "write_off",
    small_invoice_thresholds: { USD: 6000 },
  });
  const { sub } = await dueSub(biz.id, price);
  await renewSubscription(orgId, sub.id, new Date());
  const [inv] = await subInvoices(sub.id);
  check(
    "small invoice: below the limit it is written off, not charged",
    inv?.writtenOff === true && (await invoicePayments(inv.id)).length === 0,
    `${inv?.status} wo=${inv?.writtenOff}`,
  );
  const { biz: b2, price: p2 } = await newBiz({
    small_invoice_action: "write_off",
    small_invoice_thresholds: { USD: 5000 },
  });
  const { sub: s2 } = await dueSub(b2.id, p2);
  await renewSubscription(orgId, s2.id, new Date());
  const [at] = await subInvoices(s2.id);
  check("small invoice: at the limit it is charged", at?.status === "paid" && !at.writtenOff);

  // Auto-collection off: the customer pays the invoice; nothing is written off.
  const { sub: s3 } = await dueSub(biz.id, price, { customer: { autoCollection: "off" } });
  await renewSubscription(orgId, s3.id, new Date());
  const [offline] = await subInvoices(s3.id);
  check(
    "small invoice: an invoice the customer pays (auto-collection off) is not written off",
    offline != null && !offline.writtenOff && offline.status !== "paid",
    `${offline?.status} wo=${offline?.writtenOff}`,
  );
}

// ── 9. Customer CC and BCC on document emails ────────────────────────────────
{
  const { biz, price } = await newBiz(undefined, { emailConfig: { enabled: true } });
  const { c, sub } = await dueSub(biz.id, price, {
    customer: {
      billingCcEmails: ["finance@example.com"],
      billingBccEmails: ["audit@example.com", "finance@example.com"],
    },
  });
  await renewSubscription(orgId, sub.id, new Date());
  const mails = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.customerId, c.id))),
  );
  const invoiceMail = mails.find(
    (m) => m.type === "invoice_issued" || m.type === "payment_receipt",
  );
  check(
    "copies: an invoice email carries the customer CC and BCC lists",
    !!invoiceMail &&
      invoiceMail.ccAddresses.includes("finance@example.com") &&
      invoiceMail.bccAddresses.includes("audit@example.com"),
    JSON.stringify(mails.map((m) => [m.type, m.ccAddresses, m.bccAddresses])),
  );
  check(
    "copies: an address already in CC is not also in BCC",
    !!invoiceMail && !invoiceMail.bccAddresses.includes("finance@example.com"),
  );
  const accountMail = mails.find((m) => m.type === "subscription_renewed");
  check(
    "copies: an account email (not about a document) gets no customer copies",
    !accountMail ||
      (accountMail.bccAddresses.length === 0 &&
        !accountMail.ccAddresses.includes("finance@example.com")),
  );
}

await app.close();
await closeDb();
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
