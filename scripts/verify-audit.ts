/**
 * H2 (LOG-3) — audit log. A scripted admin session produces the expected audit
 * rows (actor/action/diff), and the table is APPEND-ONLY (UPDATE/DELETE are denied
 * at the grant level, not just by convention).
 *
 *   pnpm verify:audit
 */
import { sql } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import {
  runWithEventContext,
  eventContextHook,
  updateEventContext,
  clientIp,
} from "@/platform/event-context";
import { withTraceContext } from "@/platform/trace";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscriptionWithOptions } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  voidInvoice,
  createManualInvoice,
  collectInvoiceNow,
  recordOfflinePayment,
  writeOffInvoice,
  regenerateInvoice,
} from "@/modules/invoicing/ops";
import { closeInvoice } from "@/modules/invoicing/pending";
import { stopDunning, pauseDunning } from "@/modules/subscriptions/dunning";
import {
  issueRefundableCreditNote,
  refundCreditNote,
  recordOfflineCnRefund,
  voidCreditNote,
} from "@/modules/credit-notes/service";
import { listAuditLogs, writeAuditLog } from "@/modules/audit/service";
import { auditLogs, subscriptions, invoices } from "@db/schema";
import { eq, and } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Audit Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Audit Biz",
  defaultCurrency: "USD",
  livemode: "test",
});

// A scripted admin session — bind an actor so audit rows carry provenance.
await runWithEventContext({ source: "api", actor: "key_admin123" }, async () => {
  await updateBusiness(orgId, biz.publicId, {
    invoiceRounding: "nearest_unit",
    defaultCancelOption: "end_of_term",
  });

  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "audit@a.com",
    autoCollection: "off",
    address: { country: "US" },
  });
  const prod = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const fresh = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1),
    )
  )[0]!;
  const bill = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  await voidInvoice(orgId, biz.id, bill.invoice.publicId);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
  });
});

const rows = await listAuditLogs(orgId, { businessId: biz.id });
const byAction = (a: string) => rows.find((r) => r.action === a);
ok("audit: business.settings_update recorded", !!byAction("business.settings_update"));
ok(
  "audit: settings diff carries the changed fields",
  (byAction("business.settings_update")?.after as Record<string, unknown> | undefined)
    ?.invoiceRounding === "nearest_unit",
);
ok("audit: invoice.void recorded", !!byAction("invoice.void"));
ok("audit: subscription.cancel recorded", !!byAction("subscription.cancel"));
ok(
  "audit: actor threaded from EventContext",
  rows.every((r) => r.actor === "key_admin123"),
);
ok(
  "audit: source recorded",
  rows.every((r) => r.source === "api"),
);

/**
 * Was this refusal Postgres denying the grant?
 *
 * ⚠ Walk the CAUSE CHAIN — do not read `e.message`. drizzle-orm 0.45 wraps every failure in a
 * `DrizzleQueryError` whose message is a generic `Failed query: update "audit_logs" …`, with the
 * real `PostgresError` (code 42501, "permission denied for table audit_logs") one level down in
 * `.cause`. The four append-only checks in this file matched on the word "permission" in the
 * top-level message, so the 0.36 -> 0.45 upgrade turned them all red while the guarantee itself
 * was completely intact — the UPDATE was still being refused, exactly as it always had been.
 *
 * Asserting on the SQLSTATE is the durable form: 42501 is Postgres's, not an ORM's, and it
 * cannot be changed by a dependency bump. Matching on message text was the real defect here,
 * and it was latent long before the upgrade exposed it.
 */
function isGrantDenial(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const err = cur as { code?: string; message?: string; cause?: unknown };
    if (err.code === "42501") return true;
    if (
      String(err.message ?? "")
        .toLowerCase()
        .includes("permission denied")
    )
      return true;
    cur = err.cause;
  }
  return false;
}

// Append-only: UPDATE and DELETE must be denied at the grant level.
let updateDenied = false;
try {
  await withTenant(orgId, (tx) => tx.update(auditLogs).set({ action: "tampered" }));
} catch (e: unknown) {
  updateDenied = isGrantDenial(e);
}
ok("audit: UPDATE is denied (append-only)", updateDenied);

let deleteDenied = false;
try {
  await withTenant(orgId, (tx) => tx.delete(auditLogs));
} catch (e: unknown) {
  deleteDenied = isGrantDenial(e);
}
ok("audit: DELETE is denied (append-only)", deleteDenied);

// Direct writeAuditLog (no request context) defaults actor/source to 'system'.
await writeAuditLog({
  organizationId: orgId,
  businessId: biz.id,
  action: "test.direct",
  resourceType: "test",
  resourceId: "t1",
});
const direct = (await listAuditLogs(orgId, { businessId: biz.id, action: "test.direct" }))[0];
ok(
  "audit: direct write defaults actor/source=system",
  direct?.actor === "system" && direct?.source === "system",
);

