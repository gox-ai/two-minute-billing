---
title: Pending debits stay pending, and mandates travel with the card
date: 2026-09-05
type: Fix
tags: Payments, Reliability
summary: An off-session bank debit is reported as in-flight until it settles, and the stored mandate is sent with the charge.
---

- **An off-session debit that is still in flight is reported as pending**, not as a failure — so it
  is left to settle, and the payer is charged exactly once.
- **A stored mandate is sent with the charge.** Where the gateway issued one, tmbilling presents it,
  which is what keeps recurring debits authorised.
- **Voiding an invoice returns its credit**, and a parked invoice can close, so nothing stays
  reserved against a bill that no longer exists.
- **Cancellation credit is calculated from the current term**, so the amount you are shown at cancel
  time is the amount that is issued.
