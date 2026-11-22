---
name: two-minute-billing-pricing
description: Decide what to charge and put it in Two Minute Billing as code — find the value metric, pick the price model (flat, per seat, tiered, volume, package, usage, AI tokens, prepaid credits, minimum commitment, one-time charges), map plan features to entitlements, and write a re-runnable catalog script for test mode. Use when designing or changing plans, prices, one-time products, trials, add-ons, coupons, tax regions, business billing settings or feature limits for an app billed with Two Minute Billing.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers/concepts/catalog
---

# Pricing and the catalog

The `two-minute-billing` skill's rules hold here: test key only, keys never in the chat, and
`tmb doctor` (or `preflight.mjs`) before the first write.

## 1. Find the value metric

Never invent a price. Ask the user, in one message, only what the code and their pricing page do
not already say:

- Who pays: a person, a team, a company?
- What grows with the value they get: seats, projects, API calls, GB stored, tokens, minutes,
  outcomes (a report made, a document signed)?
- The prices, currency and interval they want — or "suggest something", and then propose and wait.
- What each plan unlocks (features, limits).

Then write back a short **billing model** and wait for a yes before any code:

```text
Plans:     Starter $19/mo, Pro $49/mo (yearly: 2 months free)
Charged:   per seat on Pro, first 3 included
Usage:     none
Features:  sso (Pro only), projects: 3 / unlimited
Trial:     14 days on Pro, card required
Currency:  USD only
```

## 2. Pick the model

| They describe | Model | Key fields |
|---|---|---|
| A fixed price per period | `flat` | `amount_minor` (integer minor units: `4900` = $49.00) |
| Per seat or per unit bought | `per_unit` | `amount_minor` per unit; quantity on the subscription item; `free_quantity` for included seats |
| Cheaper per unit in bands, each band at its own rate | `tiered` | `tiers`: `[{ upToMinor, unitAmountMinor, flatAmountMinor }]`, last `upToMinor: null` |
| One rate for the whole quantity, by band | `volume` | `tiers` |
| One flat amount for the band the quantity falls in | `stairstep` | `tiers` with `flatAmountMinor` |
| Sold in blocks ("per 1,000 emails") | `package` | `package_size`, `amount_minor` per package |
| A share of a value ("2.5% of volume") | `percentage`, `graduated_percentage` | `percentage_bps` (250 = 2.5%), or `tiers` with `rateBps` |
| Measured use: requests, GB, minutes | `usage` on a meter | see `two-minute-billing-usage` |
| AI tokens by model | `usage` on an `ai_tokens` meter, or the model price list plus a markup | see `two-minute-billing-usage` |
| Pay first, spend down | prepaid credits | see `two-minute-billing-usage` |
| Base fee plus overage | a `flat` price and a `usage` price on one plan | both on one subscription |
| A minimum spend per period | `minimum_amount_minor` on the price, or `commitment_amount_minor` for a commitment with a true-up | on the plan price |
| Paid once: an order, a download, a setup fee, a credit pack | a product of `kind: "charge"` with a `type: "one_time"` price (any model above that needs no period) | sold with checkout `mode: "purchase"`, see `two-minute-billing-integrate` and https://twominutebilling.com/help/developers/recipes/one-time-purchases.md |

Field details per model: https://twominutebilling.com/help/developers/concepts/catalog.md

Watch for: a currency per price (a customer pays in one currency; one business can hold prices
in several currencies, so a second market needs no second business); yearly prices as their own
price, not a discount; a trial on the price (`trial_period` + `trial_period_unit`) or on one
subscription (`trial_days`), see https://twominutebilling.com/help/developers/recipes/trials.md

A store that sells only one-time items skips plans, trials and entitlements: its billing model is
the list of products, their prices per currency, and how tax applies.

## Tax

Each price says whether tax is added on top or included: `tax_behavior: "exclusive"` or
`"inclusive"`. Write down which one the app's current prices mean (look at how the code or the
invoices add tax today) and confirm it with the user.

A price only carries tax where the business is set up for it: a tax region for the country (for
example India GST with CGST, SGST and IGST, or EU VAT), and the seller's registration number and
address on the business. Without them, an "exclusive" price bills no tax at all. Ask the user for
their registration and home state or country, then put the region in `tax_regions` and the
registration number and address in `settings` of `billing.catalog.json` (section 4), after a yes.
Recipes: https://twominutebilling.com/help/developers/recipes/india-gst-invoices.md
and https://twominutebilling.com/help/guides/vat-for-saas-in-europe.md. An HSN or SAC code, where
needed, goes on the product as `tax_code`.

