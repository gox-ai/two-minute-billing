---
title: Alerts that name the rows they counted
date: 2026-09-04
type: Improvement
tags: Ops
summary: Every alert links to the exact rows behind its number, and operational noise is separated from correctness.
---

An alert that says "37" and stops there costs you the next ten minutes. Every alert now **names the
rows it counted** and links straight to them, with the filters already applied.

- **Operations and correctness are separate.** Something slow or retrying is a different kind of news
  from something that does not add up, and they no longer share a list.
- **A warning that will not clear escalates.** A condition that persists gets louder instead of
  staying at the same level indefinitely.
- **Gateway money is legible.** The screens that reconcile what the gateway holds against what we
  booked now show which captures are ours and what each one belongs to.
- **A possible double charge is called what it is**, so the most expensive thing to miss is the
  clearest thing on the screen.
