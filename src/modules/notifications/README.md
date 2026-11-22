# notifications — tell the merchant's own team what happened

> Source: `src/modules/notifications/` · Routes: `src/api/notification-routes.ts` · Schema:
> `db/schema/notifications.ts` (migration 0533) · Layer: billing. Replaces `team-alerts`.

## Purpose
Each member chooses which billing events reach them, when (Instant, in the daily summary, or
off) and where (push to their devices, email). Instant events also land in the in-app bell.
Owners and admins add shared destinations for the organization: Google Chat spaces and email
addresses outside the organization. A daily and a weekly summary go to members and destinations
that ask for them. Slack joins the destinations later.

## Scope rules
- **Settings belong to (member, organization).** A row with `business_id` NULL is the
  default and applies to every live business, including businesses created later. A row with a
  business holds only that business's exceptions (kinds it overrides). The member can also limit
  everything to selected businesses (`notification_settings_org.business_filter`).
- **Personal across organizations:** devices (`push_subscriptions`), quiet hours, summary hour,
  weekly day and timezone (`notification_settings`).
- **Nothing until set up.** A member with no default row gets nothing, not even bell rows.
  The first save seeds the defaults (`defaultPreferences(role)`).
- **Live only**, except the bell: a test business's events make bell rows with `test = true`
  and send on no channel. Summaries skip test businesses.
- **Role at send time.** Each kind names a permission (`catalogue.ts`); a member whose role
  lacks it gets nothing for that kind, checked when sending, so a role change applies at once.

## Catalogue (`catalogue.ts`, pure)
`NotificationKind` — 26 kinds. Each entry: `group`, `label`, `help`, `tone`
(`destructive | warning | neutral`), `permission`, `amount` (has an amount limit),
`source` (`event` types, `clock`, or `direct`), `derived` (a check on the loaded facts:
`fraud_decline | first_invoice | live_subscription | merchant_account | portal`),
`defaultTiming` (may depend on role; the owner counts as an admin), `defaultPush`,
`defaultEmail`, `supersedes` (a derived kind wins over its parent for one recipient and one
event: `pickKindsForRecipient`). `candidateKinds({type, source})` returns the portal kind
only when `source = 'portal'`: the portal's subscription routes (change, scheduled change,
pause, resume, reactivate, restart, cancel, retention offer); every portal route carries it (`initialContextFor`).

| kind | source | notes |
|---|---|---|
| `payment_failed` | `payment_failed` | |
| `payment_received` | `payment_succeeded` | |
| `refund_failed` | `refund_failed` | |
| `payment_needs_attention` | `transaction_needs_attention` | |
| `late_payment_failure` | `transaction_late_failure` | |
| `possible_fraud` | `payment_failed` + fraud decline code | supersedes `payment_failed` |
| `dispute_opened` | `dispute_created` | |
| `dispute_evidence_due` | clock: `disputes.evidence_due_by` 72 h and 24 h ahead | |
| `dispute_closed` | `dispute_won`, `dispute_lost` | |
| `retries_exhausted` | `invoice_dunning_exhausted` | `invoice_not_paid` is not used: it repeats it |
| `invoice_overdue` | clock: `invoices.due_date` passed, amount due > 0 | port of team-alerts windows |
| `payment_method_unusable` | `payment_source_invalidated`, `payment_source_expired` | only with a live subscription |
| `new_revenue` | `invoice_generated` + first invoice | first-invoice rule of `invoicing/relations.ts` |
| `subscription_created` | `subscription_created` | |
| `subscription_cancelled` | `subscription_canceled` | |
| `cancellation_scheduled` | `subscription_cancel_scheduled` | |
| `subscription_reactivated` | `subscription_reactivated` | |
| `trial_ending` | `subscription_trial_ending` | |
| `customer_portal_change` | `subscription_changed`, `…_change_scheduled`, `…_paused`, `…_pause_scheduled`, `…_canceled`, `…_cancel_scheduled` with `source = 'portal'` | supersedes `subscription_cancelled`, `cancellation_scheduled` |
| `large_renewal` | clock: yearly-or-longer subscriptions, 30 d and 7 d before `current_period_end` | |
| `spend_limit_reached` | `spend_limit_reached` | |
| `usage_alert` | `usage_alert_triggered`, `usage_threshold_reached` | |
| `auto_topup_failed` | `credit_auto_topup_failed`, `…_hard_declined`, `…_retries_exhausted` | |
| `large_credit_grant` | direct: `credits/grant-limits.ts` | replaces `sendLargeGrantAlert` |
| `webhook_failing` | clock: `webhook_deliveries` reaching `failed` | port of team-alerts windows |
| `gateway_attention` | `payment_attempt_failed`, error family `merchant_account` | one per gateway per hour |

