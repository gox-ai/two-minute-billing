/**
 * verify:checkout-reminders — abandoned-checkout reminder emails (E6).
 *
 * Drives the sweep directly with chosen clocks: who is reminded (opted-in business, buyer
 * with an email, left over an hour ago, not complete), the second reminder and the stop
 * after it, the resume link, single-send under two sweeps, and the recovery reports.
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  completeCheckout,
  createCheckoutSession,
  resolveCheckoutSession,
  setCheckoutCustomer,
} from "@/modules/checkout/service";
import { sendCheckoutReminders } from "@/modules/checkout/reminders";
import { isEmailTypeEnabled, resolveEmailConfig } from "@/modules/emails/config";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { businesses, checkoutSessions, emailMessages } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

await loadGeoReference();
const org = await createOrganization({ name: "Reminder Co" });
const orgId = org.organization.id;
const newBiz = async (name: string, on: boolean) => {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ emailConfig: { enabled: true, types: on ? { checkout_reminder: true } : {} } })
      .where(eq(businesses.id, biz.id)),
  );
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Report pack",
    kind: "charge",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 4900,
  });
  return { biz, price };
};
const on = await newBiz("Opted in", true);
const off = await newBiz("Not opted in", false);

ok(
  "config: checkout_reminder is off unless switched on",
  !isEmailTypeEnabled(
    resolveEmailConfig({ emailConfig: { enabled: true, types: {} } }),
    "checkout_reminder",
  ) &&
    isEmailTypeEnabled(
      resolveEmailConfig({ emailConfig: { enabled: true, types: { checkout_reminder: true } } }),
      "checkout_reminder",
    ),
);

const address = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "California",
  stateCode: "CA",
  postalCode: "94105",
  country: "US",
  firstName: "Bu",
  lastName: "Yer",
};
/** A purchase checkout where the buyer gave an email, last active `agoMs` ago. */
const abandoned = async (b: typeof on, email: string | null, agoMs: number) => {
  const ref = await createCheckoutSession({
    organizationId: orgId,
    businessId: b.biz.id,
    priceId: b.price.publicId,
    mode: "purchase",
  });
  const ctx = (await resolveCheckoutSession(ref.token))!;
  if (email) await setCheckoutCustomer(ctx, { email, address });
  await withTenant(orgId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ lastUsedAt: new Date(Date.now() - agoMs) })
      .where(eq(checkoutSessions.publicId, ref.publicId)),
  );
  return ref;
};
const row = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, publicId)),
  ).then((r) => r[0]!);
const mailsFor = (to: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.toAddress, to), eq(emailMessages.type, "checkout_reminder"))),
  );
const HOUR = 3600_000;

const due = await abandoned(on, "due@example.com", 2 * HOUR);
const recent = await abandoned(on, "recent@example.com", 10 * 60_000);
const anonymous = await abandoned(on, null, 2 * HOUR);
const optedOut = await abandoned(off, "off@example.com", 2 * HOUR);

// Two sweeps at once: the claim lets only one of them send.
await Promise.all([sendCheckoutReminders(new Date()), sendCheckoutReminders(new Date())]);
const dueRow = await row(due.publicId);
const dueMails = await mailsFor("due@example.com");
ok("sweep: the abandoned buyer is reminded once, even with two sweeps", dueMails.length === 1);
ok(
  "sweep: the session records one reminder",
  dueRow.reminderCount === 1 && !!dueRow.lastRemindedAt,
);
ok(
  "sweep: the reminded checkout is kept open for two days",
  dueRow.expiresAt.getTime() > Date.now() + 47 * HOUR,
);
ok(
  "sweep: a buyer active ten minutes ago is not reminded",
  (await row(recent.publicId)).reminderCount === 0,
);
ok(
  "sweep: a checkout with no email is not reminded",
  (await row(anonymous.publicId)).reminderCount === 0,
);
ok(
  "sweep: a business that did not switch it on sends nothing",
  (await mailsFor("off@example.com")).length === 0 &&
    (await row(optedOut.publicId)).reminderCount === 0,
);
const mail = dueMails[0]!;
ok(
  "email: names the order and the total, queued for the outbox",
  mail.status === "pending" && /Report pack/.test(mail.bodyText) && /49/.test(mail.bodyText),
);
const link = /\/checkout\/s\/(cstk_[A-Za-z0-9_-]+)/.exec(mail.bodyHtml)?.[1];
const resumed = link ? await resolveCheckoutSession(link) : null;
ok("email: its link opens the same checkout", resumed?.sessionPublicId === due.publicId);

// A second reminder a day later, then none.
await withTenant(orgId, (tx) =>
  tx
    .update(checkoutSessions)
    .set({
      lastRemindedAt: new Date(Date.now() - 25 * HOUR),
      lastUsedAt: new Date(Date.now() - 2 * HOUR),
    })
    .where(eq(checkoutSessions.publicId, due.publicId)),
);
await sendCheckoutReminders(new Date());
ok(
  "second: a day later the buyer is reminded again",
  (await row(due.publicId)).reminderCount === 2,
);
await withTenant(orgId, (tx) =>
  tx
    .update(checkoutSessions)
    .set({ lastRemindedAt: new Date(Date.now() - 25 * HOUR) })
    .where(eq(checkoutSessions.publicId, due.publicId)),
);
await sendCheckoutReminders(new Date());
ok("second: there is no third reminder", (await mailsFor("due@example.com")).length === 2);

// The newest reminder's link completes the purchase: recovered.
const latest = (await mailsFor("due@example.com")).sort(
  (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
)[0]!;
const latestToken = /\/checkout\/s\/(cstk_[A-Za-z0-9_-]+)/.exec(latest.bodyHtml)?.[1];
const ctx = latestToken ? await resolveCheckoutSession(latestToken) : null;
const done = ctx ? await completeCheckout(ctx, {}) : null;
ok("recovery: the buyer completes through the reminder link", !!done?.invoiceId);
const completed = await abandoned(on, "completed@example.com", 2 * HOUR);
const cctx = (await resolveCheckoutSession(completed.token))!;
await completeCheckout(cctx, {});
await sendCheckoutReminders(new Date());
ok(
  "sweep: a completed checkout is not reminded",
  (await mailsFor("completed@example.com")).length === 0,
);

const rem = await resolveReport(orgId, on.biz.id, "checkout_reminders", { range: "12m" });
const counts = Object.fromEntries((rem.rows ?? []).map((r) => [r.group, r.value]));
ok(
  "report: 1 reminded, 1 completed after a reminder",
  counts.Reminded === 1 && counts["Completed after a reminder"] === 1,
);
const rev = await resolveReport(orgId, on.biz.id, "checkout_recovered_revenue", { range: "12m" });
ok("report: the recovered revenue is the purchase's paid total", rev.headline === 4900);

console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail ? 1 : 0);
