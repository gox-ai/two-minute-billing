---
title: Simpler sign-in, and a webhook resend that shows its exchange
date: 2026-09-02
type: Improvement
tags: Accounts, Developers
summary: Fewer password prompts, Google sign-in on an invite, and a resend that shows the request and response live.
---

## Signing in

- **Fewer password re-prompts.** Being signed in is enough for the things that only needed proof you
  were signed in.
- **Google sign-in works from an invite**, so a new teammate can accept and be working in one step.
- **A signed-in visitor who lands on the sign-in page is sent onward**, and signing in returns you to
  the page you were heading for rather than the home page.

## Webhooks

**Resend calls your endpoint immediately and shows the exchange** — the request we sent and the
response you returned, on screen, while you watch. Endpoints can be named when you create them, and
the delivery log groups one card per endpoint so a noisy endpoint is easy to find.
