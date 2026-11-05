/**
 * Scheduled changes (Phase 8) — the durable clock applies future-dated actions:
 *  - scheduled cancel (past effective_at) → applied → sub canceled,
 *  - scheduled pause then auto-resume → paused → active,
 *  - scheduled plan change (qty) → applied → item re-rated + proration,
 *  - canceling a pending scheduled change → never applied.
 *
 * Plus § 9, the COMPOSITION EDIT a schedule refused to carry until 2026-08-31: a
 * deferred change may add and remove lines, not only re-rate existing ones, and the
 * whole edit lands in ONE transaction on ONE invoice / credit note.
 * `changeSubscription` has taken all three lists since 2026-08-24; only `POST
 * …/schedule` and its stored payload were narrower. § 9 also pins the schedule-time
 * preflight, which refuses a bogus item/price while the operator is still on the
 * screen instead of at apply time with nobody watching.
 *
 * Plus the 0159 scheduled-CANCELLATION visibility set, which is where the bugs
 * were — a scheduled cancel that nobody could see, and a failing one nobody
 * could see either:
 *  - a specific_date cancel reads as non_renewing + canceled_at (was: plain active),
 *  - remove_scheduled_cancellation undoes one (was: "no scheduled cancellation"),
 *  - a cancel_at in the past is rejected (was: accepted, fired a minute later),
 *  - an unapplicable change goes terminal with a reason (was: retried forever, silently),
 *  - failures are reported to the tick (was: swallowed by a bare catch).
 *
 *   pnpm verify:scheduled-changes
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import {
  estimateRenewal,
  estimateRenewalCeiling,
  expectedRecurringDebit,
} from "@/modules/subscriptions/estimate";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscriptionWithOptions,
  removeScheduledCancellation,
  apiSubscriptionStatus,
  SubscriptionError,
} from "@/modules/subscriptions/service";
import { serializeSubscription } from "@/modules/subscriptions/serialize";
import {
  scheduleChange,
  cancelScheduledChange,
  applyDueScheduledChanges,
} from "@/modules/subscriptions/scheduled-changes";
import {
  subscriptions,
  subscriptionItems,
  scheduledChanges,
  invoices,
  invoiceLineItems,
  creditNotes,
  auditLogs,
} from "@db/schema";

const org = await createOrganization({ name: "Scheduled Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const flat = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const perUnit = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

// § 9 fixtures: two add-ons on the same monthly cadence as the plan, so an added line
// is legal without a cadence change in the same edit.
const addonProduct = await createProduct({ ...ctx, name: "Seats", kind: "addon" });
const addonA = await createPrice({
  ...ctx,
  productId: addonProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 500,
  interval: "month",
});
const addonB = await createPrice({
  ...ctx,
  productId: addonProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 700,
  interval: "month",
});
// A price in ANOTHER currency, for the preflight's currency refusal.
const eurAddon = await createPrice({
  ...ctx,
  productId: addonProduct.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 500,
  interval: "month",
});

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 86_400_000);
const checks: Array<[string, boolean]> = [];

async function mkSub(price: Awaited<ReturnType<typeof createPrice>>, qty: number, email: string) {
  const customer = await createCustomer({ ...ctx, email });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: qty }],
  });
  return { subscription, items };
}
const subStatus = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!.status,
  );

// 1) Scheduled cancel.
{
  const { subscription } = await mkSub(flat, 1, "cancel@a.com");
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "cancel",
    effectiveAt: PAST,
  });
  const { applied } = await applyDueScheduledChanges(new Date());
  checks.push([
    "scheduled cancel applied",
    applied >= 1 && (await subStatus(subscription.id)) === "cancelled",
  ]);
}

// 2) Scheduled pause → auto-resume.
{
  const { subscription } = await mkSub(flat, 1, "pause@a.com");
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "pause",
    effectiveAt: PAST,
  });
  await applyDueScheduledChanges(new Date());
  const paused = await subStatus(subscription.id);
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "resume",
    effectiveAt: PAST,
  });
  await applyDueScheduledChanges(new Date());
  const resumed = await subStatus(subscription.id);
  checks.push(
    ["scheduled pause → paused", paused === "paused"],
    ["scheduled resume → active", resumed === "active"],
  );
}

// 3) Scheduled plan change (qty 1→3, per_unit).
{
  const { subscription, items } = await mkSub(perUnit, 1, "change@a.com");
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "change",
    effectiveAt: PAST,
    changes: [{ itemId: items[0]!.publicId, newQuantity: 3 }],
  });
  await applyDueScheduledChanges(new Date());
  const qty = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(subscriptionItems)
          .where(eq(subscriptionItems.id, items[0]!.id))
          .limit(1)
      )[0]!.quantity,
  );
  checks.push(["scheduled change re-rated item qty → 3", qty === 3]);
}

// 4) Canceling a pending (future) scheduled change → never applied.
{
  const { subscription } = await mkSub(flat, 1, "pending@a.com");
  const row = await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "pause",
    effectiveAt: FUTURE,
  });
  const canceled = await cancelScheduledChange(orgId, biz.id, row.publicId);
  await applyDueScheduledChanges(new Date()); // due pass shouldn't touch a future/canceled one
  checks.push(
    ["pending scheduled change canceled", canceled?.status === "canceled"],
    [
      "canceled change not applied (sub still active)",
      (await subStatus(subscription.id)) === "active",
    ],
  );
}

const subRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const schRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(scheduledChanges).where(eq(scheduledChanges.publicId, id)).limit(1)
      )[0]!,
  );

// 5) A specific_date cancel is VISIBLE on the subscription — the 0159 headline.
//    It used to serialize as a plain `active` subscription with canceled_at null,
//    so nothing short of fetching /scheduled_changes revealed the pending cancel.
{
  const { subscription } = await mkSub(flat, 1, "specific@a.com");
  const at = new Date(Date.now() + 5 * 86_400_000);
  const res = await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "specific_date",
    cancelAt: at,
  });
  const row = await subRow(subscription.id);
  const ser = serializeSubscription(row, biz);
  checks.push(
    ["specific_date cancel → scheduled_change created", typeof res.scheduledChange === "string"],
    [
      "specific_date cancel → cancel_scheduled_at set on the sub",
      row.cancelScheduledAt?.getTime() === at.getTime(),
    ],
    [
      "specific_date cancel → derived status non_renewing",
      apiSubscriptionStatus(row) === "non_renewing",
    ],
    // The scheduled instant itself, not the term end — that is the date it cancels on.
    [
      "specific_date cancel → canceled_at is the scheduled date",
      new Date(ser.canceled_at!).getTime() === at.getTime(),
    ],
    ["specific_date cancel → stored status still active", row.status === "active"],
  );

  // …and remove_scheduled_cancellation undoes it. This threw "Subscription has no
  // scheduled cancellation" before, because it only knew about cancel_at_period_end.
  const restored = await removeScheduledCancellation({ ...ctx, subscriptionId: subscription.id });
  const sch = await schRow(res.scheduledChange!);
  checks.push(
    [
      "remove_scheduled_cancellation clears cancel_scheduled_at",
      restored.cancelScheduledAt === null,
    ],
    [
      "remove_scheduled_cancellation → back to active",
      apiSubscriptionStatus(restored) === "active",
    ],
    // The flag clear alone would be cosmetic — the clock acts on the ROW.
    [
      "remove_scheduled_cancellation withdraws the scheduled_changes row",
      sch.status === "canceled",
    ],
  );
  await applyDueScheduledChanges(new Date(Date.now() + 6 * 86_400_000));
  checks.push(["withdrawn cancel never fires", (await subStatus(subscription.id)) === "active"]);
}

// 6) A past cancel_at is rejected, instead of being reported as "scheduled" and
//    then firing on the next tick as a late immediate cancel.
{
  const { subscription } = await mkSub(flat, 1, "pastdate@a.com");
  let rejected = false;
  try {
    await cancelSubscriptionWithOptions({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      cancelOption: "specific_date",
      cancelAt: PAST,
    });
  } catch (e) {
    rejected = e instanceof SubscriptionError && /must be in the future/.test((e as Error).message);
  }
  checks.push(
    ["past cancel_at rejected", rejected],
    ["rejected schedule left the sub alone", (await subStatus(subscription.id)) === "active"],
  );
}

// 7) An UNAPPLICABLE change goes terminal with a reason — it does not retry every
//    tick forever. A scheduled `change` was the one type with no status guard, so
//    against a cancelled subscription it threw from changeSubscription into a bare
//    `catch {}` and spun for the life of the deployment with nothing recorded.
{
  const { subscription, items } = await mkSub(perUnit, 1, "stuck@a.com");
  const row = await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "change",
    effectiveAt: PAST,
    changes: [{ itemId: items[0]!.publicId, newQuantity: 5 }],
  });
  await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  const res = await applyDueScheduledChanges(new Date());
  const sch = await schRow(row.publicId);
  checks.push(
    ["unapplicable change → status failed", sch.status === "failed"],
    ["unapplicable change → reason recorded", /cancelled subscription/.test(sch.lastError ?? "")],
    ["unapplicable change → counted as failed", res.failed >= 1],
    // The whole point: the tick can no longer read as clean.
    [
      "unapplicable change → reported to the tick",
      res.errors.some((e) => e.step === "scheduled_change" && e.message.includes(row.publicId)),
    ],
  );
  const again = await applyDueScheduledChanges(new Date());
  checks.push([
    "terminal row is not re-scanned",
    !again.errors.some((e) => e.message.includes(row.publicId)),
  ]);
}

// 8) A cancel that is MOOT (someone cancelled by hand first) closes out quietly —
//    applied, with the reason recorded, and NOT counted as a failure.
{
  const { subscription } = await mkSub(flat, 1, "moot@a.com");
  const row = await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "cancel",
    effectiveAt: PAST,
  });
  await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  const res = await applyDueScheduledChanges(new Date());
  const sch = await schRow(row.publicId);
  checks.push(
    ["moot cancel → applied, not failed", sch.status === "applied" && res.failed === 0],
    ["moot cancel → reason recorded", /already cancelled/.test(sch.lastError ?? "")],
    [
      "moot cancel → cancel_scheduled_at cleared",
      (await subRow(subscription.id)).cancelScheduledAt === null,
    ],
  );
}

// 9) A DEFERRED COMPOSITION EDIT — changes + adds + removes on one scheduled row.
//    Until 2026-08-31 `scheduleChange` took `changes` only, so the change screen refused
//    to defer any edit that touched the line-up ("Scheduled changes can only modify
//    existing lines") even though `changeSubscription` had applied all three lists in one
//    transaction since 2026-08-24. These checks are the reason that guard could go.
{
  const customer = await createCustomer({ ...ctx, email: "composition@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: perUnit, quantity: 1 },
      { price: addonA, quantity: 1 },
    ],
  });
  const planItem = items.find((i) => i.priceId === perUnit.id)!;
  const addonItem = items.find((i) => i.priceId === addonA.id)!;
  // Diffed by ID, not by count: a select with no ORDER BY has no order to slice.
  const docsBefore = await withTenant(orgId, async (tx) => ({
    inv: new Set(
      (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id))).map(
        (i) => i.id,
      ),
    ),
    cn: (await tx.select().from(creditNotes).where(eq(creditNotes.customerId, customer.id))).length,
  }));

  const row = await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "change",
    effectiveAt: PAST,
    changes: [{ itemId: planItem.publicId, newQuantity: 4 }],
    adds: [{ priceId: addonB.publicId }],
    removes: [addonItem.publicId],
  });
  // The whole edit has to SURVIVE the round-trip through jsonb, or apply time replays a
  // narrower change than the operator scheduled — which is exactly the old bug, one layer
  // down. Assert the stored payload, not just the outcome.
  const stored = (await schRow(row.publicId)).payload as {
    changes?: unknown[];
    adds?: unknown[];
    removes?: string[];
  } | null;
  checks.push([
    "scheduled composition edit → all three lists persisted",
    stored?.changes?.length === 1 && stored?.adds?.length === 1 && stored?.removes?.length === 1,
  ]);

  const res = await applyDueScheduledChanges(new Date());
  const after = await withTenant(orgId, async (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  const docsAfter = await withTenant(orgId, async (tx) => ({
    inv: await tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
    cn: (await tx.select().from(creditNotes).where(eq(creditNotes.customerId, customer.id))).length,
  }));
  const raised = docsAfter.inv.filter((i) => !docsBefore.inv.has(i.id));
  const lines =
    raised.length === 1
      ? await withTenant(orgId, async (tx) =>
          tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, raised[0]!.id)),
        )
      : [];
  checks.push(
    [
      "composition edit → row applied",
      (await schRow(row.publicId)).status === "applied" && res.failed === 0,
    ],
    [
      "composition edit → changed line re-rated (qty 4)",
      after.find((i) => i.id === planItem.id)?.quantity === 4,
    ],
    ["composition edit → removed line detached", !after.some((i) => i.id === addonItem.id)],
    ["composition edit → added line attached", after.some((i) => i.priceId === addonB.id)],
    ["composition edit → 2 lines after (plan + the added add-on)", after.length === 2],
    // ONE transaction, ONE DOCUMENT — the guarantee the immediate path got in 2026-08-24
    // and the whole reason a deferred edit is worth routing through `changeSubscription`
    // rather than replaying it as three calls. A per-list applier would raise an invoice
    // for the change, another for the add, and a separate credit note for the remove —
    // net-identical, and (measured, on a real mandate) uncollectable.
    ["composition edit → exactly one invoice raised", raised.length === 1],
    ["composition edit → no separate credit note", docsAfter.cn - docsBefore.cn === 0],
    // Every third of the edit is ON that one invoice: +3 units of the changed per-unit
    // line (3×1000), the added add-on (700), and the removed add-on's unused time as a
    // NEGATIVE line (−500) rather than a document of its own. Whole term remaining (the
    // sub was created seconds ago), so the prorated figures are the full amounts.
    ["composition edit → all three thirds on the one invoice", lines.length === 3],
    [
      "composition edit → the removal is a negative LINE, not a credit note",
      lines.filter((l) => Number(l.amountMinor) < 0).length === 1,
    ],
    [
      "composition edit → netted to 3000 + 700 − 500",
      raised.length === 1 && Number(raised[0]!.totalMinor) === 3200,
    ],
  );
}

// 10) An ADDS-ONLY and a REMOVES-ONLY schedule are legal edits. The old check was
//     "at least one item CHANGE", which refused both.
{
  const customer = await createCustomer({ ...ctx, email: "addsonly@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: flat, quantity: 1 },
      { price: addonA, quantity: 1 },
    ],
  });
  const addonItem = items.find((i) => i.priceId === addonA.id)!;
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "change",
    effectiveAt: PAST,
    adds: [{ priceId: addonB.publicId }],
  });
  await applyDueScheduledChanges(new Date());
  const afterAdd = await withTenant(orgId, async (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  // A second schedule of the same type SUPERSEDES the first (deliberate), so
  // this only reads as a removes-only test because the first one has already applied.
  await scheduleChange({
    ...ctx,
    subscriptionId: subscription.id,
    type: "change",
    effectiveAt: PAST,
    removes: [addonItem.publicId],
  });
  await applyDueScheduledChanges(new Date());
  const afterRemove = await withTenant(orgId, async (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  checks.push(
    ["adds-only schedule applies", afterAdd.some((i) => i.priceId === addonB.id)],
    ["removes-only schedule applies", !afterRemove.some((i) => i.id === addonItem.id)],
  );
}

// 11) SCHEDULE-TIME PREFLIGHT. A scheduled row is applied by the clock with nobody
//     watching: apply-time refusals surface only as `last_error` on a change that never
//     happened. Widening a schedule to `adds`/`removes` widened that blind spot, so the
//     typo class is refused while the operator is still on the screen — and, critically,
//     NO ROW is written for a refused schedule.
{
  const { subscription, items } = await mkSub(perUnit, 1, "preflight@a.com");
  const rowsFor = () =>
    withTenant(orgId, async (tx) =>
      tx
        .select()
        .from(scheduledChanges)
        .where(eq(scheduledChanges.subscriptionId, subscription.id)),
    );
  const refuses = async (input: Parameters<typeof scheduleChange>[0], re: RegExp) => {
    try {
      await scheduleChange(input);
      return false;
    } catch (e) {
      return e instanceof SubscriptionError && re.test((e as Error).message);
    }
  };
  const base = {
    ...ctx,
    subscriptionId: subscription.id,
    type: "change" as const,
    effectiveAt: FUTURE,
  };
  checks.push(
    [
      "preflight: unknown remove id refused",
      await refuses({ ...base, removes: ["si_nope"] }, /We could not find the subscription item/),
    ],
    [
      "preflight: unknown change id refused",
      await refuses(
        { ...base, changes: [{ itemId: "si_nope", newQuantity: 2 }] },
        /We could not find the subscription item/,
      ),
    ],
    [
      "preflight: unknown price refused",
      await refuses({ ...base, adds: [{ priceId: "price_nope" }] }, /We could not find the price/),
    ],
    [
      "preflight: wrong-currency add refused",
      await refuses({ ...base, adds: [{ priceId: eurAddon.publicId }] }, /currency must match/),
    ],
    [
      "preflight: same item changed AND removed refused",
      await refuses(
        {
          ...base,
          changes: [{ itemId: items[0]!.publicId, newQuantity: 2 }],
          removes: [items[0]!.publicId],
        },
        /You cannot change and remove the same subscription item/,
      ),
    ],
    [
      "preflight: empty change refused",
      await refuses({ ...base }, /at least one item change, add or remove/),
    ],
    // The whole point of refusing EARLY: a rejected schedule must leave nothing behind
    // for the clock to find. A row written then thrown out of would apply on the next tick.
    ["preflight: refused schedules wrote no row", (await rowsFor()).length === 0],
  );
}

// 12) THE HTTP ROUTE, not just the service. `POST …/schedule` had no HTTP coverage at
//     all, and it is where the widening is most easily got wrong: `adds[].price` →
//     `priceId` and `adds[].unit_price_minor` → `customAmountMinor` are hand-written
//     mappings, and a dropped one loses a custom price silently — the schedule would
//     apply at catalog rate months later with nobody watching.
{
  const { buildApp } = await import("@/index");
  const { createApiKey } = await import("@/modules/tenancy/service");
  const app = await buildApp({ logger: false });
  const key = await createApiKey(orgId, "test");
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: (
      await (async () => {
        const c = await createCustomer({ ...ctx, email: "http@a.com" });
        await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
        return c;
      })()
    ).id,
    now: new Date(),
    items: [
      { price: perUnit, quantity: 1 },
      { price: addonA, quantity: 1 },
    ],
  });
  const planItem = items.find((i) => i.priceId === perUnit.id)!;
  const addonItem = items.find((i) => i.priceId === addonA.id)!;
  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${subscription.publicId}/schedule`,
      headers: {
        authorization: `Bearer ${key.secret}`,
        "idempotency-key": randomBytes(8).toString("hex"),
      },
      payload: payload as object,
    });

  const res = await post({
    type: "change",
    effective_at: FUTURE.toISOString(),
    changes: [{ item: planItem.publicId, quantity: 3 }],
    adds: [{ price: addonB.publicId, quantity: 2, unit_price_minor: 111 }],
    removes: [addonItem.publicId],
  });
  const body = JSON.parse(res.body) as {
    payload?: {
      changes?: Array<{ itemId?: string; newQuantity?: number }>;
      adds?: Array<{ priceId?: string; quantity?: number; customAmountMinor?: number }>;
      removes?: string[];
    };
  };
  checks.push(
    ["HTTP: schedule accepts changes + adds + removes (201)", res.statusCode === 201],
    [
      "HTTP: changes mapped (item → itemId, quantity → newQuantity)",
      body.payload?.changes?.[0]?.itemId === planItem.publicId &&
        body.payload?.changes?.[0]?.newQuantity === 3,
    ],
    // The mapping this section exists for.
    [
      "HTTP: adds mapped (price → priceId, unit_price_minor → customAmountMinor)",
      body.payload?.adds?.[0]?.priceId === addonB.publicId &&
        body.payload?.adds?.[0]?.quantity === 2 &&
        body.payload?.adds?.[0]?.customAmountMinor === 111,
    ],
    ["HTTP: removes passed through", body.payload?.removes?.[0] === addonItem.publicId],
  );

  // An adds-only body is a legal change now; an EMPTY one is still a 400, and the message
  // has to name all three lists or it tells the caller to send the one field that used to
  // be the only option.
  const addsOnly = await post({
    type: "change",
    effective_at: FUTURE.toISOString(),
    adds: [{ price: addonB.publicId }],
  });
  const empty = await post({ type: "change", effective_at: FUTURE.toISOString() });
  checks.push(
    ["HTTP: adds-only body accepted (201)", addsOnly.statusCode === 201],
    ["HTTP: empty change refused (400)", empty.statusCode === 400],
    [
      "HTTP: …and the message names all three lists",
      /changes\[\], adds\[\] or removes\[\]/.test(empty.body),
    ],
  );
  // The preflight refuses over HTTP as a 400, not a 500 — it throws SubscriptionError,
  // which the route's existing catch maps.
  const badPrice = await post({
    type: "change",
    effective_at: FUTURE.toISOString(),
    adds: [{ price: "price_nope" }],
  });
  checks.push([
    "HTTP: preflight refusal is a 400 with the reason",
    badPrice.statusCode === 400 && /We could not find the price/.test(badPrice.body),
  ]);
  await app.close();
}

// 13) THE RENEWAL ESTIMATE PRICES A SCHEDULED CHANGE. Scheduled changes run before the
//     renewal at the boundary, so the renewal bills the items they leave. The estimate
//     (renewal reminder, pre-debit notice, portal) priced today's items instead.
{
  const rb = await createBusiness({
    organizationId: orgId,
    name: "Renewal Estimate Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const rctx = { organizationId: orgId, businessId: rb.id };
  const plan = await createProduct({ ...rctx, name: "Plan", kind: "plan" });
  const mk = (amountMinor: number) =>
    createPrice({
      ...rctx,
      productId: plan.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const pro = await mk(3000);
  const basic = await mk(1000);
  // Started 40 days ago, never renewed: the term end has passed, so the clock can run it.
  const mkTermSub = async (email: string) => {
    const customer = await createCustomer({ ...rctx, email });
    await vaultPaymentMethod({ ...rctx, customer, token: "tok_4242" });
    return createSubscription({
      ...rctx,
      customerId: customer.id,
      now: new Date(Date.now() - 40 * 86_400_000),
      items: [{ price: pro, quantity: 1 }],
    });
  };
  const { subscription: sub, items } = await mkTermSub("renewal-downgrade@example.com");
  const boundary = sub.currentPeriodEnd!;
  await scheduleChange({
    ...rctx,
    subscriptionId: sub.id,
    type: "change",
    effectiveAt: boundary,
    changes: [{ itemId: items[0]!.publicId, newPriceId: basic.publicId }],
  });
  const est = await estimateRenewal({ ...rctx, subscriptionId: sub.id });
  const today = await estimateRenewal({
    ...rctx,
    subscriptionId: sub.id,
    ignoreScheduledChanges: true,
  });
  // A notice and a mandate must cover today's items too: the change may still not run.
  const notice = await estimateRenewalCeiling({ ...rctx, subscriptionId: sub.id });
  const mandateFigure = await expectedRecurringDebit(orgId, rb.id, sub.customerId, "USD");
  checks.push(
    [
      "downgrade scheduled: the pre-debit notice states today's higher amount, renewal_estimate the lower",
      notice?.amount_due_minor === 3000 && est?.total_minor === 1000,
    ],
    ["…and mandate sizing / AFA use the higher amount", mandateFigure === 3000n],
  );
  const before = await withTenant(orgId, (tx) =>
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.subscriptionId, sub.id)),
  );
  // The clock at the boundary: the scheduled change, then the renewal.
  const tickAt = new Date(boundary.getTime() + 1_000);
  await runWithClockScope({ onlyBusinessId: rb.id }, () => applyDueScheduledChanges(tickAt));
  await renewSubscription(orgId, sub.id, tickAt);
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
  );
  const seen = new Set(before.map((r) => r.id));
  const booked = after
    .filter((r) => !seen.has(r.id))
    .reduce((sum, r) => sum + Number(r.totalMinor), 0);
  console.log(
    `  renewal estimate ${est?.total_minor} · today's items ${today?.total_minor} · booked ${booked}`,
  );
  checks.push(
    [
      "renewal estimate with a downgrade at the term end = what the boundary books",
      est != null && booked > 0 && est.total_minor === booked,
    ],
    [
      "…it names the scheduled change it priced",
      est?.scheduled_change?.type === "change" &&
        est.scheduled_change.effective_at === boundary.toISOString(),
    ],
    ["ignore_scheduled_changes=true still prices today's items", today?.total_minor === 3000],
  );

  // A pause at the boundary: no renewal bills there, and the estimate says why.
  const { subscription: paused } = await mkTermSub("renewal-pause@example.com");
  await scheduleChange({
    ...rctx,
    subscriptionId: paused.id,
    type: "pause",
    effectiveAt: paused.currentPeriodEnd!,
  });
  let unpriced: { type: string } | null = null;
  const pausedEst = await estimateRenewal({
    ...rctx,
    subscriptionId: paused.id,
    onUnpriced: (c) => {
      unpriced = c;
    },
  });
  checks.push([
    "a pause at the term end: no renewal amount, and the pause is named",
    pausedEst === null && (unpriced as { type: string } | null)?.type === "pause",
  ]);

  // An upgrade scheduled: the notice states the higher, post-change amount.
  const enterprise = await mk(5000);
  const up = await mkTermSub("renewal-upgrade@example.com");
  await scheduleChange({
    ...rctx,
    subscriptionId: up.subscription.id,
    type: "change",
    effectiveAt: up.subscription.currentPeriodEnd!,
    changes: [{ itemId: up.items[0]!.publicId, newPriceId: enterprise.publicId }],
  });
  const upNotice = await estimateRenewalCeiling({ ...rctx, subscriptionId: up.subscription.id });
  checks.push([
    "upgrade scheduled: the pre-debit notice states the post-change amount",
    upNotice?.amount_due_minor === 5000,
  ]);

  // A downgrade that fails at the boundary: the renewal bills today's items, and the
  // notice already said so.
  const fl = await mkTermSub("renewal-failing@example.com");
  const flRow = await scheduleChange({
    ...rctx,
    subscriptionId: fl.subscription.id,
    type: "change",
    effectiveAt: fl.subscription.currentPeriodEnd!,
    changes: [{ itemId: fl.items[0]!.publicId, newPriceId: basic.publicId }],
  });
  const flNotice = await estimateRenewalCeiling({ ...rctx, subscriptionId: fl.subscription.id });
  // After the notice, the stored change becomes one the applier refuses.
  await withTenant(orgId, (tx) =>
    tx
      .update(scheduledChanges)
      .set({ payload: { changes: [{ itemId: fl.items[0]!.publicId, newPriceId: "price_gone" }] } })
      .where(eq(scheduledChanges.id, flRow.id)),
  );
  const flBefore = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.subscriptionId, fl.subscription.id)),
  );
  const flAt = new Date(fl.subscription.currentPeriodEnd!.getTime() + 1_000);
  await runWithClockScope({ onlyBusinessId: rb.id }, () => applyDueScheduledChanges(flAt));
  await renewSubscription(orgId, fl.subscription.id, flAt);
  const flSeen = new Set(flBefore.map((r) => r.id));
  const flDebit = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, fl.subscription.id)),
    )
  )
    .filter((r) => !flSeen.has(r.id))
    .reduce((sum, r) => sum + Number(r.amountDueMinor ?? r.totalMinor), 0);
  console.log(`  failing downgrade: notice ${flNotice?.amount_due_minor} · debit ${flDebit}`);
  checks.push([
    "a scheduled downgrade that fails at the boundary debits no more than the notice",
    flDebit > 0 && flNotice != null && flDebit <= (flNotice.amount_due_minor ?? 0),
  ]);

  // A change that removes a mandatory add-on of the plan: the booking refuses it, so the
  // estimate cannot price the smaller set.
  const seats = await createProduct({ ...rctx, name: "Seats", kind: "addon" });
  const seatPrice = await createPrice({
    ...rctx,
    productId: seats.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const mcus = await createCustomer({ ...rctx, email: "renewal-mandatory@example.com" });
  await vaultPaymentMethod({ ...rctx, customer: mcus, token: "tok_4242" });
  const msub = await createSubscription({
    ...rctx,
    customerId: mcus.id,
    now: new Date(Date.now() - 40 * 86_400_000),
    items: [
      { price: pro, quantity: 1 },
      { price: seatPrice, quantity: 1 },
    ],
  });
  const seatItem = msub.items.find((i) => i.priceId === seatPrice.id)!;
  await scheduleChange({
    ...rctx,
    subscriptionId: msub.subscription.id,
    type: "change",
    effectiveAt: msub.subscription.currentPeriodEnd!,
    removes: [seatItem.publicId],
  });
  await setItemApplicablePlans({
    ...rctx,
    itemPublicId: seats.publicId,
    planPublicIds: [plan.publicId],
    applicability: { [plan.publicId]: "mandatory" },
  });
  let mUnpriced: { type: string } | null = null;
  const mEst = await estimateRenewal({
    ...rctx,
    subscriptionId: msub.subscription.id,
    onUnpriced: (c) => {
      mUnpriced = c;
    },
  });
  checks.push([
    "a scheduled removal of a mandatory add-on: unpriced, not the smaller set",
    mEst === null && (mUnpriced as { type: string } | null)?.type === "change",
  ]);

  // The renewal preview writes nothing: a mandatory add-on with no compatible price used
  // to leave an audit row on every estimate.
  const team = await createProduct({ ...rctx, name: "Team", kind: "plan" });
  const teamPrice = await createPrice({
    ...rctx,
    productId: team.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    interval: "month",
  });
  const euroOnly = await createProduct({ ...rctx, name: "Support", kind: "addon" });
  await createPrice({
    ...rctx,
    productId: euroOnly.id,
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 300,
    interval: "month",
  });
  await setItemApplicablePlans({
    ...rctx,
    itemPublicId: euroOnly.publicId,
    planPublicIds: [team.publicId],
    applicability: { [team.publicId]: "mandatory" },
  });
  const au = await mkTermSub("renewal-audit@example.com");
  await scheduleChange({
    ...rctx,
    subscriptionId: au.subscription.id,
    type: "change",
    effectiveAt: au.subscription.currentPeriodEnd!,
    changes: [{ itemId: au.items[0]!.publicId, newPriceId: teamPrice.publicId }],
  });
  const skippedRows = () =>
    withTenant(orgId, (tx) =>
      tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.action, "mandatory_addon.skipped")),
    );
  const auditBefore = (await skippedRows()).length;
  const auEst = await estimateRenewal({ ...rctx, subscriptionId: au.subscription.id });
  await estimateRenewalCeiling({ ...rctx, subscriptionId: au.subscription.id });
  checks.push([
    "the renewal estimate writes no audit row",
    !!auEst?.scheduled_change && (await skippedRows()).length === auditBefore,
  ]);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ SCHEDULED CHANGES: PASS" : "❌ SCHEDULED CHANGES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