// ── P4: the actor's IP, and audit coverage across the money ops ───────────────
//
// Two things are under test here. (1) The IP travels the same road as
// actor/source: resolved once by the Fastify hook and carried on the ambient
// EventContext — so this drives ops through the REAL `eventContextHook`, not a
// hand-built context, or the capture path itself would go unproven. (2) Every
// operator-driven invoicing / credit-note op now leaves an audit row with a
// non-empty, actually-differing before/after diff — the drill-in has nothing to
// show otherwise.
const REQUEST_IP = "203.0.113.7";

/**
 * Run `fn` as if it were inside an HTTP request. The IP is handed over in its
 * IPv4-mapped IPv6 form (`::ffff:…`), which is what Node reports on a dual-stack
 * socket, so this also proves the normalization: the stored value must be the
 * plain dotted quad, or "actions from this IP" would split into two addresses.
 */
function asRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    eventContextHook({ headers: {}, ip: `::ffff:${REQUEST_IP}` }, {}, () => {
      // What `authenticate` does once the API key resolves.
      updateEventContext({ actor: "key_p4" });
      fn().then(resolve, reject);
    });
  });
}

const p4Price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: (await createProduct({ organizationId: orgId, businessId: biz.id, name: "P4 Plan" }))
    .id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const oneTime = (description: string, amountMinor: number) => ({
  description,
  amountMinor: BigInt(amountMinor),
  kind: "one_time" as const,
});
const reload = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );

let pendingInvoiceId = "";

await asRequest(async () => {
  // A card-paid invoice: collect → refundable CN → gateway refund.
  const card = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "p4-card@a.com",
    currency: "USD",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: card,
    token: "tok_4242",
  });
  const collectMe = (
    await createManualInvoice({
      organizationId: orgId,
      businessId: biz.id,
      customerId: card.id,
      currency: "USD",
      lines: [oneTime("Collect me", 5000)],
    })
  ).invoice;
  await collectInvoiceNow(orgId, biz.id, collectMe.publicId);
  const refundable = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: collectMe.publicId,
    items: [{ description: "Goodwill", amountMinor: 1000 }],
  });
  await refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: refundable.publicId,
  });

  // An offline-paid invoice: record payment → offline CN refund → CN void.
  const offline = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "p4-offline@a.com",
    currency: "USD",
    address: { country: "US" },
  });
  const wired = (
    await createManualInvoice({
      organizationId: orgId,
      businessId: biz.id,
      customerId: offline.id,
      currency: "USD",
      lines: [oneTime("Wire me", 9000)],
    })
  ).invoice;
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: wired.publicId,
    method: "wire",
  });
  const offlineCn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: wired.publicId,
    items: [{ description: "Cheque back", amountMinor: 2000 }],
  });
  await recordOfflineCnRefund({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: offlineCn.publicId,
    method: "check",
    reference: "CHQ-4471",
  });
  const doomedCn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: wired.publicId,
    items: [{ description: "Issued in error", amountMinor: 1000 }],
  });
  await voidCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: doomedCn.publicId,
  });

  // Write-off (routes through an adjustment credit note → both rows, one tx).
  const badDebtor = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "p4-writeoff@a.com",
    currency: "USD",
    address: { country: "US" },
  });
  const unpaid = (
    await createManualInvoice({
      organizationId: orgId,
      businessId: biz.id,
      customerId: badDebtor.id,
      currency: "USD",
      lines: [oneTime("Never paying", 6000)],
    })
  ).invoice;
  await writeOffInvoice(orgId, biz.id, unpaid.publicId);

  // A retriable decline drops the invoice to payment_due → dunning can be paused, then stopped.
  // This is a MANUAL invoice (no subscription), so it falls under "Dunning for one-time
  // invoices", which we default OFF — without opting in the decline settles
  // straight to not_paid, the guard below goes false, and the two dunning audit rows are
  // never written. The subject here is the AUDIT ROW, not the dunning default, so opt in.
  await updateBusiness(orgId, biz.publicId, { dunningConfig: { dun_one_time_invoices: true } });
  const decliner = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "p4-dunning@a.com",
    currency: "USD",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: decliner,
    token: "tok_4000000000009995",
  });
  const failing = (
    await createManualInvoice({
      organizationId: orgId,
      businessId: biz.id,
      customerId: decliner.id,
      currency: "USD",
      lines: [oneTime("Declines", 4000)],
    })
  ).invoice;
  await collectInvoiceNow(orgId, biz.id, failing.publicId);
  // Assert rather than silently skip: a guard that goes false must not read as a pass.
  ok(
    "P4: retriable decline on a dunned one-time invoice → payment_due",
    (await reload(failing.id)).status === "payment_due",
  );
  await pauseDunning(orgId, biz.id, failing.publicId, new Date(Date.now() + 7 * 86_400_000));
  await stopDunning(orgId, biz.id, failing.publicId);

  // Regenerate: void a subscription period invoice, then rebill the same period.
  const subCust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "p4-sub@a.com",
    autoCollection: "off",
    address: { country: "US" },
  });
  const { subscription: s } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: subCust.id,
    now: new Date(),
    items: [{ price: p4Price, quantity: 1 }],
  });
  const sFresh = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, s.id)).limit(1),
    )
  )[0]!;
  // A window of its own: `regenerateInvoice` refuses while a live invoice still
  // covers the (subscription, period) pair.
  // Active, not trialling, so the term exists (a trialling subscription has none since
  // 2026-08-25).
  const nextStart = sFresh.currentPeriodEnd!;
  if (!nextStart)
    throw new Error("expected a subscription with a term; got one without (in trial?)");
  const nextEnd = new Date(nextStart.getTime() + 30 * 86_400_000);
  const toRegen = (
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sFresh,
      periodStart: nextStart,
      periodEnd: nextEnd,
    })
  ).invoice;
  await voidInvoice(orgId, biz.id, toRegen.publicId);
  await regenerateInvoice(orgId, biz.id, toRegen.publicId);

  // A pending draft, closed below by the CLOCK (not by this request).
  const laterStart = new Date(nextEnd.getTime() + 30 * 86_400_000);
  const draft = (
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sFresh,
      periodStart: laterStart,
      periodEnd: new Date(laterStart.getTime() + 30 * 86_400_000),
      createAsPending: true,
    })
  ).invoice;
  pendingInvoiceId = draft.publicId;
});

