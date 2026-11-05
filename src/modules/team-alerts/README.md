# team-alerts — mail to the merchant's own staff

> Source: `src/modules/team-alerts/` · Config: `businesses.team_alerts_config` (0489) · No routes of
> its own (PATCH `/v1/businesses/:biz` key `team_alerts_config`). Layer: billing.

## Purpose
Opt-in alerts for a business's team, not its customers:
- **Overdue** — an unpaid invoice passes its due date with an amount due at or above the
  per-currency limit.
- **Webhook failures** — outbound deliveries that reached `failed` (retries exhausted or URL refused).
- **Daily summary** — at 08:00 business time, the day before: payments collected, payments that
  failed (both from `transactions`, `type='payment'`, by `finalised_at`), plus two snapshots taken
  at send time: invoices in dunning and cards expiring this month or next month.

## Config (`config.ts`)
`{ recipients[], overdue: { enabled, thresholds: { CUR: minor } }, webhook_failures: { enabled },
daily_digest: { enabled } }`. `resolveTeamAlertsConfig` maps NULL / malformed to everything off
(the behaviour before 0489). An alert sends only when its toggle is on AND there is a recipient; an
overdue alert also needs at least one threshold, and a currency with none is never alerted.
Default is off for every business, existing and new — no `initial*Config` entry.

## How it runs
- Cron `team_alerts_hourly` (`0 * * * *`, queue `team_alerts`, `max=1`, `fill=6h`, no jobKey) →
  `runTeamAlertsFanout` (`fanout.ts`, `systemDb`: it scans every business) → one `team_alert_send`
  job per (business, kind), jobKey `team_alert:<kind>:<biz>:<hour>`, 6 attempts.
- `sendTeamAlert` re-reads the config (turning an alert off stops queued jobs), builds the mail
  under the tenant and sends ONE message: first recipient in To, the rest in CC.
- Transport is the deployment mailer (`resolveMailer(null)`), like operator invites: this is mail
  to the merchant's staff, and must arrive even with no business SMTP/SES configured.

## Invariants & gotchas
- **No sent-ledger: windows partition the facts.** Overdue covers due dates in `[hour−2h, hour−1h)`
  (an hour of slack lets the due pass charge an auto-collect invoice first); webhooks cover
  `last_attempt_at` in `[hour−2h, hour−1h)` (the attempt's `failed` status commits after
  `last_attempt_at`, up to ~90 s later); the digest fires only in the hour whose local time is
  08:xx, which happens once per local day in every zone. Each fact falls in one window, and
  graphile cron fires each hour once, so each invoice/delivery/day is reported once. A send that
  succeeded but whose job did not complete can repeat once (at-least-once).
- `fill=6h` re-runs hours missed while the worker was down; each run uses its own `_cron.ts`.
- No jobKey on the cron line on purpose: replace mode would overwrite a pending previous hour.
- An invoice whose due date was already past when it was created (an import, a backdated invoice)
  never crosses a window and gets no overdue alert.
- Time-travelled businesses are excluded from the fan-out.

## Changelog
- **2026-11-03 (0489)** — Module created: overdue, webhook-failure and daily-summary alerts, opt-in
  per business with up to 10 recipients. Gate: `verify:team-alerts`.
- **2026-11-03 (review)** — Webhook window lags one hour, as the overdue window does: a delivery whose
  last attempt started just before the hour committed `failed` after the run read it and was never
  reported. Test twins no longer copy `team_alerts_config`, and the fan-out skips test businesses.
  Partial index `webhook_deliveries_failed_biz_idx` serves `collectWebhookFailures`.
- **2026-11-03 (0495, security)** — Recipients outside the organization confirm by email before they get alerts (`recipients.ts`, table `team_alert_recipients`): one mail with a single-use link that expires in 7 days; members skip it; a removed address is marked `removed` and must confirm again. Sends are limited per address (10 minutes apart, 3 a day per business, 10 a day across businesses). `GET /v1/businesses/:biz/team_alert_recipients`, `POST …/resend`, public `POST /auth/team_alerts/confirm` (dashboard page `/team-alerts/confirm`). New opt-in alert `large_grants`: sent at the time of a free credit grant above `credit_config.grant_limits`. Gates: `verify:team-alerts`, `verify:grant-limits`.
