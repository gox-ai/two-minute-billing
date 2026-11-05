/**
 * `token.paused` marks a mandate dead; `token.resumed` can never arrive, because RazorPay
 * answers 400 "Invalid event name/names" for that name. So the revival has to be POLLED,
 * and this proves the poll applies the same policy the webhook would have.
 *
 * The suite owns its fixture (org, business, TM Test account, customer, two mandate
 * instruments). The sweep itself is DB-wide, so the second block asserts on the
 * difference between two sweeps, which only this suite's rows can move.
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { paymentMethods } from "@db/schema";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  recheckPausedMandates,
  REVIVABLE_MANDATE_STATUS,
} from "@/modules/payment-methods/paused-mandates";

let pass = true;
function ok(label: string, cond: boolean, detail?: string) {
  if (!cond) pass = false;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── Fixture: a live emandate pair in a business of our own ─────────────────────
const org = await createOrganization({ name: "Paused Mandates Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Paused Mandates Biz",
  defaultCurrency: "INR",
  livemode: "test",
});
const account = await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "TM Test",
  credentials: {},
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "paused-mandates@example.com",
});
const LIVE_MANDATE = "confirmed";
async function mandatePm(token: string) {
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
    gatewayAccountId: account.publicId,
  });
  await setMandate(pm.id, LIVE_MANDATE, account.id);
  return pm;
}
async function setMandate(id: string, status: string, gatewayAccountId: string | null) {
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({
        type: "bank_transfer",
        mandateRail: "emandate",
        mandateStatus: status,
        gatewayAccountId,
      })
      .where(eq(paymentMethods.id, id)),
  );
}
async function readPm(id: string) {
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)).limit(1),
  );
  return row;
}
const victim = await mandatePm("tok_4242");
// A paused row WITH an account: proves the sweep reached this business at all, so a
// zero for the victim is a decision and not a sweep that saw nothing.
const control = await mandatePm("tok_5555");

// ── Only `paused` is polled, and that is a decision, not an omission ──────────
ok(
  "the revivable status is `paused` — the one dead state a gateway can take back",
  REVIVABLE_MANDATE_STATUS === "paused",
  REVIVABLE_MANDATE_STATUS,
);

// A sweep over a book with no paused mandates must be a clean no-op rather than an error:
// that is its steady state. Nothing in this business is paused yet.
const empty = await recheckPausedMandates();
ok(
  "a book with nothing paused is a no-op, not a failure",
  empty.rechecked >= 0 && empty.changed === 0,
  `rechecked=${empty.rechecked} changed=${empty.changed} skipped=${empty.skipped}`,
);
ok(
  "…and its live mandates are untouched",
  (await readPm(victim.id))?.mandateStatus === LIVE_MANDATE &&
    (await readPm(control.id))?.mandateStatus === LIVE_MANDATE,
);

// ── A paused mandate with no gateway account is SKIPPED, never silently revived ──
{
  // Rows a baseline sweep changes are no longer paused, so the next sweep loses them.
  const baseline = await recheckPausedMandates();
  await setMandate(victim.id, REVIVABLE_MANDATE_STATUS, null);
  await setMandate(control.id, REVIVABLE_MANDATE_STATUS, account.id);
  const r = await recheckPausedMandates();
  const detail = `baseline rechecked=${baseline.rechecked} changed=${baseline.changed} skipped=${baseline.skipped}; now rechecked=${r.rechecked} changed=${r.changed} skipped=${r.skipped}`;

  // `gateway_account_id is null` is filtered in the query, so it is not even selected —
  // which is the point: a row we cannot ask about must never be treated as an answer.
  ok(
    "a paused mandate with no gateway account is not counted as rechecked",
    r.rechecked === baseline.rechecked - baseline.changed && r.changed === 0,
    detail,
  );
  // TM Test cannot poll, so the control lands in `skipped`; the victim must not.
  ok(
    "…nor even selected: only the control row (with an account) adds to skipped",
    r.skipped === baseline.skipped + 1,
    detail,
  );
  const after = await readPm(victim.id);
  ok(
    "…and its status is left exactly as it was",
    after?.mandateStatus === REVIVABLE_MANDATE_STATUS && after?.gatewayAccountId === null,
    String(after?.mandateStatus),
  );

  // Leave nothing paused behind for later sweeps to count.
  await setMandate(victim.id, LIVE_MANDATE, account.id);
  await setMandate(control.id, LIVE_MANDATE, account.id);
}

console.log("");
console.log(pass ? "✅ PAUSED MANDATES: PASS" : "❌ PAUSED MANDATES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
