/**
 * Phase B — Webhooks module verify suite (WH-1..4).
 *
 *  - WH-1: per-endpoint subscriptions filter fan-out (subscribed endpoint gets
 *    only its types); PATCH/create validate event_types against the registry.
 *  - WH-2: a past delivery can be manually redelivered (clone).
 *  - WH-3: test-send returns the receiver's status.
 *  - WH-4: an event's webhook_status rolls up its deliveries (worst wins).
 *
 *   pnpm verify:webhooks
 */
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createEndpoint, redeliverDelivery, testSendEndpoint } from "@/modules/webhooks/endpoints";
import { deliverPending } from "@/modules/webhooks/outbox";
import { listEventsFiltered } from "@/modules/events/service";
import { webhookDeliveries, events, providerEvents } from "@db/schema";
// #31 — the inbound capture classifier and the writer that persists its verdict.
import {
  classifyUnmatchedCapture,
  handleProviderEvent,
  reviveNormalizedEvent,
} from "@/modules/webhooks/inbound";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// Local receiver — records the payloads it gets; always 200.
const received: Array<{ type: string; test: boolean }> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const evt = JSON.parse(body);
      // ADR-009 Part B envelope: `event_type` + `content` (not `type` + `data`).
      received.push({ type: evt.event_type, test: !!(evt.content as any)?.test });
    } catch {
      /* ignore */
    }
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/hook`;

const org = await createOrganization({ name: "WH Org" });
const orgId = org.organization.id;

// Endpoints created BEFORE the events so fan-out targets them. epAll = all types;
// epInv = only invoice.generated + invoice.paid.
const epAll = (await createEndpoint({ organizationId: orgId, url })).endpoint;
const epInv = (
  await createEndpoint({
    organizationId: orgId,
    url,
    eventTypes: ["invoice_generated", "invoice_paid"],
  })
).endpoint;

const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "wh@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 4900,
  interval: "month",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});

// ── WH-1: fan-out filtering ────────────────────────────────────────────────
async function deliveredTypes(endpointId: string): Promise<Set<string>> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ type: events.type })
      .from(webhookDeliveries)
      .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
      .where(eq(webhookDeliveries.endpointId, endpointId));
    return new Set(rows.map((r) => r.type));
  });
}
const invTypes = await deliveredTypes(epInv.id);
const allTypes = await deliveredTypes(epAll.id);
ok(
  "filtered endpoint received only its subscribed types",
  [...invTypes].every((t) => t === "invoice_generated" || t === "invoice_paid"),
);
ok(
  "filtered endpoint received the invoice events",
  invTypes.has("invoice_generated") && invTypes.has("invoice_paid"),
);
ok(
  "filtered endpoint did NOT receive customer/subscription events",
  !invTypes.has("customer_created") && !invTypes.has("subscription_created"),
);
ok(
  "all-types endpoint received customer + invoice events",
  allTypes.has("customer_created") && allTypes.has("invoice_paid"),
);

// ── WH-4: status rollup (pending before delivery) ──────────────────────────
async function eventStatus(type: string): Promise<string | undefined> {
  const page = await listEventsFiltered(orgId, { types: [type], limit: 1 });
  return page.data[0]?.webhookStatus;
}
ok("webhook_status = pending before delivery", (await eventStatus("invoice_paid")) === "pending");

// Deliver everything (receiver 200).
await deliverPending(new Date());
ok(
  "webhook_status = delivered after successful delivery",
  (await eventStatus("invoice_paid")) === "delivered",
);
ok(
  "receiver got the invoice.paid payload",
  received.some((r) => r.type === "invoice_paid"),
);

// ── WH-2: redelivery ───────────────────────────────────────────────────────
const [aDelivery] = await withTenant(orgId, async (tx) =>
  tx
    .select()
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.endpointId, epAll.id), eq(webhookDeliveries.status, "delivered")),
    )
    .limit(1),
);
const beforeCount = (
  await withTenant(orgId, async (tx) =>
    tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, epAll.id)),
  )
).length;
//
// SYNCHRONOUS since 2026-09-02: a resend calls the subscriber inline and returns the outcome plus
// this attempt's transcript. It used to insert a pending clone and leave the POST to the next
// drain, so these assertions are deliberately INVERTED from what they said before — `attempts: 0`
// and `status: 'pending'` were the old contract and are now the shape of a bug.
const recvBefore = received.length;
const res1 = await redeliverDelivery(orgId, epAll.publicId, aDelivery!.id);
ok(
  "redeliver settles the clone inline, not as pending",
  res1?.delivery.status === "delivered" &&
    res1?.delivery.attempts === 1 &&
    res1?.delivery.eventId === aDelivery!.eventId,
);
ok(
  "redeliver reaches the receiver DURING the call, with no drain in between",
  received.length > recvBefore,
);
const afterCount = (
  await withTenant(orgId, async (tx) =>
    tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, epAll.id)),
  )
).length;
ok("redeliver adds a new delivery row (original kept)", afterCount === beforeCount + 1);

// The transcript: live-only, never stored, so this return value is the only place it exists.
ok(
  "transcript reports the real request",
  res1?.transcript.request.method === "POST" &&
    res1?.transcript.request.url === epAll.url &&
    typeof res1?.transcript.request.headers["Tmbilling-Signature"] === "string",
);
ok(
  "transcript reports the real response",
  res1?.transcript.response?.status === 200 &&
    res1?.transcript.error === null &&
    res1?.transcript.outcome === "delivered",
);

// Pressing Resend twice in a row must WORK — the first attempt has already settled, so there is
// no pending row to collide with. The old suite asserted a 409 here, which was a property of the
// queued implementation rather than of the feature.
const res2 = await redeliverDelivery(orgId, epAll.publicId, aDelivery!.id);
ok("a second consecutive resend also delivers", res2?.delivery.status === "delivered");

// The conflict guard still exists, and still matters: it stops a resend stacking on top of a
// delivery the CLOCK is already going to attempt. That needs a genuinely pending row, which the
// synchronous path no longer leaves behind — so construct one.
await withTenant(orgId, async (tx) =>
  tx
    .update(webhookDeliveries)
    .set({ status: "pending", nextAttemptAt: new Date() })
    .where(eq(webhookDeliveries.id, res2!.delivery.id)),
);
let redeliverConflict = false;
try {
  await redeliverDelivery(orgId, epAll.publicId, aDelivery!.id);
} catch (e) {
  redeliverConflict = (e as Error).name === "RedeliverConflictError";
}
ok("resend while a delivery for that event is still pending → 409 conflict", redeliverConflict);
await withTenant(orgId, async (tx) =>
  tx
    .update(webhookDeliveries)
    .set({ status: "delivered" })
    .where(eq(webhookDeliveries.id, res2!.delivery.id)),
);

ok(
  "redelivery bad ids → null",
  (await redeliverDelivery(orgId, epAll.publicId, "00000000-0000-0000-0000-000000000000")) === null,
);

// ── WH-3: test-send ────────────────────────────────────────────────────────
const recvBeforeTest = received.length;
const testResult = await testSendEndpoint(orgId, epAll.publicId, "invoice_paid");
ok(
  "test-send returns receiver 200",
  testResult?.responseStatus === 200 && typeof testResult?.latencyMs === "number",
);
ok(
  "test-send payload carries data.test=true",
  received.slice(recvBeforeTest).some((r) => r.type === "invoice_paid" && r.test === true),
);
ok(
  "test-send unknown endpoint → null",
  (await testSendEndpoint(orgId, "whe_nonexistent", "invoice_paid")) === null,
);

server.close();

// ── WH-1: registry validation via the HTTP API ──────────────────────────────
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const apiPort = (app.server.address() as { port: number }).port;
const authHeaders = { Authorization: `Bearer ${org.secret}`, "Content-Type": "application/json" };
// `livemode` is explicit on both: `org.secret` is the bootstrap `kind='dashboard'`
// credential, which is full-access (`sk_all_`), and migration 0152 made an endpoint
// belong to exactly one partition. An org-wide endpoint created with a full-access key
// therefore has no derivable mode and is a 400 by design — so without this the
// bad-event-type case below would 400 for the wrong reason and never reach the type
// check at all. Everything this suite drives lives in the test partition.
const badRes = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, {
  method: "POST",
  headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    url: "https://example.test/hook",
    livemode: "test",
    event_types: ["invoice_paid", "not.a_real_event"],
  }),
});
ok("create with an unknown event_type → 400", badRes.status === 400);
// The one combination with no answer: org-wide + a full-access key + no explicit mode.
const noModeRes = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, {
  method: "POST",
  headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ url: "https://example.test/hook", event_types: ["invoice_paid"] }),
});
ok("org-wide endpoint + full-access key, no livemode → 400", noModeRes.status === 400);
const goodRes = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, {
  method: "POST",
  headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    url: "https://example.test/hook",
    livemode: "test",
    event_types: ["invoice_paid"],
    description: "invoices only",
  }),
});
const goodBody = (await goodRes.json()) as { event_types: string[]; description: string };
ok(
  "create with valid event_types → 201",
  goodRes.status === 201 &&
    goodBody.event_types?.[0] === "invoice_paid" &&
    goodBody.description === "invoices only",
);

// Retrieve + opt-in list paging. No paging param = the unpaged list as before.
{
  const createdId = (goodBody as unknown as { id: string }).id;
  const second = (await (
    await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, {
      method: "POST",
      headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ url: "https://example.test/hook2", livemode: "test" }),
    })
  ).json()) as { id: string };
  const one = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints/${createdId}`, {
    headers: authHeaders,
  });
  const oneBody = (await one.json()) as Record<string, unknown>;
  ok(
    "GET /v1/webhook_endpoints/:id → 200, the list-row shape, no signing secret",
    one.status === 200 &&
      oneBody.id === createdId &&
      oneBody.description === "invoices only" &&
      !("signing_secret" in oneBody),
  );
  const missing = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints/whe_nope`, {
    headers: authHeaders,
  });
  ok("GET /v1/webhook_endpoints/:id for an unknown id → 404", missing.status === 404);
  const full = (await (
    await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, { headers: authHeaders })
  ).json()) as { data: Array<{ id: string }>; has_more?: boolean };
  ok(
    "list without paging params is unpaged (no has_more key)",
    full.data.length >= 2 && !("has_more" in full),
  );
  type Paged = { data: Array<{ id: string }>; has_more: boolean; next_cursor: string | null };
  const p1 = (await (
    await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints?limit=1`, {
      headers: authHeaders,
    })
  ).json()) as Paged;
  const p2 = (await (
    await fetch(
      `http://127.0.0.1:${apiPort}/v1/webhook_endpoints?limit=1&starting_after=${p1.next_cursor}`,
      { headers: authHeaders },
    )
  ).json()) as Paged;
  ok(
    "list ?limit=1 pages newest first and the cursor advances",
    p1.data.length === 1 &&
      p1.has_more === true &&
      p1.data[0]!.id === full.data[0]!.id &&
      p2.data.length === 1 &&
      p2.data[0]!.id === full.data[1]!.id,
  );
  ok(
    "the second endpoint is in the list",
    full.data.some((e) => e.id === second.id),
  );
  const badLimit = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints?limit=0`, {
    headers: authHeaders,
  });
  ok("list ?limit=0 → 400", badLimit.status === 400);
}
await app.close();

// ── (#31) inbound capture ownership: three outcomes where there was one ──────────────
/**
 * The classifier that replaced one WARN covering two unrelated things: another product's
 * charge on a shared merchant account (routine) and our own capture we failed to attribute
 * (a money incident). Asserted here because the rule lives in `webhooks/inbound`, and it is
 * the same function `ops/alerts.ts` re-runs over the stored `normalized` blob.
 *
 * PURE first, then one pass through the real writer — because a fixture that constructs the
 * row it reads cannot discover the shape production actually stores (#25's lesson, and #29's).
 */
{
  // Two ages, kept only to prove the verdict is now INDEPENDENT of them: the rollout gate
  // was removed 2026-09-04, so a read absence is the verdict whatever the object's age.
  const before = new Date("2020-01-01T00:00:00.000Z");
  const after = new Date();

  // 1 · OUR tag with nothing local behind it — the crash window, and the only one that pages.
  ok(
    "#31 our tag + no local row ⇒ ours_unattributed (ALERT)",
    classifyUnmatchedCapture({ ownership: "ours", providerObjectCreatedAt: after }) ===
      "ours_unattributed",
  );
  // A positive tag is proof whatever the object's age: it can only have got there from us.
  ok(
    "#31 …and an OLD object with our tag is still ours (a tag needs no rollout check)",
    classifyUnmatchedCapture({ ownership: "ours", providerObjectCreatedAt: before }) ===
      "ours_unattributed",
  );

  // 2 · Tags READ, ours absent, object young enough for that absence to mean something.
  ok(
    "#31 read absence + created after the rollout ⇒ foreign (silent, counted)",
    classifyUnmatchedCapture({ ownership: "foreign", providerObjectCreatedAt: after }) ===
      "foreign",
  );

  /**
   * 3 · Same read absence on an OLD object. This assertion is INVERTED from what it said
   * before 2026-09-04: it used to require `unclassified`, because an object created before
   * tagging shipped was untagged for our own reasons. With the rollout gate removed, a tag
   * read is the verdict at any age.
   *
   * ⚠️ This is the removal's cost, asserted so it is visible rather than silent: a
   * pre-tagging object whose capture arrives now reads "another product's money". For the
   * legacy tail — a pre-tagging e-mandate charges for months — that can mislabel a stranded
   * capture of OURS, which then logs at `info` and nobody chases it.
   */
  ok(
    "#31 read absence ⇒ foreign REGARDLESS of the object's age (no rollout gate)",
    classifyUnmatchedCapture({ ownership: "foreign", providerObjectCreatedAt: before }) ===
      "foreign",
  );

  /**
   * 4 · THE ASSERTION THAT PROTECTS THE MONEY. `unknown` means the adapter could not read a
   * tag — a kind it does not tag (RazorPay's two s2s payment-creates, PayPal's Vault v3 setup
   * token, Stripe's Elements-created `pm_…`), a rail it cannot query, a gateway that would not
   * answer. Reading that silence as "not ours" would turn a tagging regression into invisible
   * money loss the day a deploy stops stamping refs, which is the whole disease #31 describes.
   */
  ok(
    "#31 ownership `unknown` is NOT foreign, even on a brand-new object",
    classifyUnmatchedCapture({ ownership: "unknown", providerObjectCreatedAt: after }) ===
      "unclassified",
  );
  ok(
    "#31 …and neither is an absent ownership field (the adapter default)",
    classifyUnmatchedCapture({ providerObjectCreatedAt: after }) === "unclassified",
  );

  // 5 · The date is no longer consulted at all, so a missing or unparseable one cannot
  // change a verdict. Both were `unclassified` while the gate existed.
  ok(
    "#31 a read absence with NO object date ⇒ foreign (the date is not consulted)",
    classifyUnmatchedCapture({ ownership: "foreign" }) === "foreign",
  );
  ok(
    "#31 …and an unparseable date cannot change the verdict either",
    classifyUnmatchedCapture({ ownership: "foreign", providerObjectCreatedAt: "not-a-date" }) ===
      "foreign",
  );

  /**
   * 6 · The alert calls this with `normalized->>'providerObjectCreatedAt'`, an ISO STRING,
   * while the webhook path hands it a `Date`. That difference USED to be able to change a
   * verdict (a string that parsed differently could fall the other side of the rollout bar),
   * which is why this case exists. With the gate removed the field is not read at all, so the
   * parity is now trivial — kept as the regression guard that says so: no shape of this field,
   * and no value of it, may move a verdict again.
   */
  ok(
    "#31 neither an ISO string nor a Date can move the verdict (the field is not read)",
    classifyUnmatchedCapture({
      ownership: "foreign",
      providerObjectCreatedAt: after.toISOString(),
    }) === "foreign" &&
      classifyUnmatchedCapture({
        ownership: "foreign",
        providerObjectCreatedAt: before.toISOString(),
      }) === "foreign",
  );

  /**
   * 7 · THROUGH THE REAL WRITER. `handleProviderEvent` re-encodes the event into
   * `provider_events.normalized` after the handler runs, and that blob is the ONLY durable
   * record of the verdict — there is no column for it. If the three ownership fields did not
   * survive that round trip the alert would count every capture as unclassified and #31 would
   * be closed on a lie. `deliveredByBusinessId` is null here, so nothing reaches a gateway.
   */
  const evId = `g2b_31_${crypto.randomUUID()}`;
  const chargeId = `pay_g2b31_${crypto.randomUUID().slice(0, 8)}`;
  const objectCreatedAt = new Date();
  const outcome = await handleProviderEvent("razorpay", {
    providerEventId: evId,
    type: "charge.succeeded",
    occurredAt: new Date(),
    providerChargeId: chargeId,
    providerIntentId: `order_g2b31_${crypto.randomUUID().slice(0, 8)}`,
    ownership: "ours",
    ownershipRef: "pi_g2b31_never_written",
    providerObjectCreatedAt: objectCreatedAt,
    // The provider's own json. Empty rather than a fake RazorPay payload: nothing on this
    // path reads it, and a hand-written payload would be a claim about a shape we did not
    // measure.
    raw: {},
  });
  ok("#31 a tagged capture with no local row is still NOT booked", outcome === "ignored");
  const [stored] = await systemDb
    .select({ normalized: providerEvents.normalized, txn: providerEvents.transactionPublicId })
    .from(providerEvents)
    .where(
      and(eq(providerEvents.providerKey, "razorpay"), eq(providerEvents.providerEventId, evId)),
    )
    .limit(1);
  const blob = (stored?.normalized ?? {}) as Record<string, unknown>;
  ok(
    "#31 …and the stored normalized blob carries the ownership triple the alert reads back",
    blob.ownership === "ours" &&
      blob.ownershipRef === "pi_g2b31_never_written" &&
      blob.providerObjectCreatedAt === objectCreatedAt.toISOString(),
  );
  ok(
    "#31 …with no transaction of ours linked to it (that is what makes it unattributed)",
    stored?.txn == null,
  );
  // And the round trip through the REVIVER hands back a Date, not the ISO string it stored —
  // the contract says `Date`, and every reader other than the classifier would have broken.
  const revived = reviveNormalizedEvent(stored?.normalized);
  ok(
    "#31 reviveNormalizedEvent restores providerObjectCreatedAt as a Date",
    revived.providerObjectCreatedAt instanceof Date &&
      revived.providerObjectCreatedAt.getTime() === objectCreatedAt.getTime(),
  );
}

// ── report ───────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ WEBHOOKS: PASS" : "❌ WEBHOOKS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
