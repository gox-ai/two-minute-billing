# dunning-policies

Named dunning configurations (0386). A business keeps several and assigns one per customer
(`customers.dunning_policy_id`); a customer with none runs the business config, exactly as
before policies existed.

## Model

`dunning_policies` (`db/schema/dunning-policies.ts`), business-scoped, RLS org-isolated:
`public_id` (`dpol_…`), `name`, `code` (unique per business among live policies),
`description`, `config` (jsonb), `archived_at`, `resource_version`.

`config` holds the **full set** of per-invoice dunning keys, resolved on write
(`dunningPolicyConfigJson`), so what a customer runs is readable from one row:
`enabled, mode, retries, final_action, dunning_period_days, skip_retries_for_hard_failures,
park_hard_declines, adaptive_timing, minimum_amounts, dun_offline_invoices,
dun_one_time_invoices, dun_trial_and_future_subscriptions` (`DUNNING_POLICY_KEYS`).
Business-wide keys stay on the business and the API refuses them in a policy:
`collect_on_payment_method_update`, `require_successful_charge_on_reactivation`,
`no_payment_method_at_renewal`, `dunning_retry_days`.

## Resolution

`customer.dunning_excluded` (held, beats everything) → the customer's policy → the business
config. One loader, `loadEffectiveDunningConfig(tx, { businessId, customerId })`
(`effective.ts`), used by every dunning call site; `resolveDunningConfig(biz, policyConfig?)`
overlays the policy's keys on the business row. The SQL scan filter `dunningNotHeldSql`
reads `minimum_amounts` from `coalesce(policy.config, business.dunning_config)`.

Switching a customer's policy mid-dunning rewrites nothing: the invoice keeps its
`next_attempt_at`; the next failure schedules from the new policy's retries (an
`attempt_count` past the new list exhausts at that failure) and exhaustion applies the
final action of the policy current at that moment.

## Rules

- Archive is refused while a customer is assigned (the message names the count). Archived
  policies cannot be assigned. No hard delete.
- Same permission as `PATCH business.dunning_config` (`admin`).

## API

```
GET|POST /v1/businesses/:biz/dunning_policies
GET|PATCH /v1/businesses/:biz/dunning_policies/:dpol
POST /v1/businesses/:biz/dunning_policies/:dpol/archive
customers: create/update accept `dunning_policy` (dpol_… | null); reads return it
```
Events: `dunning_policy_created|updated|archived`. Audit: `dunning_policy.create|update|archive`.

Gate: `verify:dunning-policies` (resolution order, policy minimum in the scan filter,
mid-dunning switch, archive rules, API, RLS, and a static check that no call site
resolves the business config alone).

## Changelog

- **2026-10-25** — Module created (0386): named policies, per-customer assignment, the
  customer-aware loader at every dunning call site.
- **2026-11-03 (settings slice F)** — Plan policies: `businesses.dunning_config.plan_policies` {plan id → dpol}. `loadEffectiveDunningConfig` takes `subscriptionId`; order is customer policy, plan policy, business (`planPolicyConfigSql`, also in `dunningNotHeldSql`). PATCH business refuses an unknown plan or a missing/archived policy (`planPoliciesViolation`); archive is refused while a plan uses the policy (`plansOn`). `retries_by_method` and `adaptive_cadence` are policy keys. Gate: `verify:settings-dunning-p2`.
- **2026-11-03 (slice F review)** — `planPoliciesViolation` validates only new or changed entries and drops stale ones; `planPolicyConfigSql` skips the join when no map is stored; a transfer keeps the destination's `plan_policies`. `priorFailedMethods` feeds the instrument-switch rule.
