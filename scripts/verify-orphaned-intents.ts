/**
 * `payment_intent.created` → the orphan detector.
 *
 * The one property worth a gate is the GRACE PERIOD. The event fires before our own
 * transaction commits, so an inline "no local row ⇒ orphan" test is true of nearly every
 * payment we make; get this wrong and the alert opens at the size of our whole payment
 * volume and is muted the same day. So: inside the grace window a fresh intent must NOT
 * count, and past it an unrecorded one must.
 */
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { gatewayRequestLogs } from "@db/schema";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import {
  countOrphanedIntents,
  orphanedIntents,
  ORPHAN_INTENT_GRACE_MS,
} from "@/modules/payments/orphaned-intents";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

const stamp = Date.now();
const now = new Date();
/** Comfortably past the grace period, so ageing is unambiguous. */
const aged = new Date(now.getTime() - ORPHAN_INTENT_GRACE_MS - 60_000);

async function deliverCreated(label: string, ownership: "ours" | "foreign") {
  const intentId = `pi_orph_${label}_${stamp}`;
  const eventId = `evt_orph_${label}_${stamp}`;
  const outcome = await handleProviderEvent(
    "stripe",
    {
      providerEventId: eventId,
      type: "intent.created",
      occurredAt: now,
      providerIntentId: intentId,
      ownership,
      ...(ownership === "ours" ? { ownershipRef: `inv_orph_${stamp}` } : {}),
      raw: { type: "payment_intent.created", data: { object: { id: intentId } } },
    },
    { payload: { type: "payment_intent.created", data: { object: { id: intentId } } } },
  );
  return { intentId, eventId, outcome };
}

/**
 * A SETUP intent armed at the gateway with no local row.
 *
 * `setup_intent.created` is unmapped, so it arrives as `type='unknown'` with the real name
 * in the payload — the same shape `payment_intent.created` had, and the same reason a query
 * by `type` reports zero for exactly the events we are blind to.
 *
 * The real book contains no setup orphans today (measured: all 10 of ours resolve to a
 * `payment_intents` row), which is the right reading for a healthy signal and also why this
 * fixture has to exist: a population that is empty everywhere proves nothing about the
 * predicate that reads it.
 */
async function deliverSetupCreated(label: string, ownership: "ours" | "foreign") {
  const intentId = `seti_orph_${label}_${stamp}`;
  const eventId = `evt_seti_${label}_${stamp}`;
  const raw = { type: "setup_intent.created", data: { object: { id: intentId } } };
  const outcome = await handleProviderEvent(
    "stripe",
    {
      providerEventId: eventId,
      // `unknown`, not `intent.created`: this is what the adapter really produces for an
      // unmapped type, and planting the mapped one would test a shape production never
      // stores.
      type: "unknown",
      occurredAt: now,
      providerIntentId: intentId,
      ownership,
      ...(ownership === "ours" ? { ownershipRef: `pm_orph_${stamp}` } : {}),
      raw,
    },
    { payload: raw },
  );
  return { intentId, eventId, outcome };
}

/**
 * The void that follows an orphan — what an operator does when they act on this alert.
 *
 * Shaped like the real delivery, because the correlation is the fragile part:
 * `payment_intent.canceled` normalizes to `intent.voided` and carries `providerIntentId`,
 * and so does `charge.expired`, whose payload object is a CHARGE. A fixture that leaned on
 * `data.object.id` would pass while the production shape missed.
 */
async function deliverVoided(intentId: string, as: "canceled" | "expired" = "canceled") {
  // `charge.expired` carries a CHARGE — the intent id lives only in the normalized event.
  const raw =
    as === "expired"
      ? {
          type: "charge.expired",
          data: { object: { id: `ch_${intentId}`, payment_intent: intentId } },
        }
      : { type: "payment_intent.canceled", data: { object: { id: intentId } } };
  return handleProviderEvent(
    "stripe",
    {
      providerEventId: `evt_void_${as}_${intentId}`,
      type: "intent.voided",
      occurredAt: now,
      providerIntentId: intentId,
      ownership: "ours",
      raw,
    },
    { payload: raw },
  );
}

/** Backdate the log row — the sweep judges on `received_at`, which is what ages. */
async function age(eventId: string) {
  await systemDb.execute(sql`
    update provider_events set received_at = ${aged.toISOString()}::timestamptz
    where provider_event_id = ${eventId}`);
}