// The auto-close pass runs under the billing clock — same op, no request behind it.
await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, () =>
  closeInvoice(orgId, biz.id, pendingInvoiceId),
);

const p4 = await listAuditLogs(orgId, { businessId: biz.id, limit: 500 });
const row = (action: string) => p4.find((r) => r.action === action);
/** A diff must exist on both sides AND actually differ — `{}`→`{}` documents nothing. */
const diffed = (action: string): boolean => {
  const r = row(action);
  const before = r?.before as Record<string, unknown> | null | undefined;
  const after = r?.after as Record<string, unknown> | null | undefined;
  if (!before || !after) return false;
  const keys = Object.keys(before).concat(Object.keys(after));
  if (keys.length === 0) return false;
  return keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
};

// (1) The IP is captured, normalized, and carried without any service signature change.
ok(
  "P4: an API-driven op records the request IP",
  row("invoice.record_payment")?.actorIp === REQUEST_IP,
);
ok(
  "P4: IPv4-mapped IPv6 is normalized to the dotted quad",
  p4.filter((r) => r.actor === "key_p4").every((r) => r.actorIp === REQUEST_IP),
);
ok(
  "P4: every request-context row has an IP",
  p4.filter((r) => r.actor === "key_p4").length > 0 &&
    p4.filter((r) => r.actor === "key_p4").every((r) => r.actorIp !== null),
);

// (2) A clock-driven op leaves it NULL — never a placeholder.
const closed = row("invoice.close");
ok("P4: clock-driven op recorded (invoice.close)", !!closed && closed.source === "scheduled_job");
ok("P4: clock-driven op leaves the IP null (no fake value)", closed?.actorIp === null);
ok(
  "P4: earlier no-request rows stay null too",
  p4.filter((r) => r.source !== "api").every((r) => r.actorIp === null),
);
ok(
  "P4: the IP is normalized for `inet` (zone stripped, junk dropped)",
  // `fe80::1%eth0` is a valid address to an OS and a syntax error to Postgres
  // `inet` — keep the address, drop the interface. Anything unparseable becomes
  // NULL rather than a guess, and must never abort the money tx it rides in.
  clientIp({ ip: "fe80::1%eth0" }) === "fe80::1" &&
    clientIp({ ip: "198.51.100.9" }) === "198.51.100.9" &&
    clientIp({ ip: "unknown" }) === null &&
    clientIp({ ip: "10.0.0.999" }) === null &&
    clientIp(undefined) === null,
);

// (3) Every newly-audited op wrote a row carrying a real diff.
for (const action of [
  "invoice.close",
  "invoice.collect",
  "invoice.write_off",
  "invoice.record_payment",
  "invoice.regenerate",
  "invoice.stop_dunning",
  "invoice.pause_dunning",
  "credit_note.create",
  "credit_note.refund",
  "credit_note.record_refund",
  "credit_note.void",
]) {
  ok(`P4: ${action} recorded with a before/after diff`, diffed(action));
}

// The append-only guarantee must still hold with the new column in place.
let ipUpdateDenied = false;
try {
  await withTenant(orgId, (tx) =>
    tx
      .update(auditLogs)
      .set({ actorIp: "10.0.0.1" })
      .where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "invoice.close"))),
  );
} catch (e: unknown) {
  ipUpdateDenied = isGrantDenial(e);
}
ok("P4: actor_ip cannot be rewritten (still append-only)", ipUpdateDenied);

