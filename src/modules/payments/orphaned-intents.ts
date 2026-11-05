/**
 * Intents the gateway minted that we have no local record of.
 *
 * WHY THIS EXISTS. Every other path learns about gateway money from an event that names
 * something of ours — a charge correlates to a transaction, a refund to a payment. An
 * intent created during a timeout, or during a crash between the gateway's response and
 * our commit, names nothing: there is no transaction, no payment, and therefore nothing
 * for `unapplied_gateway_money` to count (it counts tagged PAYMENTS). Money is armed at
 * the gateway and the engine is structurally unable to mention it.
 *
 * `payment_intent.created` is the only signal that reaches us in that case, and it was
 * already arriving — 5,245 of them by 2026-09-05, landing as `type='unknown'` because the
 * adapter had no mapping, which is why a query by name found none and read as "we are not
 * subscribed to it".
 *
 * ⚠️ THE GRACE PERIOD IS THE WHOLE DESIGN. The event fires before our own transaction
 * commits, so "no local row" is momentarily true of nearly every payment we make. Asked
 * inline, this question answers "orphan" for all of them. Asked after
 * `ORPHAN_INTENT_GRACE_MS`, it answers it only for the ones that really are.
 *
 * ⚠️ STRIPE-ONLY TODAY, and not by choice. `intent.created` is emitted by exactly one
 * adapter — RazorPay maps no event to it and PayPal maps none either — so an order
 * RazorPay stranded is invisible here. The same asymmetry runs through the void arm below:
 * Stripe and PayPal normalize a cancel to `intent.voided`, RazorPay normalizes nothing to
 * it. If RazorPay ever gains a created event, it needs the voided one in the SAME change,
 * or its orphans will be detectable and permanently unclearable.
 *
 * It REPORTS and does not reconcile. An intent is not money — it may never be charged —
 * so the honest action is to make it visible and let an operator look, not to move funds
 * against a row we cannot explain. A capture that does arrive already has a path
 * (`reconcileUnmatchedCapture`).
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";

const log = createLogger("payments.orphaned-intents");

/**
 * How long an intent may exist unrecorded before we call it an orphan.
 *
 * Fifteen minutes is far past our own commit — a debit and its transaction land within
 * seconds — and comfortably past a retried request. It is a floor on FALSE positives, not
 * a target for detection speed: a real orphan is money nobody is collecting, and noticing
 * it fifteen minutes late costs nothing, while crying orphan on every live payment costs
 * the alert its credibility.
 */
export const ORPHAN_INTENT_GRACE_MS = 15 * 60 * 1000;

/** How far back a single pass looks. Bounded so this can never become a full-table scan. */
export const ORPHAN_INTENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrphanedIntent {
  providerEventId: string;
  intentId: string;
  gatewayKey: string;
  businessId: string | null;
  receivedAt: Date;
  ownershipRef: string | null;
  /**
   * `payment` — money may have moved with no local row. `setup` — an INSTRUMENT may exist
   * at the gateway with no local row, which is the quieter failure: nothing is lost today
   * and the next renewal charges a card the customer believes they saved.
   *
   * Added with ACH, SEPA and Apple Pay, which ALL vault through a SetupIntent — the newest
   * rails were blind in exactly the way payment intents had just stopped being.
   */
  kind: "payment" | "setup";
  /**
   * WHICH EVIDENCE FOUND IT. `webhook` — the gateway told us it made an object (Stripe
   * only, the sole adapter emitting `intent.created`). `request_log` — our OWN log says a
   * create returned an id we never recorded, which works for every gateway and is the only
   * thing that sees a RazorPay order stranded by a crash between the response and the
   * commit. Named on the row because the remediation differs: the first can be looked up
   * by event id, the second only by trace.
   */
  source: "webhook" | "request_log";
}

/**
 * The predicate, in ONE place.
 *
 * The count and the row list are built from this same fragment for the reason the
 * evidence registry exists at all: a number an operator cannot reach the rows behind is a
 * dead end, and a number computed by a different query than the list is worse — the two
 * drift and nobody finds out.
 *
 * Reads BOTH names. New rows carry `intent.created`; the 5,245 already on disk carry
 * `unknown` with the real type in the payload, and those are exactly the history worth
 * sweeping. Bounded by `received_at` so the jsonb read stays over a small window.
 *
 * ONLY `ownership = 'ours'` counts, and that is correctness rather than noise-reduction.
 * We stamp the ownership tag in the CREATE call itself, not after committing — so an
 * intent minted during a request that then timed out or crashed is tagged `ours` all the
 * same. A tag is therefore positive evidence that WE armed this money, and it is present
 * in exactly the failure this file hunts.
 *
 * The other two are excluded for different reasons, both deliberate. `foreign` is another
 * product on the same Stripe account and none of our business; reporting it trains an
 * operator to ignore the alert. Rows with NO ownership key at all — 126 of them on
 * 2026-09-05, none newer than 2026-09-03 — predate the key being recorded on this event
 * and can never be classified by anything. Counting them would open this alert at 126 and
 * never let it fall, which is the permanently-red signal `alerts.ts` warns about people
 * learning to close.
 */
