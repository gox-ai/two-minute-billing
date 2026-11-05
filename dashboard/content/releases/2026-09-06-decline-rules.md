---
title: Decide how each gateway decline behaves
date: 2026-09-06
type: Feature
tags: Payments, Dunning
summary: A screen for every decline code your gateways can return — what it means, whether we retry it, and what the payer is told.
---

Gateways speak in error codes, and each one deserves a different answer: retry this one tomorrow,
never retry that one, tell the payer to call their bank. **Error handling** is a screen for exactly
that.

- **Every code we recognise is listed**, not only the ones you have already seen, so you can decide
  in advance rather than after a failed renewal.
- **Codes are grouped**, with the wording the payer will read shown beside each.
- **A business can override any rule** — set an error code's behaviour once and it applies to every
  future decline of that code.
- **RazorPay merchants see RazorPay's codes**, and the network's own do-not-retry instruction is
  respected where the network sends one.
- The same rules are available on the API: list them, and change how one decline behaves for a
  business.
