---
title: Know the card before you charge it
date: 2026-09-14
type: Improvement
tags: Payments, Dashboard, India
summary: Every payment method now shows where it was issued, who issued it and what it can do — the same way on the customer and the subscription.
---

A saved payment method now tells you everything the gateway knows about it, and it tells you the
same story wherever you open it.

- **Where the card was issued, and by whom.** The issuing country and the issuing bank sit on the
  instrument. For Indian-issued cards that is what decides whether a renewal has to ask the payer
  to authenticate, so it is worth seeing before the renewal runs rather than after.
- **What the instrument can actually do.** Funding type (credit, debit, prepaid), consumer or
  business, 3D Secure support, international use, and whether it can be debited off-session at
  all. A card that cannot take recurring debits says so next to the mandate riding on it.
- **A fingerprint, where the gateway provides one.** The same underlying card can be saved twice
  under different tokens; the fingerprint is how you tell that a backup is really a second card.

## One card, both screens

The payment method on a customer and the payment method on a subscription are drawn by the same
component now, so they carry the same rows in the same order and read the same at a glance.

- **A subscription that charges its own card says so in words.** The line under the heading tells
  you whether the instrument is set on this subscription or is the customer's primary, and the
  badge beside it keeps its plain meaning: the customer's primary card.
- **UPI Autopay looks like UPI.** A mandate with no card brand now carries its own mark instead of
  a generic card.
- **The detail grid follows the space it is given**, so a long gateway reference stays readable in
  a narrow column instead of breaking across half a dozen lines.

## Two roles, one word for each

A saved card had three words — primary, backup and default — for two roles, and which word you saw
depended on which screen you were on. There are two roles, and they are now called the same thing
everywhere: in your dashboard, in your customer's billing portal, at checkout, and in the API.

- **The primary card is charged first.** What used to read _default_ in the portal and at checkout
  now reads _primary_, matching your dashboard and the `role` field on the API.
- **The backup is tried only when the primary fails**, and only when it is genuinely a different
  card. It now pairs with a word that has an opposite.
- The customer's payment methods panel says this once, above the cards, so the roles need no
  explanation — and a support conversation no longer needs translating between two screens.

Nothing changed about how collection behaves, and the API keeps `is_default` and the
`/payment_methods/:id/default` route exactly as they were, so existing integrations are unaffected.

Instruments saved before we began asking gateways for these details will show _Not reported_ for
the issuing country — an honest blank rather than a guess.
