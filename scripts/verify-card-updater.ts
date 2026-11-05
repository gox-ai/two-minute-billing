/**
 * Payment-method webhook lifecycle: the automatic card updater (Tier-1), and the
 * out-of-band detach beside it. Both drive synthetic provider events through the
 * REAL inbound pipeline.
 *
 * **§ A — card updater.** Vault a card via the TM Test Gateway, mark it expired, then
 * deliver `payment_method.updated` and assert:
 *  - the stored brand/last4/expiry are refreshed from the network's new card,
 *  - status flips back to `valid` (a reissued card supersedes an expired one),
 *  - a `payment_source_updated` event is emitted,
 *  - a replay (same provider event id) is deduped — no second event.
 *
 * **§ B — out-of-band detach.** An operator deleting the card in the gateway's own
 * dashboard. Deliver `payment_method.detached` and assert the instrument is marked
 * `invalid` (so collection stops selecting a token that can never be charged again)
 * while the row and its card display survive — plus the two no-ops that must stay
 * no-ops: a repeat detach of an already-invalid method, and the echo of our own
 * delete, where the row is already gone.
 *
 *   pnpm verify:card-updater
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod, setPaymentMethodStatus } from "@/modules/payment-methods/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { paymentMethods, events } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => checks.push([name, cond]);

/**
 * `provider_events` dedups on (provider_key, provider_event_id) PLATFORM-GLOBALLY,
 * not per org — so hardcoded event ids made this suite pass only on a DB that had
 * never run it: every later run saw the first delivery as a `duplicate` and failed
 * every assertion. Salt the ids per run so the suite is DB-state independent.
 */
const RUN = randomUUID().slice(0, 8);

async function main() {
  const org = await createOrganization({ name: "Card Updater Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "CU Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "cu@a.com",
  });

  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  // Mark it expired so the update visibly flips it back to valid.
  await withTenant(orgId, (tx) => setPaymentMethodStatus(tx, orgId, pm.id, "expired"));

  const ev: NormalizedProviderEvent = {
    providerEventId: `evt_pm_updated_${RUN}`,
    type: "payment_method.updated",
    providerPaymentMethodId: pm.providerPaymentMethodId,
    card: { brand: "mastercard", last4: "5454", expMonth: 11, expYear: 2033 },
    occurredAt: new Date(),
    raw: {},
  };
  const res1 = await handleProviderEvent("tmtest", ev, { businessId: biz.id });
  ok("first delivery processed", res1 === "processed");

  const [updated] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)).limit(1),
  );
  ok("brand refreshed", updated?.brand === "mastercard");
  ok("last4 refreshed", updated?.last4 === "5454");
  ok("exp month refreshed", updated?.expMonth === 11);
  ok("exp year refreshed", updated?.expYear === 2033);
  ok("status flipped to valid", updated?.status === "valid");

  const emitted = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.organizationId, orgId), eq(events.type, "payment_source_updated"))),
  );
  ok("payment_source_updated emitted", emitted.length === 1);
  ok("event points at the pm", (emitted[0]?.resourceId ?? null) === pm.publicId);

  // Replay: same provider event id → deduped, no second event.
  const res2 = await handleProviderEvent("tmtest", ev, { businessId: biz.id });
  ok("replay deduped", res2 === "duplicate");
  const emitted2 = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.organizationId, orgId), eq(events.type, "payment_source_updated"))),
  );
  ok("no duplicate event on replay", emitted2.length === 1);

  // Unknown pm id → ignored (not one of ours).
  const res3 = await handleProviderEvent(
    "tmtest",
    {
      ...ev,
      providerEventId: `evt_pm_updated_unknown_${RUN}`,
      providerPaymentMethodId: `tmpm_does_not_exist_${RUN}`,
    },
    { businessId: biz.id },
  );
  ok("unknown pm ignored", res3 === "ignored");

  // ── § B · Out-of-band detach ────────────────────────────────────────────────
  // An operator deleting the card in the gateway's own dashboard. The token is dead
  // but our row still points at it, so without this the next renewal selects it,
  // hard-declines and arms dunning against a blameless customer.
  const pmB = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });

  const detach: NormalizedProviderEvent = {
    providerEventId: `evt_pm_detached_${RUN}`,
    type: "payment_method.detached",
    providerPaymentMethodId: pmB.providerPaymentMethodId,
    occurredAt: new Date(),
    raw: {},
  };
  const resD1 = await handleProviderEvent("tmtest", detach, { businessId: biz.id });
  ok("detach processed", resD1 === "processed");

  const [detached] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, pmB.id)).limit(1),
  );
  ok("detached pm marked invalid", detached?.status === "invalid");
  // The row survives: a detach at the gateway kills the token, not the history of
  // what money was collected on it.
  ok("detached pm row not deleted", detached != null);
  // Card display fields are the truth of what died — untouched.
  ok("detached pm keeps its card display", detached?.last4 === pmB.last4);

  const detachEvents = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.organizationId, orgId),
          eq(events.type, "payment_source_updated"),
          eq(events.resourceId, pmB.publicId),
        ),
      ),
  );
  ok("detach emitted payment_source_updated", detachEvents.length === 1);

  // Replay → deduped, and no second event.
  const resD2 = await handleProviderEvent("tmtest", detach, { businessId: biz.id });
  ok("detach replay deduped", resD2 === "duplicate");

  // A SECOND, distinct detach for an already-invalid instrument says nothing new, so
  // it emits nothing — the status is the same either way. Distinct event id, so this
  // is the handler's own guard being asserted, not the provider-event dedup.
  const resD3 = await handleProviderEvent(
    "tmtest",
    { ...detach, providerEventId: `evt_pm_detached_again_${RUN}` },
    { businessId: biz.id },
  );
  ok("detach of an already-invalid pm ignored", resD3 === "ignored");
  const detachEvents2 = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.organizationId, orgId),
          eq(events.type, "payment_source_updated"),
          eq(events.resourceId, pmB.publicId),
        ),
      ),
  );
  ok("no second event for an already-invalid pm", detachEvents2.length === 1);

  // The echo of OUR OWN delete: the row is gone, so the webhook has nothing to
  // reconcile. This is the pre-existing (and correct) no-op, pinned so the new
  // branch cannot start resurrecting or erroring on it.
  const resEcho = await handleProviderEvent(
    "tmtest",
    {
      ...detach,
      providerEventId: `evt_pm_detached_echo_${RUN}`,
      providerPaymentMethodId: "tmpm_deleted_already",
    },
    { businessId: biz.id },
  );
  ok("echo of our own delete ignored", resEcho === "ignored");

  let pass = true;
  for (const [n, c] of checks) {
    console.log(` ${c ? "✓" : "✗"} ${n}`);
    if (!c) pass = false;
  }
  console.log("");
  console.log(pass ? "✅ CARD UPDATER: PASS" : "❌ CARD UPDATER: FAIL");
  await closeDb();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
