/**
 * F-45 — a lapsed MANDATE demotes the instrument, and the pre-cutover backlog is
 * demoted SILENTLY.
 *
 * The charge path already refuses a debit against a mandate whose end date has passed
 * (`mandateExpiredRefusal`), so the money was correct before this. The INSTRUMENT was
 * not: the row still read `status: 'valid'`, so it was preferred over a live sibling by
 * `pickPrimaryCandidate`, shown as fine to the operator and the payer, and accepted by
 * `assertChargeableForAutoCollect` for a brand-new auto-collect subscription.
 *
 * `paymentSourceSweep` could not close that twice over — its candidate query required a
 * non-null PRINTED expiry (so `upi`/`emandate` rows never entered the scan) and its
 * transition was computed from that printed expiry alone (so a CARD mandate entered, was
 * judged on 01/2099, and always answered "no transition").
 *
 * Asserts, at the database level, what `test/unit/mandate.test.ts` asserts purely:
 *  - a mandate that lapsed AFTER the cutover: demoted AND the payer is mailed,
 *  - a mandate that lapsed BEFORE it (the measured 115-row backlog): demoted and NOT
 *    mailed — but the event STILL fires (`suppress_email: true` on its envelope), so a
 *    webhook subscriber hears about it even though no `email_messages` row is written,
 *  - a card past BOTH its printed expiry and a pre-cutover mandate date: STILL mailed
 *    (the cutover must not silence a notice we already send today),
 *  - an `emandate` row with no printed expiry at all is reached,
 *  - idempotency: a second tick transitions nothing and mails nothing more,
 *  - and the answer to "what if that was the customer's ONLY instrument": collection
 *    REFUSES with `mandate_expired` — a refusal, not a crash and not a silent skip.
 *
 *   pnpm tsx scripts/lib/verify-run.ts scripts/verify-mandate-expiry-sweep.ts
 *
 * ⚠️ NOT yet wired into `package.json` as `verify:mandate-expiry-sweep` (nor into
 * `verify-all.sh`): that file was outside the change's file boundary. One line each.
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { paymentSourceSweep, MANDATE_EXPIRY_NOTICE_FROM } from "@/modules/payment-methods/sweep";
import {
  resolveChargeCandidates,
  chargeWithMethod,
  MANDATE_EXPIRED_CODE,
} from "@/modules/invoicing/collection";
import { businesses, emailMessages, events, paymentMethods, subscriptions } from "@db/schema";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
// ⚠️ NOT unused, and not decoration. `emails/outbox` registers `enqueueEmails` as an
// event sink as an IMPORT SIDE EFFECT (`registerEventSink(enqueueEmails)` at the foot of
// that file), and the sink is what turns an emitted event into an `email_messages` row.
// Without this import the suppression half of this suite passes vacuously — no mail is
// enqueued for ANY event, so "the backlog is not mailed" would be true of everything.
// Referenced below purely so no tooling can decide it is dead.
import { enqueueEmails } from "@/modules/emails/outbox";

const checks: [string, boolean, unknown?][] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => checks.push([name, cond, detail]);

// Nothing leaves the building, and no transport is required.
const captured: OutboundEmail[] = [];
setMailer({
  kind: "console",
  /** In-process fake: reaches no network, so it can never be circuit-broken. */
  target: null,
  async send(msg) {
    captured.push(msg);
    return { providerMessageId: `fake_${captured.length}`, status: "sent" };
  },
});

/**
 * The clock instant every sweep in this suite runs at: one day after the cutover, so a
 * mandate can be placed on EITHER side of it and still be in the past.
 */
const NOW = new Date(MANDATE_EXPIRY_NOTICE_FROM.getTime() + 24 * 60 * 60 * 1000);
/** The measured backlog instant — end-of-day IST, the day before the cutover. */
const BACKLOG_EXPIRY = new Date(MANDATE_EXPIRY_NOTICE_FROM.getTime() - 5 * 60 * 60 * 1000);
/** A mandate that lapsed on its own schedule, after the engine started looking. */
const FRESH_EXPIRY = new Date(MANDATE_EXPIRY_NOTICE_FROM.getTime() + 60 * 60 * 1000);