// ── 0149: trace grouping, full-record snapshots, and GDPR erasure ─────────────
// The three properties the Activity Log rests on. Each is
// load-bearing in a way a typecheck cannot see: without the trace an action that
// touched two resources reads as two unrelated entries; without the snapshot the
// contextual diff cannot be rendered at all; and without the erasure hook the
// snapshot silently becomes PII that `clearPersonalData` is unable to reach.
const { getAuditRecord, eraseAuditSnapshotsForResource } = await import("@/modules/audit/service");
const { updateCustomer, clearPersonalData } = await import("@/modules/customers/service");
const { auditLogSnapshots } = await import("@db/schema");

// One trace, two resources: the record must come back as ONE record with both.
const traced = await withTraceContext({ traceId: "verify-audit-0149" }, async () =>
  runWithEventContext({ source: "api", actor: "key_admin123", ip: "203.0.113.9" }, async () => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "snap@a.com",
      address: { country: "US" },
    });
    await updateCustomer({
      organizationId: orgId,
      businessId: biz.id,
      customerPublicId: c.publicId,
      autoCollection: "off",
      company: "Acme",
    });
    return c;
  }),
);

const tracedRows = await listAuditLogs(orgId, { businessId: biz.id, resourceId: traced.publicId });
const created = tracedRows.find((r) => r.action === "customer.create")!;
const updated = tracedRows.find((r) => r.action === "customer.update")!;
ok("0149: customer.create is audited", !!created);
ok("0149: customer.update is audited", !!updated);
ok("0149: audit rows carry the ambient trace", created?.traceId === "verify-audit-0149");

const record = await getAuditRecord(orgId, biz.id, updated.id, "customer");
ok("0149: one trace resolves to ONE record", !!record);
ok("0149: the record holds a block per audited resource", (record?.blocks.length ?? 0) === 2);
// `?source=` hoists the reader's own resource, so the leading block is theirs.
ok(
  "0149: source hoists its block to the front",
  record?.blocks[0]?.row.resourceType === "customer",
);
// occurredAt is the action's START, so the same record reads the same time from
// whichever page it was opened from.
ok(
  "0149: occurredAt is the first row of the action",
  record?.occurredAt.getTime() === Math.min(...tracedRows.map((r) => r.createdAt.getTime())),
);

const createBlock = record?.blocks.find((b) => b.row.action === "customer.create");
const updateBlock = record?.blocks.find((b) => b.row.action === "customer.update");
// A creation must be distinguishable from "no snapshot captured" — it is what makes
// the UI show the new record's body instead of a diff against nothing.
ok(
  "0149: a creation's snapshot is 'created' with a null before-side",
  createBlock?.snapshot === "created" && createBlock?.beforeFull === null,
);
ok(
  "0149: a creation carries the full new record",
  Object.keys((createBlock?.afterFull ?? {}) as object).length > 10,
);
ok(
  "0149: an update's snapshot is 'available' on both sides",
  updateBlock?.snapshot === "available",
);
ok(
  "0149: the snapshot holds the WHOLE record, not just changed fields",
  Object.keys((updateBlock?.beforeFull ?? {}) as object).length >
    Object.keys((updateBlock?.row.before ?? {}) as object).length,
);
// The changed-field map and the snapshot are derived from each other, so they can
// never disagree: every changed key must actually differ across the snapshots.
const chg = (updateBlock?.row.after ?? {}) as Record<string, unknown>;
const bf = (updateBlock?.beforeFull ?? {}) as Record<string, unknown>;
const af = (updateBlock?.afterFull ?? {}) as Record<string, unknown>;
ok(
  "0149: every changed field really differs between the snapshots",
  Object.keys(chg).length > 0 &&
    Object.keys(chg).every((k) => JSON.stringify(bf[k]) !== JSON.stringify(af[k])),
);
ok(
  "0149: the diff records the real change",
  bf.auto_collection === "on" && af.auto_collection === "off",
);

// A bigint column (mrr) must survive the snapshot: JSON.stringify THROWS on bigint,
// so a subscription snapshot would have crashed the very action it was auditing.
const subRows = await listAuditLogs(orgId, { businessId: biz.id, resourceType: "subscription" });
const subCreate = subRows.find((r) => r.action === "subscription.create");
ok("0149: subscription.create is audited", !!subCreate);
const subRecord = subCreate
  ? await getAuditRecord(orgId, biz.id, subCreate.id, "subscription")
  : null;
const subSnap = (subRecord?.blocks.find((b) => b.row.action === "subscription.create")?.afterFull ??
  {}) as Record<string, unknown>;
