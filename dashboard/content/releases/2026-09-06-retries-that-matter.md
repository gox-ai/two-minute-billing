---
title: The Retries screen shows what will actually be retried
date: 2026-09-06
type: Improvement
tags: Invoicing, Ops
summary: Only invoices with a live retry schedule appear, and an invariant watches for bills nobody will collect.
---

The **Retries** screen lists the invoices the billing clock is genuinely still working on, so its
count is a number you can act on rather than a backlog to interpret.

Alongside it, a new invariant watches for the opposite case — an invoice that will never be
collected by anyone — and surfaces it rather than leaving it to be discovered.

Both feed the same goal: the screens that say "money is still coming" should only ever list money
that is still coming.