async function main() {
  // The import above is load-bearing (see its comment); this asserts it rather than
  // trusting a linter not to remove it. A vacuous suppression proof is worse than none.
  ok("the email sink is wired up at all", typeof enqueueEmails === "function");

  const org = await createOrganization({ name: "Mandate Expiry Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "MEX Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  // Emails OFF by default (`resolveEmailConfig` reads `enabled === true`), so an
  // absent `email_messages` row would prove nothing at all unless mail is switched on.
  // This is what makes the suppression assertions load-bearing rather than vacuous.
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ emailConfig: { enabled: true } })
      .where(eq(businesses.id, biz.id)),
  );
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });

  /** Vault a card and stamp the mandate fields the gateway would have reported. */
  const instrument = async (
    email: string,
    mandate: { expiresAt: Date; rail?: string },
    printed?: { expMonth: number; expYear: number },
    // Expiry mail goes only to a card paying for a live subscription.
    subscribed = true,
  ) => {
    const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: "tok_4242",
    });
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({
          // The measured shape: a card printed far in the future whose MANDATE RazorPay
          // ended much sooner. `null` printed fields are the `upi`/`emandate` shape.
          expMonth: printed ? printed.expMonth : null,
          expYear: printed ? printed.expYear : null,
          mandateRail: mandate.rail ?? "card",
          // `confirmed` deliberately: the whole defect is that the gateway reports a live
          // status for a mandate whose own end date has gone by, so a fixture that wrote
          // a dead status would test the wrong axis.
          mandateStatus: "confirmed",
          mandateExpiresAt: mandate.expiresAt,
          mandateReference: `token_${email}`,
          mandateMaxAmountMinor: 10_000_000n,
          mandateCurrency: "INR",
        })
        .where(eq(paymentMethods.id, pm.id)),
    );
    if (subscribed)
      await withTenant(orgId, (tx) =>
        tx.insert(subscriptions).values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: customer.id,
          publicId: `sub_mex_${email}`,
          status: "active",
          currency: "INR",
          defaultPaymentMethodId: pm.id,
        }),
      );
    return { customer, pm };
  };

  const statusOf = (id: string) =>
    withTenant(orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.id, id))
        .limit(1);
      return row?.status ?? null;
    });

  const expiredEventFor = (publicId: string) =>
    withTenant(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(events)
        .where(and(eq(events.businessId, biz.id), eq(events.type, "payment_source_expired")));
      return rows.filter((e) => JSON.stringify(e.data).includes(publicId));
    });

  /**
   * Any mail raised by this instrument's expiry event — NOT pinned to one template.
   *
   * It was pinned to `card_expired`, and that stopped being the right template on
   * 2026-09-01: a lapsed MANDATE now routes to the rail-neutral `mandate_expired`, which
   * names neither a card nor a date. `card_expired` says "The {{cardBrand}} card ending
   * {{cardLast4}} … has expired" and prints "Expires: {{cardExpiry}}" — for a card-rail
   * mandate that is the PRINTED expiry (01/2099 on every row measured), and on upi/emandate
   * the placeholders collapse to "The payment card ending •••• … Expires: soon."
   *
   * So the helper asks the question that survives a copy decision — "was the payer told?" —
   * and `templateFor` below asserts WHICH template separately, so a regression in routing
   * cannot hide behind a passing "is mailed".
   */
  const mailFor = (publicId: string) =>
    withTenant(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.businessId, biz.id));
      const evs = await expiredEventFor(publicId);
      const ids = new Set(evs.map((e) => e.id));
      return rows.filter((r) => r.eventId && ids.has(r.eventId));
    });
  const templateFor = async (publicId: string) => (await mailFor(publicId)).map((r) => r.type);

  // ── 1) A mandate that lapsed AFTER the cutover: demoted, and the payer is told ────
  const fresh = await instrument(
    "fresh@a.com",
    { expiresAt: FRESH_EXPIRY },
    { expMonth: 1, expYear: 2099 },
  );
  // ── 2) The backlog: demoted, and NOT told ────────────────────────────────────────
  const backlog = await instrument(
    "backlog@a.com",
    { expiresAt: BACKLOG_EXPIRY },
    { expMonth: 1, expYear: 2099 },
  );
  // ── 3) Printed expiry ALSO past: this is mail we send today and must keep sending ─
  const both = await instrument(
    "both@a.com",
    { expiresAt: BACKLOG_EXPIRY },
    { expMonth: 7, expYear: 2026 },
  );
  // ── 4) No printed expiry at all — the rows the candidate query used to exclude ────
  const netbanking = await instrument("nb@a.com", { expiresAt: FRESH_EXPIRY, rail: "emandate" });
  // ── 5) A live mandate, to prove the sweep is not simply demoting everything ───────
  const live = await instrument(
    "live@a.com",
    { expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000) },
    { expMonth: 1, expYear: 2099 },
  );

  // ── 6) Same lapse, but the card pays for nothing live: a former customer's card ────
  const former = await instrument(
    "former@a.com",
    { expiresAt: FRESH_EXPIRY },
    { expMonth: 1, expYear: 2099 },
    false,
  );

  const swept = await paymentSourceSweep(NOW);

  ok(
    "card paying for no live subscription → still demoted",
    (await statusOf(former.pm.id)) === "expired",
  );
  ok(
    "card paying for no live subscription → the event still fires",
    (await expiredEventFor(former.pm.publicId)).length === 1,
  );
  ok(
    "card paying for no live subscription → the payer is NOT mailed",
    (await mailFor(former.pm.publicId)).length === 0,
  );

  ok("mandate lapsed after cutover → status expired", (await statusOf(fresh.pm.id)) === "expired");
  ok(
    "mandate lapsed after cutover → payment_source_expired emitted",
    (await expiredEventFor(fresh.pm.publicId)).length === 1,
  );
  ok(
    "mandate lapsed after cutover → the payer IS mailed",
    (await mailFor(fresh.pm.publicId)).length === 1,
  );
  ok(
    "mandate lapsed after cutover → and with the RAIL-NEUTRAL template, not card_expired",
    (await templateFor(fresh.pm.publicId)).every((t) => t === "mandate_expired"),
    (await templateFor(fresh.pm.publicId)).join(",") || "none",
  );
  // TOP-LEVEL, so it survives `events/content.ts` replacing `data.payment_source` with a
  // fresh snapshot. Without it a subscriber cannot tell a mandate lapse from a printed
  // card expiry — and the `card_expired` template they trigger says "card" either way.
  ok(
    "the expired event names WHICH expiry fired",
    (await expiredEventFor(fresh.pm.publicId)).every(
      (e) => (e.data as Record<string, unknown>).expiry_reason === "mandate",
    ),
    (await expiredEventFor(fresh.pm.publicId)).map(
      (e) => (e.data as Record<string, unknown>).expiry_reason,
    ),
  );
  ok(
    "a MAILED transition carries no suppress_email",
    (await expiredEventFor(fresh.pm.publicId)).every(
      (e) => (e.data as Record<string, unknown>).suppress_email === undefined,
    ),
  );
  ok(
    "a printed-expiry event still names the card",
    (await expiredEventFor(both.pm.publicId)).every(
      (e) => (e.data as Record<string, unknown>).expiry_reason === "card",
    ),
  );

  ok(
    "pre-cutover backlog → status expired (demoted anyway)",
    (await statusOf(backlog.pm.id)) === "expired",
  );
  // The event STILL fires — only the mail is suppressed (see suppress_email below). This
  // is the fix for "suppressing the backlog mail necessarily suppressed the webhook too"
  // (`docs/PROGRESS.md`): before it, this row was `=== 0`, which was the same event
  // absence a webhook subscriber would have seen.
  ok(
    "pre-cutover backlog → payment_source_expired STILL fires (the webhook is not silenced)",
    (await expiredEventFor(backlog.pm.publicId)).length === 1,
  );
  ok(
    "pre-cutover backlog → the envelope says why no mail follows",
    (await expiredEventFor(backlog.pm.publicId)).every(
      (e) => (e.data as Record<string, unknown>).suppress_email === true,
    ),
  );
  ok(
    "pre-cutover backlog → the payer is NOT mailed",
    (await mailFor(backlog.pm.publicId)).length === 0,
  );

  ok("printed expiry past too → status expired", (await statusOf(both.pm.id)) === "expired");
  ok(
    "printed expiry past too → STILL mailed (no regression)",
    (await mailFor(both.pm.publicId)).length === 1,
  );
  ok(
    "printed expiry past too → keeps card_expired: the CARD really did expire",
    (await templateFor(both.pm.publicId)).every((t) => t === "card_expired"),
    (await templateFor(both.pm.publicId)).join(",") || "none",
  );

  ok(
    "emandate with no printed expiry → reached and demoted",
    (await statusOf(netbanking.pm.id)) === "expired",
  );
  ok(
    "emandate with no printed expiry → the payer IS mailed",
    (await mailFor(netbanking.pm.publicId)).length === 1,
  );
  ok(
    'emandate → rail-neutral template (card_expired would say "card ending ••••, expires soon")',
    (await templateFor(netbanking.pm.publicId)).every((t) => t === "mandate_expired"),
    (await templateFor(netbanking.pm.publicId)).join(",") || "none",
  );

  ok("a mandate inside its term is untouched", (await statusOf(live.pm.id)) === "valid");

  ok("the sweep counts the silenced demotions separately", swept.silenced >= 1, swept);

  // ── 6) Idempotency: the sweep runs every tick and must not mail twice ─────────────
  // Scoped to THIS business, not to the returned counts. `scanBusinessFilter` answers
  // `undefined` outside a clock tick, so a suite calling the sweep directly scans every
  // business in the database — and a scratch DB shared with other suites holds thousands
  // of instruments. A global `expired === 0` would be asserting other suites' fixtures.
  const mailsBefore = await withTenant(orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.businessId, biz.id)),
  );
  const eventsBefore = (await expiredEventFor("pm_")).length;
  await paymentSourceSweep(NOW);
  const mailsAfter = await withTenant(orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.businessId, biz.id)),
  );
  ok("second tick mails nothing more", mailsAfter.length === mailsBefore.length, {
    before: mailsBefore.length,
    after: mailsAfter.length,
  });
  ok(
    "second tick emits no further expiry events",
    (await expiredEventFor("pm_")).length === eventsBefore,
  );
  ok(
    "second tick re-demotes nothing (statuses unchanged)",
    (await statusOf(fresh.pm.id)) === "expired" &&
      (await statusOf(backlog.pm.id)) === "expired" &&
      (await statusOf(live.pm.id)) === "valid",
  );

  // ── 7) The demoted instrument was the customer's ONLY one ────────────────────────
  // Reported rather than assumed: demotion does NOT hide the row, because
  // `resolveChargeCandidates` never filtered on `payment_methods.status`. So the customer
  // is not "left with nothing to charge" — they keep a candidate, and the charge
  // pre-flight refuses it by name. A refusal is the acceptable outcome; a crash or a
  // silent skip is not.
  const { primary } = await resolveChargeCandidates({
    organizationId: orgId,
    customerId: backlog.customer.id,
  });
  ok(
    "a demoted instrument is still SELECTED (status is not a collection filter)",
    primary?.id === backlog.pm.id,
  );

  let threw: unknown = null;
  let refusalCode: string | undefined;
  try {
    const attempt = await chargeWithMethod({
      organizationId: orgId,
      businessId: biz.id,
      currency: "INR",
      pm: primary!,
      amountMinor: 100_000n,
      idempotencyKey: `mex_${backlog.pm.publicId}_1`,
      // #31 made `ownershipRef` required on `chargeWithMethod` so no call site can
      // silently fall back to the idempotency key. This probe charges an instrument
      // directly with no invoice or subscription behind it, so the instrument is the row
      // it names — and the charge is refused locally before the gateway sees it anyway.
      ownershipRef: backlog.pm.publicId,
      description: "F-45 refusal probe",
      contact: { autoCollection: "on", email: "backlog@a.com", phone: null },
    });
    refusalCode = attempt.result.failure?.code;
  } catch (e) {
    threw = e;
  }
  ok("charging a lapsed mandate does not throw", threw === null, threw);
  ok(
    "charging a lapsed mandate refuses with mandate_expired",
    refusalCode === MANDATE_EXPIRED_CODE,
    refusalCode,
  );

  // Nothing is DELIVERED here — `deliverPendingEmails` is what calls the mailer, and this
  // suite asserts over `email_messages` because the suppression is about what gets
  // ENQUEUED. The capturing mailer above is a containment net, not an assertion: if some
  // path did deliver, it lands in `captured` instead of leaving the building.
  ok("no mail actually left the building", captured.length === 0, captured.length);
}

await main();

console.log("");
let pass = true;
for (const [name, cond, detail] of checks) {
  console.log(
    `${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!cond) pass = false;
}
console.log(
  pass
    ? `\n✅ MANDATE-EXPIRY-SWEEP: PASS (${checks.length}/${checks.length})`
    : "\n❌ MANDATE-EXPIRY-SWEEP: FAIL",
);
await closeDb();
process.exit(pass ? 0 : 1);
