---
title: Ask the gateway about a stuck payment
date: 2026-09-06
type: Feature
tags: Payments, Ops
summary: A read-only check that fetches what the gateway currently knows, and shows you the answer.
---

When a payment has been sitting in an unclear state, you can now ask the gateway directly. The
transaction shows a **check now** control that fetches the gateway's current view and displays it
beside ours.

- It is a **read**. Checking never moves money and never spends a retry.
- The panel names the actual gateway, and says plainly when nothing has changed yet rather than
  implying a result.
- The gateway's answer is shown as the gateway gave it, so there is nothing to take on trust.