Compare the engine's total with what the app charges today, and show both to the user. Tax on a
tax-exclusive price is exact to the minor unit: ₹99 plus 18% GST is ₹116.82, not the ₹117 an app
that rounds to the rupee charges now. Ask which one they want. For a round total, make the price
tax-inclusive (`"inclusive"`, with the tax-included amount, for example ₹117) instead.

## 3. Map features to entitlements

Gate the app on feature keys, never on plan ids. Each plan feature becomes:

| Feature type | Use for | Example |
|---|---|---|
| `switch` | on or off | `sso` |
| `quota` | a ceiling | `projects: 10`, `seats: 25` |
| `meter` | an allowance used up over a window | `exports: 100` a month |

The app asks `GET /v1/businesses/{biz}/subscriptions/{sub}/entitlements/{key}/check` at the point
of the action (see `two-minute-billing-integrate`).

## 4. Write the catalog script

Put the catalog in the user's repository as code, so a change is a reviewed diff: write
`billing.catalog.json` in the package that calls the billing API, next to the env file the
scripts load (the project root of a single app; in a monorepo, the app package, not the repo
root). Shape: `references/billing.catalog.example.json`, which shows a plan with a recurring
price, a one-time `charge` product, a 100%-off coupon and two settings. Prepaid credits add a `credit_units` list
(`id`, `name`, `currency`, `minor_per_unit`, `decimals`): the script creates the units before
the prices whose `grants_credit.unit` names them. For credits with no money value (1 image = 1
credit), write `"minor_per_unit": null`; leaving the field out is an error. A meter priced in such
a unit takes a `credit_cost`: `{ "unit": "token", "credits_per_unit": "2.5", "overrides": [{
"product": "pro", "credits_per_unit": "2" }] }`. A meter in the file without `credit_cost` has
its stored credit cost planned for removal. The script stays in
this skill and needs no install step: plain Node, no dependencies, so it works in any project.
`tmb push` runs the same script, so the CLI is optional. It prints a **plan of changes** first,
and changes nothing unless it gets `--apply`.

The same file holds the rest of the business's billing setup, so the user's business settings
live in the repository too. Do not set these by hand with `PATCH` calls; put them in the file:

