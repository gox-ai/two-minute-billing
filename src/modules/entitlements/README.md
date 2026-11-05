# entitlements — features + plan/subscription grants + checks

> Source: `src/modules/entitlements/` · Routes: `src/api/entitlement-routes.ts` · Schema: `db/schema/entitlements.ts`
> Layer: catalog (see docs/architecture/architecture.json)

## Purpose
Models product capabilities: features (switch / quota / meter), grants at the plan level and per
subscription, and the runtime check that answers "is this subscription entitled to feature X (and how
much)?" — the gate a customer's app calls to enforce plan limits.

## Responsibilities
- Feature CRUD (by key).
- Set entitlements on a plan (default grant) and override per subscription.
- Compute effective entitlements (plan grant + subscription override) and check a single feature.

## Data model
`db/schema/entitlements.ts` — `features` (key, type switch/quota/meter) + plan-entitlement and
subscription-entitlement grant rows. Effective value = subscription override falling back to plan grant.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createFeature` / `listFeatures` / `getFeatureByKey` | feature registry |
| `setPlanEntitlement` | default grant on a plan |
| `setSubscriptionEntitlement` | per-subscription override |
| `effectiveEntitlements` | resolved grants for a subscription |
| `checkEntitlement` | check one feature (switch on / quota remaining) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/features` | list features |
| `GET /v1/businesses/:biz/subscriptions/:sub/entitlements` | effective grants |
| `GET /v1/businesses/:biz/subscriptions/:sub/entitlements/:key/check` | runtime check |

## Events emitted
All in the same transaction as the write (outbox). Payload keys nest under the resource type.
| Event | When | Payload |
|---|---|---|
| `feature_created` | `createFeature` | the feature (`id`, `key`, `name`, `type`, `unit`, `description`, `active`) |
| `feature_updated` | `updateFeature` changed a field; `setFeatureActive(true)` on an archived feature | the feature |
| `feature_archived` | `setFeatureActive(false)` on an active feature (`POST …/archive` and `DELETE`) | the feature |
| `plan_entitlement_set` | `setPlanEntitlement` created a grant or changed its value | `id`, `product`, `feature` (key), `value`, `previous_value` (null when new) |
| `subscription_entitlement_set` | `setSubscriptionEntitlement` created an override or changed its value | `id`, `subscription`, `feature` (key), `value`, `previous_value` |

A write that changes nothing (same value, an empty edit, archiving an archived feature) emits nothing.

## Dependencies
- **Upstream (calls into):** events (`emitEvent`, for the change events above).
- **Downstream (called by):** none (checked directly via API by customer apps).

## Invariants & gotchas
- Effective grant = subscription override ?? plan grant.
- Feature `PATCH`/`DELETE` is a known backlog item (P12) — currently create + read focused.

## Changelog
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-30** — **Feature lifecycle.** `GET/PATCH /features/:feature` (id or key; key and type are fixed), `POST …/archive`, `POST …/reactivate`, `DELETE` = archive. An archived feature grants nothing — it leaves effective entitlements, checks answer `feature_archived`, and it cannot be granted — while its grants are kept for reactivation. Every feature is active today, so no current result changes.
- **2026-09-30** — `listPlanEntitlements` + `GET /v1/businesses/:biz/products/:prod/entitlements`: a product's own grants (feature key/name/type/unit, value), business-scoped, 404 for another business's product. Covered by `verify:entitlements`.
- **2026-10-24** — **Change events.** `feature_created` / `feature_updated` / `feature_archived` and `plan_entitlement_set` / `subscription_entitlement_set` (with `previous_value`), emitted in the write's transaction so apps that cache entitlements get a change signal. DELETE archives, so it sends `feature_archived`, not a delete. No-op writes emit nothing. Covered by `verify:entitlements`.
- **2026-11-01 (0467, Tier 3 PR 2)** — A meter feature can link a meter (`meter` on create/update/object). `checkEntitlement` then counts this period's usage: entitled when used + required ≤ limit, and returns `used`. A meter feature with no meter answers as before. Gate: `verify:usage-access`.
- **2026-11-04 (G3b, 0497)** — `reset` on plan and subscription entitlements (meter features; every interval, the hour included; null = the next invoice's window). An override's reset beats the plan's. `checkEntitlement` counts the reset window (`credits/allowance.ts`) and returns `resets_at`; effective entitlements carry `reset`. Gate: `verify:plan-credit-resets` §9.
- **2026-11-04 (G3b gaps)** — `reset: { same_as_credits: true }` on plan and subscription entitlements: the allowance renews with the subscription's own plan credits, resolved at read time (`credits/allowance.ts`); `effectiveEntitlements` returns the resolved reset. The plan route refuses the link when the plan has no active price that grants credits each period, or when its active prices renew on different schedules; the subscription route refuses it when no item grants credits each period. Gate: `verify:plan-credit-resets` §10.
- **2026-11-04 (G3b allowance pause)** — `checkEntitlement` counts pause shifts. A linked allowance counts its credits item's actual window (shift included, both anchors, the short window after a calendar shift), so `resets_at` is the credits' next window start and `used` is the usage in that window. **Decision (user, 2026-11-04):** an allowance with its own reset follows the business's `plan_credits.on_pause`: `shift` moves its windows by the paused time (the credits' rules); `skip` and `keep_granting` leave them unchanged. `effectiveEntitlements` is unchanged. Gate: `verify:plan-credit-resets` §11.
- **2026-11-04 (G3b pause follow-ups)** — `checkEntitlement` reports the same windows as the credits on a month-end anchor after a pause (boundaries move by the paused time). On a subscription resumed before pause windows were stored, the window open at that pause is rebuilt from the pause and resume events (`credits/credit-clock.ts` `loadLegacyPauses`). Gate: `verify:plan-credit-resets` §11.