ok(
  "0149: a bigint column is snapshotted as a string of minor units",
  typeof subSnap.mrr === "string",
);
ok(
  "0149: the snapshot carries the subscription items",
  Array.isArray(subSnap.items) && (subSnap.items as unknown[]).length > 0,
);
// Internal uuids are dropped; the public id is surfaced as `id`.
ok(
  "0149: the snapshot surfaces the public id, not the uuid",
  typeof subSnap.id === "string" && String(subSnap.id).startsWith("sub_"),
);
ok("0149: internal FK uuids are dropped from the snapshot", !("customer_id" in subSnap));

// UPDATE must be denied on the snapshot table too: a snapshot is kept or dropped,
// never rewritten, so a surviving row is still exactly what was recorded.
let snapUpdateDenied = false;
try {
  await withTenant(orgId, (tx) =>
    tx
      .update(auditLogSnapshots)
      .set({ afterFull: { tampered: true } })
      .where(eq(auditLogSnapshots.organizationId, orgId)),
  );
} catch (e: unknown) {
  snapUpdateDenied = isGrantDenial(e);
}
ok("0149: a snapshot cannot be rewritten (no UPDATE grant)", snapUpdateDenied);

// GDPR: erasure drops the snapshot BODIES and leaves the audit ROWS untouched.
const rowsBefore = (await listAuditLogs(orgId, { businessId: biz.id, resourceId: traced.publicId }))
  .length;
await runWithEventContext({ source: "api", actor: "key_admin123", ip: "203.0.113.9" }, () =>
  clearPersonalData(orgId, biz.id, traced.publicId),
);
const afterErase = await getAuditRecord(orgId, biz.id, updated.id, "customer");
const rowsAfter = await listAuditLogs(orgId, { businessId: biz.id, resourceId: traced.publicId });
ok("0149: erasure leaves every audit row in place", rowsAfter.length >= rowsBefore);
ok(
  "0149: erasure drops the snapshot bodies",
  afterErase?.blocks.every((b) => b.snapshot === "none") === true,
);
ok(
  "0149: erasure preserves the changed-field diff (the audit trail survives)",
  Object.keys(
    (afterErase?.blocks.find((b) => b.row.action === "customer.update")?.row.after ?? {}) as object,
  ).length > 0,
);
ok(
  "0149: the erasure itself is audited",
  rowsAfter.some((r) => r.action === "customer.clear_personal_data"),
);
// "erased 0" and "erasure failed" must not look alike, so the count is recorded.
const eraseRow = rowsAfter.find((r) => r.action === "customer.clear_personal_data");
ok(
  "0149: the erasure records how many snapshots it dropped",
  typeof ((eraseRow?.after ?? {}) as Record<string, unknown>).snapshots_erased === "number",
);
// Idempotent: erasing again finds nothing left and must not throw.
ok(
  "0149: erasing twice is a no-op, not an error",
  (await eraseAuditSnapshotsForResource(orgId, "customer", traced.publicId)) === 0,
);

// ── #37: a rate-source change writes an audit row ─────────────────────────────
//
// `setCurrencyRateSource` / `removeCurrency` used to UPDATE `businesses` directly,
// bypassing the audited settings patch, so "who switched INR to auto, and when" was
// unanswerable on the field that decides what every conversion uses.
//
// Three things are under test: the row exists with the vocabulary the rest of the
// codebase uses, the diff carries ONLY what changed (so a failed `auto` fetch records
// the SOURCE change without implying the rate moved), and the row is written in the
// SAME transaction as the change it records — proved by comparing `xmin`, Postgres's
// own per-row transaction id, rather than by trusting the call site's shape.
const { setCurrencyRateSource, removeCurrency } = await import("@/modules/tenancy/exchange-rates");
const { FxProviderError } = await import("@/platform/fx/types");
type Fx = import("@/platform/fx/types").FxProvider;

const fxUp: Fx = {
  name: "stubfx",
  async fetchRates(base) {
    return { base, asOf: new Date("2026-09-01T00:00:00Z"), rates: { INR: "94.9537410000" } };
  },
};
const fxDown: Fx = {
  name: "stubfx",
  async fetchRates() {
    throw new FxProviderError("stub feed unreachable", "stubfx");
  },
};

// A restrictive currency list, so enabling INR is a real change to `currencies` too.
await updateBusiness(orgId, biz.publicId, { currencies: ["USD"] });
await runWithEventContext({ source: "api", actor: "key_fx37" }, async () => {
  await setCurrencyRateSource({
    organizationId: orgId,
    businessId: biz.id,
    currency: "inr",
    source: "manual",
    rate: "90.5",
    now: new Date(),
  });
  // The rate MOVES: source manual→auto and a new number from the feed.
  await setCurrencyRateSource({
    organizationId: orgId,
    businessId: biz.id,
    currency: "INR",
    source: "auto",
    now: new Date(),
    provider: fxUp,
  });
  await setCurrencyRateSource({
    organizationId: orgId,
    businessId: biz.id,
    currency: "EUR",
    source: "manual",
    rate: "0.91",
    now: new Date(),
  });
  // The fetch FAILS: still a 200, still `auto`, previous rate stands, `last_error` says why.
  await setCurrencyRateSource({
    organizationId: orgId,
    businessId: biz.id,
    currency: "EUR",
    source: "auto",
    now: new Date(),
    provider: fxDown,
  });
  await removeCurrency({
    organizationId: orgId,
    businessId: biz.id,
    currency: "INR",
    now: new Date(),
  });
});