export const ORPHAN_INTENT_FROM = sql`provider_events pe`;

export const ORPHAN_INTENT_WHERE = (now: Date) => sql`
  pe.received_at >= ${new Date(now.getTime() - ORPHAN_INTENT_LOOKBACK_MS).toISOString()}::timestamptz
    and pe.received_at <= ${new Date(now.getTime() - ORPHAN_INTENT_GRACE_MS).toISOString()}::timestamptz
    and (
      pe.type = 'intent.created'
      or (
        pe.type = 'unknown'
        and pe.payload::jsonb ->> 'type' in ('payment_intent.created', 'setup_intent.created')
      )
    )
    and pe.normalized ->> 'ownership' = 'ours'
    and (pe.payload::jsonb -> 'data' -> 'object' ->> 'id') is not null
    -- The two places an intent of ours is legitimately recorded. Either one means the
    -- request path DID complete and this is simply the event announcing it.
    and not exists (
      select 1 from transactions t
      where t.id_at_gateway = (pe.payload::jsonb -> 'data' -> 'object' ->> 'id')
    )
    and not exists (
      select 1 from payment_intents pi
      where pi.intent_at_gateway = (pe.payload::jsonb -> 'data' -> 'object' ->> 'id')
    )
    -- A VOID IS THE REMEDIATION THIS ALERT ASKS FOR, so it has to clear it. Nothing above
    -- looks at the intent's state at the gateway, only at whether we hold a row — so an
    -- operator who did exactly what the alert text says ("either void it or let the capture
    -- arrive") watched the count stay put, with no second action available and no way to
    -- tell a handled orphan from a new one. That is the permanently-amber signal the
    -- ownership filter above was written to avoid, arriving through the back door.
    --
    -- Correlated on the INTENT id, not the event id: the void is its own delivery. Read
    -- from normalized.providerIntentId because charge.expired also normalizes to
    -- intent.voided and its payload object is a Charge — data.object.id there is a ch_…
    -- that would silently match nothing. Bounded by received_at so this stays inside the
    -- same window as the outer scan.
    and not exists (
      select 1 from provider_events v
      where v.type = 'intent.voided'
        and v.provider_key = pe.provider_key
        and v.received_at >= pe.received_at
        and coalesce(
              v.normalized ->> 'providerIntentId',
              v.payload::jsonb -> 'data' -> 'object' ->> 'id'
            ) = (pe.payload::jsonb -> 'data' -> 'object' ->> 'id')
    )
`;

/**
 * THE SECOND POPULATION: an object our OWN LOG says the gateway made, that we never
 * recorded.
 *
 * The webhook population above can only ever be as wide as the webhooks: `intent.created`
 * is emitted by STRIPE alone — RazorPay maps nothing to it and PayPal maps nothing either
 * — so a RazorPay order left stranded by a crash between its response and our commit was
 * invisible, and no new webhook fixes that because neither gateway sends one for an object
 * that was merely created.
 *
 * `gateway_request_logs` does not depend on the gateway telling us anything. It holds our
 * own request, its status and its response, written the moment the answer arrived — before
 * the commit that a crash would lose. So: a 2xx create whose response named an id, past
 * the same grace period, with nothing local naming it.
 *
 * ⚠️ THE TRACE CLAUSE IS NOT A REFINEMENT, IT IS WHAT MAKES THIS USABLE. RazorPay's charge
 * creates an ORDER (`order_…`) and then a payment (`pay_…`), and we record the payment. So
 * the order is, on the face of it, an id no local row names — on EVERY successful RazorPay
 * charge. Matching a transaction or an attempt on the same `trace_id` says "this request
 * belonged to a flow that WAS recorded", which is the real question, and it is the same
 * answer for a Stripe pi that became a transaction under its own id.
 *
 * `id` survives redaction on purpose and not by luck: `redactBody` masks by KEY NAME
 * (`SECRET_BODY_KEY_RE`), and `id` is not one of them.
 */
export const ORPHAN_LOG_WHERE = (now: Date) => sql`
  gl.created_at >= ${new Date(now.getTime() - ORPHAN_INTENT_LOOKBACK_MS).toISOString()}::timestamptz
    and gl.created_at <= ${new Date(now.getTime() - ORPHAN_INTENT_GRACE_MS).toISOString()}::timestamptz
    -- The three money-creating operations. ensure_customer also answers an id, and a
    -- customer is not money; refund and void_intent act on an object that already
    -- exists and is therefore already ours.
    and gl.operation in ('charge', 'create_intent', 'create_setup_intent')
    -- Only a write can create. RazorPay's getPayment logs its GET as 'charge', so a read of
    -- an existing payment (a reconcile or refund script) otherwise counts as a stranded create.
    and upper(gl.method) = 'POST'
    and gl.status >= 200 and gl.status < 300
    and (gl.response_body::jsonb ->> 'id') is not null
    and not exists (
      select 1 from transactions t
      where t.id_at_gateway = (gl.response_body::jsonb ->> 'id')
    )
    and not exists (
      select 1 from payment_intents pi
      where pi.intent_at_gateway = (gl.response_body::jsonb ->> 'id')
    )
    -- …and the flow it belonged to was not recorded under some OTHER id. See above: this
    -- is the clause that keeps every successful RazorPay order out.
    --
    -- ⚠️ THE TRACE MUST BE PRESENT, and this is measured rather than tidy. Reading a NULL
    -- trace as "unprovable, so report it" put 342 rows into this population on the dev
    -- database (530 RazorPay orders and 38 PayPal captures unmatched by id, of which every
    -- single one with a trace was correctly excluded — the trace-present count was ZERO).
    -- That is the permanently-red signal this file's ownership filter was written to avoid,
    -- arriving through a different door. Without a trace we cannot tell a stranded object
    -- from a recorded one, and an honest detector does not open an alert on a number
    -- nobody can act on.
    and gl.trace_id is not null
    and not exists (
      select 1 from transactions t2 where t2.trace_id = gl.trace_id
    )
    and not exists (
      select 1 from payment_attempts pa where pa.trace_id = gl.trace_id
    )
`;