async function main() {
  const before = await countOrphanedIntents(now);

  // ── the event is recorded, and deliberately does nothing ────────────────────────
  const fresh = await deliverCreated("fresh", "ours");
  ok(
    `a created intent is IGNORED inline, never acted on (got '${fresh.outcome}')`,
    fresh.outcome === "ignored",
  );
  const res = await systemDb.execute(sql`
    select type from provider_events where provider_event_id = ${fresh.eventId}`);
  const [row] = (Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? [])) as {
    type: string;
  }[];
  ok(
    "…and it is RECORDED, which is the only reason to handle it at all",
    row?.type === "intent.created",
  );

  // ── THE GRACE PERIOD ───────────────────────────────────────────────────────────
  ok(
    "a FRESH unrecorded intent is not an orphan — inside the grace period nothing is",
    (await countOrphanedIntents(now)) === before,
    `count still ${before}`,
  );
  await age(fresh.eventId);
  ok(
    "…the SAME intent past the grace period IS one",
    (await countOrphanedIntents(now)) === before + 1,
  );

  /**
   * NOT asserted here: that an intent WITH a transaction stops being an orphan.
   *
   * A synthetic transaction needs an organization, a business and RLS context, and this
   * suite runs against an empty scratch database — building a whole tenant to prove one
   * `not exists` arm would test the fixture more than the predicate. That arm has much
   * stronger evidence anyway, from production-shaped data: of 5,245 `payment_intent.created`
   * events on the dev database, the predicate excluded 5,238 precisely because they DID
   * acquire a transaction, and returned the 7 that did not. A synthetic row could not
   * distinguish a working anti-join from one that matches nothing.
   */

  // ── whose money is it ──────────────────────────────────────────────────────────
  const withOurs = await countOrphanedIntents(now);
  const foreign = await deliverCreated("foreign", "foreign");
  await age(foreign.eventId);
  ok(
    "a FOREIGN intent is never ours to report, however old it gets",
    (await countOrphanedIntents(now)) === withOurs,
    `still ${withOurs}`,
  );

  // ── the count and the rows are the same question ───────────────────────────────
  const rows = await orphanedIntents(now, 500);
  ok(
    "the evidence list matches the count exactly",
    rows.length === (await countOrphanedIntents(now)),
    `${rows.length} rows`,
  );

  // ── A VOID AT THE GATEWAY CLOSES THE ORPHAN ────────────────────────────────────
  // The alert tells the operator to "either void it or let the capture arrive". Doing the
  // first thing used to change nothing: the predicate asked only whether we hold a row, so
  // a handled orphan stayed in the count until the 7-day lookback rolled past it — amber
  // for a week, and indistinguishable from a new one arriving. Two production intents sat
  // that way on 2026-09-06 after being cancelled at Stripe.
  {
    const beforeVoid = await countOrphanedIntents(now);
    const armed = await deliverCreated("voided", "ours");
    await age(armed.eventId);
    ok(
      "an unrecorded intent counts while it is still armed",
      (await countOrphanedIntents(now)) === beforeVoid + 1,
    );

    await deliverVoided(armed.intentId);
    ok(
      "…and stops counting once the gateway reports it VOIDED",
      (await countOrphanedIntents(now)) === beforeVoid,
    );
    ok(
      "…and leaves the evidence list too, not just the count",
      !(await orphanedIntents(now, 500)).some((o) => o.intentId === armed.intentId),
    );

    // The other way an armed hold ends: it lapses. `charge.expired` normalizes to the same
    // `intent.voided`, but its payload object is a CHARGE — so this case is reachable ONLY
    // through `normalized.providerIntentId`. Asserted separately because the fixture above
    // carries the intent id in both places and would pass on either arm.
    const lapsed = await deliverCreated("expired", "ours");
    await age(lapsed.eventId);
    ok(
      "an intent whose hold LAPSED counts until the expiry arrives",
      (await countOrphanedIntents(now)) === beforeVoid + 1,
    );
    await deliverVoided(lapsed.intentId, "expired");
    ok(
      "…and clears on charge.expired, correlated through providerIntentId, not the ch_ id",
      (await countOrphanedIntents(now)) === beforeVoid,
    );
  }

  // ── OUR OWN LOG, for the gateways that send no created event ───────────────────
  // `intent.created` comes from Stripe alone, so a RazorPay order stranded by a crash
  // between its response and our commit was invisible — and no new webhook fixes that,
  // because neither RazorPay nor PayPal sends one for an object merely created.
  // `gateway_request_logs` needs nobody to tell us anything: the response was written the
  // moment it arrived, before the commit a crash would lose.
  {
    const logged = async (id: string, trace: string | null, method = "POST") => {
      await systemDb.insert(gatewayRequestLogs).values({
        businessId: null,
        gatewayKey: "razorpay",
        method,
        url:
          method === "POST"
            ? "https://api.razorpay.com/v1/orders"
            : `https://api.razorpay.com/v1/payments/${id}`,
        status: 200,
        operation: "charge",
        source: "engine",
        responseBody: { id },
        traceId: trace,
        createdAt: aged,
      });
      return id;
    };

    const beforeLog = await countOrphanedIntents(now);
    const stranded = await logged(`order_orph_${stamp}`, `trace_orph_${stamp}`);
    ok(
      "a logged 2xx create naming an id nothing recorded IS an orphan",
      (await countOrphanedIntents(now)) === beforeLog + 1,
    );
    const row = (await orphanedIntents(now, 500)).find((o) => o.intentId === stranded);
    ok(
      "…on a gateway that emits no created event at all — the population Stripe-only missed",
      row?.gatewayKey === "razorpay",
      String(row?.gatewayKey),
    );
    ok(
      "…labelled `request_log`: there is no event id to look up, only the trace",
      row?.source === "request_log",
      String(row?.source),
    );

    /**
     * THE MEASURED FALSE POSITIVE, and the reason this arm is `is not null` rather than the
     * tidier "unprovable, so report it".
     *
     * RazorPay's charge creates an ORDER and then a payment, and we record the PAYMENT — so
     * the order is an id no local row names on every SUCCESSFUL charge. The trace is what
     * separates those from a real orphan. Measured on the dev database: 568 logged creates
     * were unmatched by id (530 RazorPay orders, 38 PayPal captures), 342 of them had no
     * trace, and the count of rows that had a trace AND no transaction or attempt on it was
     * ZERO. Reading a null trace as reportable would have opened this alert at 342 and never
     * let it fall — the permanently-red signal this file's ownership filter exists to avoid.
     */
    const beforeNull = await countOrphanedIntents(now);
    await logged(`order_notrace_${stamp}`, null);
    ok(
      "…while one with NO TRACE is never reported — it cannot be judged either way",
      (await countOrphanedIntents(now)) === beforeNull,
      `still ${beforeNull}`,
    );

    // getPayment logs its GET as `charge`; a script reading existing payments paged prod.
    const beforeRead = await countOrphanedIntents(now);
    await logged(`pay_read_${stamp}`, `trace_read_${stamp}`, "GET");
    ok(
      "…and a READ logged as `charge` is never a create",
      (await countOrphanedIntents(now)) === beforeRead,
      `still ${beforeRead}`,
    );

    /**
     * NOT asserted synthetically: that a create whose flow WAS recorded drops out. It needs
     * a `transactions` or `payment_attempts` row, and both need an organization, a business
     * and RLS context — the same reason the transactions anti-join above is left to
     * production-shaped evidence rather than a fixture. That evidence is the measurement in
     * the comment above: every one of the 226 logged creates carrying a trace was excluded,
     * which a synthetic row could not have distinguished from an anti-join matching nothing.
     */
  }

  // ── A SETUP intent orphan is detected, and named as one ──────────────────────
  // ACH, SEPA and Apple Pay all vault through a SetupIntent, so the rails added on
  // 2026-09-05 were blind in exactly the way payment intents had just stopped being. An
  // orphaned setup intent loses no money TODAY — which is what makes it quieter and worse:
  // an instrument exists at the gateway that we never stored, and the next renewal charges
  // a card the customer believes they saved.
  {
    const mine = await deliverSetupCreated("mine", "ours");
    const theirs = await deliverSetupCreated("theirs", "foreign");
    await age(mine.eventId);
    await age(theirs.eventId);

    const found = await orphanedIntents(now, 200);
    const row = found.find((o) => o.intentId === mine.intentId);
    ok("an orphaned SETUP intent is found", row != null, mine.intentId);
    ok(
      "…and is labelled `setup`, not `payment` — the remediation differs",
      row?.kind === "setup",
      String(row?.kind),
    );
    ok(
      "…while a FOREIGN setup intent is still ignored",
      !found.some((o) => o.intentId === theirs.intentId),
    );
  }
}

main()
  .then(async () => {
    await closeDb();
    console.log(
      failed === 0 ? "\n✅ ORPHANED INTENTS: PASS" : `\n❌ ORPHANED INTENTS: FAIL (${failed})`,
    );
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