const fxRows = await listAuditLogs(orgId, {
  businessId: biz.id,
  action: "business.set_currency_rate_source",
});
const rmRows = await listAuditLogs(orgId, {
  businessId: biz.id,
  action: "business.remove_currency",
});
const diffOf = (r: (typeof fxRows)[number] | undefined) => ({
  before: (r?.before ?? {}) as Record<string, unknown>,
  after: (r?.after ?? {}) as Record<string, unknown>,
});
const forCcy = (rows: typeof fxRows, ccy: string) =>
  rows.filter((r) => ((r.after ?? {}) as Record<string, unknown>).currency === ccy);

ok("#37: switching a rate source writes an audit row", fxRows.length === 4);
ok("#37: removing a currency writes an audit row", rmRows.length === 1);
ok(
  "#37: the row names the BUSINESS as its resource, by public id",
  fxRows.length > 0 &&
    fxRows.every((r) => r.resourceType === "business" && r.resourceId === biz.publicId),
);
ok(
  "#37: actor and source come from the ambient EventContext",
  fxRows.length + rmRows.length === 5 &&
    [...fxRows, ...rmRows].every((r) => r.actor === "key_fx37" && r.source === "api"),
);

// The rate MOVED: both sides carry the number, so the row says what it moved from.
const inrAuto = diffOf(
  forCcy(fxRows, "INR").find((r) => ((r.after ?? {}) as Record<string, unknown>).source === "auto"),
);
ok(
  "#37: the diff names the currency it is about",
  inrAuto.before.currency === "INR" && inrAuto.after.currency === "INR",
);
ok(
  "#37: a manual→auto switch is recorded as a source change",
  inrAuto.before.source === "manual" && inrAuto.after.source === "auto",
);
ok(
  "#37: a rate that MOVED is recorded on both sides",
  inrAuto.before.rate === "90.5" && inrAuto.after.rate === "94.9537410000",
);
ok("#37: the provider that produced the new rate is recorded", inrAuto.after.provider === "stubfx");
// Enabling the currency is part of the same write, so it is part of the same diff.
const inrManual = diffOf(
  forCcy(fxRows, "INR").find(
    (r) => ((r.after ?? {}) as Record<string, unknown>).source === "manual",
  ),
);
ok(
  "#37: enabling the currency is recorded as a change to the enabled list",
  JSON.stringify(inrManual.before.currencies) === JSON.stringify(["USD"]) &&
    JSON.stringify(inrManual.after.currencies) === JSON.stringify(["USD", "INR"]),
);

// ⚠ The failed-fetch case: the SOURCE changed and the rate did NOT.
const eurAuto = diffOf(
  forCcy(fxRows, "EUR").find((r) => ((r.after ?? {}) as Record<string, unknown>).source === "auto"),
);
ok(
  "#37: a FAILED auto fetch still records the source change",
  eurAuto.before.source === "manual" && eurAuto.after.source === "auto",
);
ok(
  "#37: …and records WHY the rate did not move",
  String(eurAuto.after.last_error).includes("stub feed unreachable"),
);
ok(
  "#37: …and does NOT imply a rate moved when it did not",
  // Non-vacuous on purpose: the row has to BE a source change for the absent `rate` to
  // mean "unchanged" rather than "no row at all".
  eurAuto.after.source === "auto" && !("rate" in eurAuto.before) && !("rate" in eurAuto.after),
);

// A removal is the rate and its provenance going away, not a silent shrink of a list.
const rm = diffOf(rmRows[0]);
ok(
  "#37: a removal records the rate it deleted",
  rm.before.currency === "INR" && rm.before.rate === "94.9537410000",
);
ok("#37: a removal records the fields as gone", rm.after.rate === null && rm.after.source === null);

/**
 * ATOMICITY. `xmin` is the id of the transaction that produced a row version, so an
 * audit row written in the caller's `tx` shares it with the `businesses` UPDATE it
 * records. An audit row that can survive a rolled-back change (or vice versa) is worse
 * than none, and this is the only assertion that can tell the two call shapes apart.
 *
 * The removal is the LAST write to this business row, so its `xmin` is the one still
 * standing.
 */
const [xminBiz] = (await withTenant(orgId, (tx) =>
  tx.execute(sql`select xmin::text as x from businesses where id = ${biz.id}`),
)) as unknown as Array<{ x: string }>;
const [xminAudit] = rmRows[0]
  ? ((await withTenant(orgId, (tx) =>
      tx.execute(sql`select xmin::text as x from audit_logs where id = ${rmRows[0]!.id}`),
    )) as unknown as Array<{ x: string }>)
  : [];