/** `from … where …`, for the two readers in this file. */
const ORPHAN_PREDICATE = (now: Date) =>
  sql`from ${ORPHAN_INTENT_FROM} where ${ORPHAN_INTENT_WHERE(now)}`;

/** The rows behind the count — what an operator opens. */
export async function orphanedIntents(now: Date, limit = 100): Promise<OrphanedIntent[]> {
  const res = await systemDb.execute(sql`
    select
      pe.provider_event_id,
      (pe.payload::jsonb -> 'data' -> 'object' ->> 'id') as intent_id,
      pe.provider_key,
      pe.business_id,
      pe.received_at,
      pe.normalized ->> 'ownershipRef' as ownership_ref,
      -- Which KIND of intent was armed. A payment intent means money may move; a setup
      -- intent means an instrument may exist at the gateway that we have no record of, so
      -- the next renewal collects from a card the customer thinks they saved and we never
      -- stored. Different remediations, so the operator must not have to guess.
      case
        when pe.payload::jsonb ->> 'type' = 'setup_intent.created' then 'setup'
        else 'payment'
      end as kind,
      'webhook' as source
    ${ORPHAN_PREDICATE(now)}
    union all
    select
      -- No provider event exists for this one BY CONSTRUCTION: the gateway never told us.
      -- The trace is what an operator greps, and what the predicate proved was unrecorded.
      concat('trace:', gl.trace_id) as provider_event_id,
      (gl.response_body::jsonb ->> 'id') as intent_id,
      gl.gateway_key as provider_key,
      gl.business_id,
      gl.created_at as received_at,
      null as ownership_ref,
      case when gl.operation = 'create_setup_intent' then 'setup' else 'payment' end as kind,
      'request_log' as source
    from gateway_request_logs gl
    where ${ORPHAN_LOG_WHERE(now)}
    order by received_at desc
    limit ${limit}`);
  const rows = (Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    providerEventId: String(r.provider_event_id),
    intentId: String(r.intent_id),
    gatewayKey: String(r.provider_key),
    businessId: r.business_id == null ? null : String(r.business_id),
    receivedAt: new Date(String(r.received_at)),
    ownershipRef: r.ownership_ref == null ? null : String(r.ownership_ref),
    kind: r.kind === "setup" ? "setup" : "payment",
    source: r.source === "request_log" ? "request_log" : "webhook",
  }));
}

export async function countOrphanedIntents(now: Date): Promise<number> {
  // BOTH populations, because the list returns both — the evidence registry exists so an
  // operator can reach the rows behind a number, and a count computed from a different
  // query than the list is the one failure that registry cannot survive.
  const res = await systemDb.execute(sql`
    select (
      (select count(*) ${ORPHAN_PREDICATE(now)})
      + (select count(*) from gateway_request_logs gl where ${ORPHAN_LOG_WHERE(now)})
    )::int as n`);
  const rows = (Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
  return Number(rows[0]?.n ?? 0);
}

export interface OrphanSweepResult {
  examined: number;
  orphans: number;
}

/**
 * One pass. Counts, logs the sample an operator would want, and returns — no writes.
 *
 * `warn`, not `error`: nothing is broken in the engine, and the finding may be a foreign
 * intent we could not classify. `error` here would page someone for a state no code of
 * ours can fix, which is how a signal gets muted.
 */
export async function sweepOrphanedIntents(now: Date): Promise<OrphanSweepResult> {
  const rows = await orphanedIntents(now);
  if (rows.length > 0) {
    log.warn("intents exist at the gateway that this engine has no record of", {
      event: "orphaned_gateway_intents",
      count: rows.length,
      grace_minutes: ORPHAN_INTENT_GRACE_MS / 60_000,
      // The oldest is the one worth looking at first: it has had the longest to be
      // reconciled by something else and was not.
      oldest: rows[rows.length - 1]?.receivedAt.toISOString(),
      sample: rows.slice(0, 5).map((r) => r.intentId),
    });
  }
  return { examined: rows.length, orphans: rows.length };
}