- `tax_regions`: one per country, found by `country`. `regime` (`gst`, `vat`, `sales_tax`,
  `flat`), `price_type`, `home_state_code` (the seller's state, for GST place of supply),
  `registration_number`, and `components`: `{ name, rate_bps, applies_to }` (`rate_bps` 900 =
  9%; `applies_to` is `intra` or `inter` for GST, else `both`). The file's `components` replace
  the region's default rates.
- `coupons`: found by `code`. The fields of `POST /v1/businesses/{biz}/coupons`: `kind`
  (`percentage` with `percent_off_bps`, 10000 = 100%, or `fixed_amount` with `amount_off_minor`
  and `currency`), `duration_type` (`once`, `forever`, `repeating` with `duration_in_periods`),
  `apply_on`, `item_constraints`, `max_redemptions`, `max_redemptions_per_customer`,
  `per_customer_limit_by`, `redeem_by`, `valid_from`, `name`, `invoice_name`, `metadata`.
- `coupon_sets`: single-use codes for one coupon, found by `id`: `coupon`, `name`, `count`.
  A larger `count` adds codes.
- `settings`: keys of `PATCH /v1/businesses/{biz}`. `billing_rules_config` (for example
  `zero_invoice_paid_event`, `mid_term_coupons`, `customer_coupons`, `plan_credits.on_upgrade`)
  `credit_config` (`blocking_enabled`, `on_exhausted_default`, `in_flight_share_bps`, …) and
  `dunning_config` (`retries`, `dun_one_time_invoices`, `final_action`, …) change only the keys
  the file lists. Also `allow_customer_coupons`,
  `max_customer_coupon_codes`, `tax_registration_number`, `address`, `invoice_issuer`,
  `default_tax_code`, `default_tax_behavior`, `timezone`, `default_due_days`,
  `default_invoice_notes`, `support_email`. A key the file leaves out stays as it is; the script
  refuses a key it does not manage.

An India store with GST, a 100%-off launch code, and the settings that let a buyer type it and
send `invoice_paid` for the free order:

```json
{
  "tax_regions": [
    {
      "country": "IN",
      "regime": "gst",
      "home_state_code": "KA",
      "registration_number": "29AAAAA0000A1Z5",
      "components": [
        { "name": "CGST", "rate_bps": 900, "applies_to": "intra" },
        { "name": "SGST", "rate_bps": 900, "applies_to": "intra" },
        { "name": "IGST", "rate_bps": 1800, "applies_to": "inter" }
      ]
    }
  ],
  "coupons": [
    {
      "code": "LAUNCH100",
      "name": "Launch",
      "kind": "percentage",
      "percent_off_bps": 10000,
      "duration_type": "once",
      "max_redemptions": 100
    }
  ],
  "settings": {
    "allow_customer_coupons": true,
    "tax_registration_number": "29AAAAA0000A1Z5",
    "address": {
      "line1": "<street>",
      "city": "<city>",
      "state_code": "KA",
      "postal_code": "<PIN>",
      "country": "IN"
    },
    "billing_rules_config": { "zero_invoice_paid_event": "one_off" }
  }
}
```

Rules the script follows, and you must keep:

- Readable ids you set (`pro`, `pro-monthly-usd`). The same ids work in test and live mode, so going
  live is a change of key and business id, not of code.
- Ids are immutable and a duplicate answers `409`. The script lists first and creates only what is
  missing.
- The script compares every price field the file sets, `grants_credit` (in full), the trial and
  the rate card included. A field the price API can change (amount, trial, credits, rates, tax
  behavior, names) is planned as a `~ price …` edit: it applies to **new** subscriptions only, and
  live subscriptions keep their terms. A field it cannot change (product, type, model, currency,
  interval, meter) is a conflict. To move existing customers to new terms, create a new price id
  and move them to it.
- A field that means "none" when it is absent (a trial, `grants_credit`, `rates`, billing cycles,
  a minimum) is planned for removal when the file drops it. Read every `~` line with the user.
- A credit unit's `currency`, `minor_per_unit` and `decimals` cannot change once a grant used the
  unit: a conflict. Its name, `overage_minor_per_unit`, `overdraft_limit` and
  `negative_balance_at_reset` can always change (the last three: a unit with no money value only);
  a field left out of the file is left as it is, and `overage_minor_per_unit: null` clears the
  overage price. A credit amount in a plan line is shown in whole units, with the stored amount
  after it ("credits 500 credit (amount 5000)" at 1 decimal).
- A coupon's discount (`kind`, the amount or percent, `currency`, `duration_type`, `apply_on`)
  can change only until its first redemption; after that it is a conflict, and its scope
  (`item_constraints`) can only grow. Its name, invoice name, dates and redemption caps can always
  change. Make a new code for a new discount.
- The script creates and changes, and never deletes. `"archived": true` on a coupon, coupon set
  or tax region archives it (a coupon and a tax region come back with `"archived": false`; an
  archived set cannot). A coupon set's `coupon` cannot change, and its `count` cannot go down.
- Run it with a test key only. Show the plan output, wait for a yes, then run with `--apply`.

```bash
tmb push billing.catalog.json --env-file <env file>           # plan
tmb push billing.catalog.json --env-file <env file> --apply   # after a yes
```

Without the CLI (see the `two-minute-billing` skill), run the script itself:

```bash
node --env-file=<env file> <this skill>/scripts/catalog.mjs billing.catalog.json           # plan
node --env-file=<env file> <this skill>/scripts/catalog.mjs billing.catalog.json --apply   # after a yes
```

Both exit the same way. Exit 0: planned, applied or nothing to change · 1: bad input or a refused
request · 2: a conflict (a field the API cannot change), nothing was written · 3: not a test key.

Each `+ price` line shows the terms to review with the user: amount and period, the trial, the
meter and usage rate, and the credits it grants (amount, unit, kind, reset). A `+ coupon` line
shows the discount and duration, a `+ tax region` line each component and its rate, and each
`~ setting` line the stored value and the new one (`old → new`).

The business is found by its exact name among the key's test businesses. To use one that exists,
put its exact name in `business.name`: a name that matches none (a typo too) is a new business,
and the plan says so in a `! NEW BUSINESS` line with the names that exist. On a new business,
`--apply` creates the business and then the catalog under it, and prints the business id to put
in `TMBILLING_BUSINESS_ID`.

Done when the second `--apply` run reports nothing to change. The run compares every field the
file sets, so "nothing to change" means the stored catalog matches the file.