ok(
  "#37: the audit row commits in the SAME transaction as the change it records",
  !!xminBiz?.x && xminBiz.x === xminAudit?.x,
);

// ── Security trail, part 2 (2026-10-25) ────────────────────────────────────────
// Gateway accounts, HubSpot, mail transport and the org 2FA requirement each write ONE
// row per change, over real HTTP, with no secret in it; `category[is]=security` returns
// them and leaves the rest of the trail out.
{
  const { createServer } = await import("node:http");
  const { buildApp } = await import("@/index");
  const { config } = await import("@/platform/config");
  const { systemDb } = await import("@/platform/db");
  const { publicId } = await import("@/platform/ids");
  const { createApiKey } = await import("@/modules/tenancy/service");
  const { createGatewayAccount } = await import("@/modules/gateway/service");
  const { setOrganizationRequireMfa } = await import("@/modules/auth/org-two-factor");
  const { REQUIRED_SCOPES } = await import("@/modules/hubspot/oauth");
  const { users, userMfa } = await import("@db/schema");

  const SECRETS = [
    "sk_verify_GATEWAY_SECRET",
    "whsec_verify_PASTED_SECRET",
    "smtp-verify-PASSWORD",
    "ses-verify-SECRET-ACCESS-KEY",
    "AKIAVERIFYACCESSKEY",
    "at-verify-hubspot",
    "rt-verify-hubspot",
  ];

  // A stand-in HubSpot: token exchange, token info, refresh-token revoke.
  const hs = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://stub").pathname;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "POST" && path === "/oauth/v1/token")
        return res.end(
          JSON.stringify({
            access_token: "at-verify-hubspot",
            refresh_token: "rt-verify-hubspot",
            expires_in: 1800,
          }),
        );
      if (path.startsWith("/oauth/v1/access-tokens/"))
        return res.end(
          JSON.stringify({
            hub_id: 616161,
            hub_domain: "audit.hubspot.test",
            user: "ops@example.com",
            scopes: [...REQUIRED_SCOPES],
          }),
        );
      res.end("{}");
    });
  });
  await new Promise<void>((r) => hs.listen(0, "127.0.0.1", r));
  const hsBase = `http://127.0.0.1:${(hs.address() as { port: number }).port}`;
  const cfg = config as unknown as Record<string, string | undefined>;
  cfg.HUBSPOT_CLIENT_ID = "verify-client-id";
  cfg.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
  cfg.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";
  cfg.HUBSPOT_API_BASE = hsBase;

  const app = await buildApp({ logger: false });
  const admin = await createApiKey(orgId, "test", "api", "write", "admin");
  let n = 0;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${admin.secret}`,
        ...(method !== "GET" ? { "idempotency-key": `sec-audit-${Date.now()}-${n++}` } : {}),
      },
      ...(payload !== undefined ? { payload } : {}),
    });
  const B = `/v1/businesses/${biz.publicId}`;

  // Gateway account: create, update (label + a credential), delete.
  const gw = await call("POST", `${B}/gateway_accounts`, {
    gateway_key: "tmtest",
    label: "Audit Gateway",
    credentials: { api_key: "sk_verify_GATEWAY_SECRET" },
  });
  const gwa = gw.json().id as string;
  const gwUpd = await call("PATCH", `${B}/gateway_accounts/${gwa}`, {
    label: "Audit Gateway 2",
    credentials: { api_key: "sk_verify_GATEWAY_SECRET" },
  });
  const gwDel = await call("DELETE", `${B}/gateway_accounts/${gwa}`);
  ok(
    "security: gateway create/update/delete answered 2xx",
    gw.statusCode === 201 && gwUpd.statusCode === 200 && gwDel.statusCode === 200,
  );

  // Operator-pasted webhook secret.
  const gc = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "gocardless",
    label: "Audit GC",
    credentials: { access_token: "sandbox_verify" },
  });
  const pasted = await call("POST", `${B}/gateway_accounts/${gc.publicId}/webhook_endpoint`, {
    webhook_secret: "whsec_verify_PASTED_SECRET",
  });
  ok("security: webhook secret save answered 200", pasted.statusCode === 200);

  // Mail transport: SMTP, then SES (which switches SMTP off).
  const smtp = await call("PATCH", `${B}/emails/smtp`, {
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    username: "mailer",
    password: "smtp-verify-PASSWORD",
  });
  const ses = await call("PATCH", `${B}/emails/ses`, {
    enabled: true,
    region: "us-east-1",
    accessKeyId: "AKIAVERIFYACCESSKEY",
    secretAccessKey: "ses-verify-SECRET-ACCESS-KEY",
  });
  ok(
    "security: SMTP and SES saves answered 200",
    smtp.statusCode === 200 && ses.statusCode === 200,
  );

  // HubSpot connect + disconnect.
  const hsOn = await call("POST", `${B}/integrations/hubspot/connect`, { code: "good-code" });
  const hsOff = await call("DELETE", `${B}/integrations/hubspot`);
  ok(
    "security: HubSpot connect/disconnect answered 2xx",
    hsOn.statusCode === 201 && hsOff.statusCode === 200,
  );

  // Organization 2FA requirement: an admin who has 2FA turns it on, then off.
  const [u] = await systemDb
    .insert(users)
    .values({ publicId: publicId("usr"), email: `audit-2fa-${Date.now()}@example.com` })
    .returning();
  await systemDb.insert(userMfa).values({ userId: u!.id, confirmedAt: new Date() });
  await setOrganizationRequireMfa({ organizationId: orgId, actorUserId: u!.id, enabled: true });
  await setOrganizationRequireMfa({ organizationId: orgId, actorUserId: u!.id, enabled: false });
  await setOrganizationRequireMfa({ organizationId: orgId, actorUserId: u!.id, enabled: false });

  const all = await listAuditLogs(orgId, { limit: 200 });
  const of = (a: string) => all.filter((r) => r.action === a);
  const EXPECTED = [
    "gateway_account.create",
    "gateway_account.update",
    "gateway_account.delete",
    "gateway_account.set_webhook_secret",
    "mail_transport.smtp.update",
    "mail_transport.ses.update",
    "integration.hubspot.connect",
    "integration.hubspot.disconnect",
    "organization.two_factor.enable",
    "organization.two_factor.disable",
  ];
  for (const a of EXPECTED) ok(`security: ${a} writes exactly one row`, of(a).length === 1);
  const secRows = all.filter((r) => EXPECTED.includes(r.action));
  const dump = JSON.stringify(secRows);
  ok(
    "security: no secret value in any new row",
    SECRETS.every((v) => !dump.includes(v)),
  );
  ok(
    "security: HTTP rows carry the API actor and the request IP",
    secRows
      .filter((r) => !r.action.startsWith("organization."))
      .every((r) => r.actor === admin.apiKey.publicId && r.source === "api" && !!r.actorIp),
  );
  const gwUpdRow = of("gateway_account.update")[0];
  ok(
    "security: gateway update names the changed credential field, not its value",
    JSON.stringify((gwUpdRow?.after as Record<string, unknown>)?.credential_fields) ===
      JSON.stringify(["api_key"]) &&
      (gwUpdRow?.after as Record<string, unknown>)?.label === "Audit Gateway 2",
  );
  ok(
    "security: gateway delete keeps what was deleted",
    (of("gateway_account.delete")[0]?.before as Record<string, unknown>)?.gateway_key === "tmtest",
  );
  ok(
    "security: SMTP password recorded as changed",
    (of("mail_transport.smtp.update")[0]?.after as Record<string, unknown>)?.password === "changed",
  );
  const sesAfter = of("mail_transport.ses.update")[0]?.after as Record<string, unknown>;
  ok(
    "security: SES keys recorded as changed, and SMTP switched off",
    sesAfter?.secretAccessKey === "changed" &&
      sesAfter?.accessKeyId === "changed" &&
      sesAfter?.smtp_enabled === false,
  );
  const tfa = of("organization.two_factor.enable")[0];
  ok(
    "security: 2FA row records the boolean and the grace period",
    (tfa?.before as Record<string, unknown>)?.require_two_factor === false &&
      (tfa?.after as Record<string, unknown>)?.require_two_factor === true &&
      typeof (tfa?.after as Record<string, unknown>)?.grace_days === "number" &&
      tfa?.businessId === null,
  );

  // The security category, over the org-level route.
  const sec = await call("GET", "/v1/audit_logs?category[is]=security&limit=100");
  const secActions = ((sec.json().data ?? []) as Array<{ action: string }>).map((r) => r.action);
  ok("security: category filter answered 200", sec.statusCode === 200);
  ok(
    "security: category=security returns every new action",
    EXPECTED.every((a) => secActions.includes(a)),
  );
  ok(
    "security: category=security also returns api_key rows",
    secActions.includes("api_key.create"),
  );
  ok(
    "security: category=security excludes a customer update",
    !secActions.includes("customer.update") && all.some((r) => r.action === "customer.update"),
  );
  const other = await call("GET", "/v1/audit_logs?category[is]=other&limit=100");
  const otherActions = ((other.json().data ?? []) as Array<{ action: string }>).map(
    (r) => r.action,
  );
  ok(
    "security: category=other holds no security action",
    otherActions.length > 0 && !otherActions.some((a) => EXPECTED.includes(a)),
  );

  await app.close();
  hs.close();
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(`\n${failed === 0 ? "✅ AUDIT: PASS" : `❌ AUDIT: FAIL (${failed}/${checks.length})`}`);
await closeDb();
process.exit(failed ? 1 : 0);