Timing values: `instant | summary | off`. Channels for a member: `push`, `email` (Instant only;
`summary` items go out with the summary). Destinations: `chat`, `email` (outside address).

## Data model (`db/schema/notifications.ts`, migration 0533; RLS `org_isolation` on every
table with `organization_id`)
- `notification_preferences` — (organization, user, business NULL = default) unique.
  `kinds jsonb`: `{ [kind]: { timing, push, email, above: { [CUR]: minor } } }`.
- `notification_settings_org` — (organization, user) unique: `business_filter jsonb`
  (`{ mode: "all" } | { mode: "selected", business_ids: uuid[] }`), `daily jsonb`
  (`{ enabled, channels: ["push","email"] }`), `weekly jsonb`, `send_empty bool`,
  `notice_dismissed_at`.
- `notification_settings` — (user) unique, no RLS org column (user-scoped; read through
  `systemDb` by the worker and through the session's user id by routes): `timezone`,
  `summary_hour int 0–23` (default 8), `weekly_day int 1–7` (default 1 = Monday),
  `quiet jsonb` (`{ enabled, from: 22, to: 7, disputes_through: true }`).
- `push_subscriptions` — (user) many: `endpoint` unique, `p256dh`, `auth`, `label`,
  `user_agent`, `last_success_at`, `last_failure_at`, `failure_count`, `created_at`.
- `notifications` — the bell and the summary items. `organization_id`, `business_id`,
  `user_id`, `kind`, `tone`, `timing` (`instant | summary`), `title`, `body`, `url`
  (dashboard path), `record` jsonb (type, public id), `amount_minor`, `currency`, `facts` jsonb,
  `event_id` (nullable), `group_key`, `group_count int default 1`, `group_totals jsonb`,
  `test bool`, `read_at`, `created_at`. Index (user, organization, created_at desc),
  partial (user, organization) where `read_at is null and timing = 'instant'`.
  Retention: 90 days (daily sweep).
- `notification_queue` — one row per matched event, clock fact or direct call, waiting for
  fan-out: `event_id` (unique when set), `dedupe_key` unique, `kinds text[]`, `payload jsonb`,
  `status pending | done | failed`, `attempts`, `next_attempt_at`, `last_error`.
- `notification_deliveries` — one per (target, channel) send: `channel push | email | chat |
  outside_email`, `user_id` or `destination_id`, `push_subscription_id`, `kind`, `business_id`,
  `notification_id`, `group_key`, `payload jsonb` (rendered), `status pending | sent | failed |
  skipped | held`, `attempts`, `next_attempt_at`, `last_error`, `dedupe_key` unique.
- `notification_groups` — open 5-minute windows: `key` unique while open (`target|business|kind`),
  `opened_at`, `count`, `totals jsonb` (`{ CUR: minor }`), `first_notification_ids uuid[]`,
  `items jsonb` (0535: the facts of the events after the first, up to 20, no email address;
  `count` and `totals` stay exact beyond 20), `closed_at`.
- `notification_destinations` — organization-level: `public_id` (`ndst_…`), `type chat |
  email`, `name`, `url_enc` (chat; `encryptSecret`), `url_hint` (last 6 chars), `email`,
  `status active | pending | not_working | removed` (email: `pending` until confirmed),
  `token_hash`, `token_expires_at`, `send_count`, `send_window_start`, `last_sent_at`,
  `business_filter jsonb`, `kinds jsonb` (`{ [kind]: { on: bool, above } }`), `daily bool`,
  `weekly bool`, `hide_names bool`, `failure_streak int`, `last_error`, `created_by_user_id`,
  `legacy_business_id` (deprecated team-alerts adapter).
- `notification_digests` — (organization, business, period `daily | weekly`, `period_start date`)
  unique: `parts jsonb`, `built_at`. 90-day retention.

## Pipeline
1. **Sink** (`sink.ts`, in the emit transaction, ADR-007). `candidateKinds(event)` from the
   catalogue (type, and `source` for portal). None → return. Else insert one
   `notification_queue` row (`event_id` unique, `on conflict do nothing`) and nudge
   `notification_queue_nudge` after commit through `public.app_nudge_notifications()` (SECURITY
   DEFINER, no arguments), as `integrations/outbox.ts` does.
2. **Fan-out** (`fanout.ts`, job `notification_queue_nudge`, also every minute). Claims pending
   queue rows (`for update skip locked`), loads the facts (`facts.ts`: the resource row by
   `resource_type`/`resource_id`, the customer name, plan, invoice number, amount, currency, the
   record URL), applies derived filters, then per recipient (members with a default row, and
   active destinations) `resolve()` → bell row, summary item, or deliveries. Grouping per
   (target, business, kind).
3. **Deliveries** (`deliver.ts`, job `notification_delivery_nudge`, every minute, queue
   `egress_notifications`): `push` via `web-push` (404/410 → delete subscription), `email` via
   `resolveMailer(null)`, `chat` (cardsV2 POST, HTTPS `chat.googleapis.com` only; 5 failures in a
   row → `not_working`, one email to owners and admins), `outside_email`. Backoff 1, 5, 30 min,
   2 h; 5 attempts.
4. **Clocks** (`clocks.ts`, cron `notification_clock` hourly): evidence due, overdue, large
   renewal, webhook failing — fixed windows so each fact enqueues once (`dedupe_key`). What one
   run finds for one (business, kind) is one message: a full card for one fact, a list for more.
5. **Groups** (`groups.ts`, cron every minute, event and direct kinds only): close windows older
   than 5 minutes. One later event → that event as a normal notification; more → one list per
   channel ("3 more invoices overdue · $2,385"); the list push uses the group tag so it replaces
   the first on the device.
6. **Quiet hours** (`quiet.ts`): a push for a member in quiet hours is `held` until the end;
   the release run collapses a member's held pushes into one push.
7. **Summaries** (`digest.ts`): builder (hourly) builds `notification_digests` for each live
   business whose local day (or week) has ended; sender (hourly) sends to members whose
   `summary_hour` is now in their timezone (parts per business, part 3 from their `summary`
   items), and to destinations at 08:00 in each business's timezone.

### Pipeline details (stage E2)
- **Files.** `enqueue.ts` (one queue insert + after-commit nudge; sink, clocks and direct
  callers), `sink.ts`, `recipients.ts` (members with a default row, role permissions incl. custom
  roles, destinations), `fanout.ts`, `groups.ts`, `channels.ts` (transports + classified sends),
  `deliver.ts`, `quiet.ts`, `clocks.ts`, `digest.ts` + `digest-text.ts`, `retention.ts`,
  `test-send.ts`.
- **Jobs** (`platform/jobs.ts`, role `clock`; retention role `reports`):
  `notification_queue_nudge` and `notification_groups_close` every minute on queue
  `notifications`; `notification_delivery_nudge` every minute on `egress_notifications` (also
  enqueued when a run made deliveries); `notification_clock` at :02 and `notification_digest` at
  :04 hourly with `fill=6h` (each covers the cron's hour); `notification_retention` 03:50 daily.
- **Dedupe keys.** Queue: `evt:<event id>`; the three automatic top-up failure types of one run
  share `auto_topup:<run id>` (one notification a run); clocks `clock:<kind>:<record>:<mark>`;
  direct `direct:large_credit_grant:<business>:<kind>:<reference>`. "Gateway needs attention"
  once per gateway per hour: a `done` marker row `gateway_attention:<business>:<gateway>:<hour>`.
  A clock run with several new facts for one (business, kind): each fact's key becomes a `done`
  marker row and one pending row `clock_run:<first new fact's key>` carries `payload.items`.
  Deliveries: `<queue id>:<kind>:u:<user>:<subscription>:push`, `…:u:<user>:email`,
  `…:d:<destination>:chat|outside_email`; group close `grp:<group>:more:<first delivery>`;
  summaries `sum:<user>:<org>:<period>:<member local date>:email|push:<sub>` and
  `sum:d:<destination>:<digest id>`.
- **Delivery payload** (`DeliveryPayload` in `groups.ts`): the rendered `push` / `mail` /
  `chat`, plus `facts`, `items` (a list), render `opts`, `count`, `tone`, `group_id` (first send
  of a window) or `more` (sent when a window closed), and `summary`. Bell rows keep their render
  options in `facts._opts`; a list's bell row keeps its items in `facts._items`.
- **Grouping** (event and direct kinds). Key `u:<user>|<business>|<kind>` or `d:<destination>|…`.
  An event inside an open window counts, is kept in `items`, re-renders the first bell row
  ("12 payments failed", the first included, marked unread) and sends nothing. Closing sends one
  message per first delivery: exactly one later event goes out as a normal notification with its
  own push tag; two or more as a list (title with the total of the later events only, up to 5
  rows, "and N more") with the first's tag (`renotify: true`). A first push still held keeps the
  closing push held.
- **Clock runs.** Clock kinds never join a group. A recipient gets the items of the run that pass
  their settings (amount limits apply per item): one → a full card, more → one list ("2 invoices
  overdue · $1,195", total of all) and one bell row (`group_count` = items). Summary timing keeps
  one summary item per fact.
- **Quiet hours.** Held pushes are released by the delivery drain; more than one held push for
  a device becomes one ("While quiet hours were on" · "3 payments failed, 1 dispute opened.",
  url `/notifications`), the rest `skipped` `collapsed_after_quiet_hours`.
- **Channels.** No VAPID keys → push deliveries `skipped` `push_not_configured`; 404/410 deletes
  the device. Chat: 2xx sent; 429/5xx retry; other 4xx final; every failure adds to
  `failure_streak`, the fifth sets `not_working` and mails owners and admins once (link
  `/settings/notifications`); a success resets it. Email and outside email through
  `resolveMailer(null)`; outside email re-checks the destination is `active` at send.
  `setNotificationTransports()` replaces push/chat/email in the verify suite.
- **Clocks.** Evidence: `needs_response` disputes due within 72 h (mark `72h`) or 24 h (`24h`).
  Overdue: due date 1 to 25 hours back (hour of slack, a day of reach for a missed run), amount
  still due > 0 (`invoiceOutstanding`). Large renewal: active, not cancel-scheduled, yearly or
  ≥ 12 months, period end within 30 d (`30d`) or 7 d (`7d`); expected amount = the last
  invoice's total. Webhook failing: the team-alerts window (last attempt 1 to 2 hours back).
- **Summaries.** `notification_digests.parts` is `DigestParts` (`digest.ts`): `business`,
  `period`, `start`/`end` (local dates, end exclusive), `needs_action[]` (kind, count, totals,
  url), `figures` (collected, failed, refunded with `previous`; weekly `recovered`; new and
  cancelled subscriptions with reasons; MRR change and by reason, weekly start and end levels),
  `coming_up` (renewals, trials ending, invoices due, cards expiring), `active`. Member copies
  filter needs-action and figures by permission (`partForMember`). The member's summary is one
  bell row (kind `daily_summary` / `weekly_summary`, `business_id` NULL, `facts.summaries` lists
  every business's `nsum_` id, url `/notifications/summaries/<first nsum id>`) plus email/push on
  the chosen channels; push held in quiet hours, email not. Destinations get parts 1, 2, 4 per
  business at 08:00 business time, only when the digest is `active`.
- **Retention.** Bell rows and digests 90 days; settled queue rows and deliveries 30 days;
  closed groups 1 day.

## Facts (`facts.ts`)
`loadFacts(tx, {organizationId, businessId, kind, event?, payload?})` → `{ facts, business:
{id, publicId, name, timezone, test}, refs }` or null (no business). The record is the event's
`resource_type`/`resource_id`, or `payload.record` for clock and direct kinds; `payload.facts`
win over loaded facts. Customer name = `accountHolderName` (`customers/names.ts`), not the
deprecated `name` column. `passesDerivedCheck(tx, kind, bundle, source)` runs the catalogue's
`derived` check (`isFraudDecline`, `isFirstInvoice`, `hasLiveSubscription`,
`isMerchantAccountError`).

## Text (`text.ts`, pure, ASD-STE100)
One source for bell title/body, push payload, email subject and body, and the Google Chat card.
Title "Payment failed: ₹4,999"; body "Meera Iyer · Studio Pro, monthly. Card declined. We try
again on 18 Nov." Amounts via the money formatter with currency; dates in the business
timezone. `hide_names` removes customer name and email, also from list rows. Grouped bell row:
"12 payments failed". `renderNotification(kind, facts, { timezone, hideNames, showBusiness,
grouped, baseUrl, tag, audience, exceptionBusinessName, now })`; `baseUrl` is
`config.DASHBOARD_BASE_URL`, passed in so the module stays pure. Lists:
`renderList(kind, items, opts, { count, totals, more })` — title "3 more invoices overdue ·
$2,385" (`more`) or "2 invoices overdue · $1,195"; rows "<identifier> · <amount> · <customer>"
(identifier: the kind's `item`, else invoice number, plan, reason, or the title); email and
chat show 5 rows then "and N more", push shows 2. `renderItems` picks the full card for one item.

## Push payload (contract with `dashboard/public/sw.js`)
`{ title, body, url, tag?, renotify?, badge_count? }` — `url` is a dashboard path.

## Service (`service.ts`)
Route functions take the session's organization: `notification_settings` and
`push_subscriptions` have `member_isolation` RLS, which needs an organization scope.
`savePushSubscription` uses `systemDb` (an endpoint moves to whoever subscribed last);
`settingsForUsers` is the worker's cross-organization read. Outside addresses confirm by a
`ndc_…` token at `/notifications/confirm/s/<token>`, with the team-alerts limits (10 minutes
apart, 3 a day per destination, 10 a day per address). Legacy adapter: an overdue currency
with no threshold now means every amount (team alerts sent nothing for it).

## API (session only, `requireUser`; owners/admins for destinations)
- `GET /auth/notifications/preferences` → `{ set_up, catalogue: [{kind, group, label, help,
  tone, amount, visible}], default: {kind: pref}, exceptions: [{business, kinds}],
  business_filter, daily, weekly, send_empty, currencies: [..], businesses: [{id, name}] }`;
  `PUT` same shape (minus catalogue). First PUT seeds defaults for kinds not given.
- `GET|PUT /auth/notifications/settings` → `{ timezone, summary_hour, weekly_day, quiet }`.
- `GET /auth/notifications/push/config` → `{ public_key | null }`.
- `GET|POST /auth/notifications/push/subscriptions`, `DELETE …/:id`,
  `POST …/:id/test`.
- `GET /auth/notifications?unread=1&business=&cursor=` (instant rows, newest first),
  `GET /auth/notifications/unread_count`, `POST /auth/notifications/:id/read`,
  `POST /auth/notifications/read_all` (`{ business? }`).
- `GET /auth/notifications/summaries/:id`.
- `GET|POST /auth/notification_destinations`, `PATCH|DELETE …/:id`, `POST …/:id/test`,
  `POST …/:id/resend` (owners and admins).
- Public `POST /auth/notification_destinations/confirm` (`{ token }`).
- Deprecated (team alerts, removed later): `team_alerts_config` on `/v1/businesses/:biz`,
  `GET /v1/businesses/:biz/team_alert_recipients`, `POST …/resend` — adapters over
  `notification_destinations` with `legacy_business_id`.

## Invariants & gotchas
- The sink must stay cheap: a type lookup, and one insert only for catalogue types.
- Every delivery has a `dedupe_key`; a retried job never sends twice.
- Bell rows are per member; RLS isolates the organization and every read filters `user_id`.
- Webhook URLs are secrets: stored encrypted, shown as `…` + last 6 characters.

## Changelog
- **2026-11-16 (0533)** — Module created. Replaces team alerts. Catalogue, resolve, text,
  facts and the settings/bell/destinations service.
- **2026-11-16** — Delivery pipeline: sink, fan-out, grouping, quiet hours, push/email/Google
  Chat/outside email, clocks, daily and weekly summaries, retention, test sends, six jobs.
  `credits/grant-limits.ts` queues `large_credit_grant` instead of the team-alerts mail.
  `EventSource` gains `portal`. Suite: `verify:notifications`.
- **2026-11-16 (0534)** — `src/modules/team-alerts/` removed with its `team_alerts_hourly` and
  `team_alert_send` jobs and `verify:team-alerts`. The old config parser moved to
  `legacy-team-alerts.ts` (deprecated API adapter). `notice.ts`: one-time job
  `notifications_team_alerts_notice` (enqueued by 0534) emails owners and admins of each
  organization where a business had a team alert on; a `done` queue row
  `notice:team_alerts_notice:<org>:<user>` makes it send once.
- **2026-11-16 (0535)** — Grouped notifications list their events. `notification_groups.items`
  keeps the later events of a window (up to 20). Closing with one later event sends it as a normal
  notification; with more, a list of up to 5 rows with the later events' own total. The "Count",
  "Total" and "First" rows are gone. A clock run sends one message per (business, kind): a full
  card, or a list (`clock_run:` queue row with `payload.items`), never "first now, rest later".
- **2026-11-21** — `source = 'portal'` now covers every portal route. The `customer_portal_change` kind is unchanged: it is a candidate only for its six subscription event types, so a card or billing-details change still sends nothing.
