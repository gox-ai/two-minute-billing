---
title: Check every change before you copy your set-up
date: 2026-10-22
type: Feature
tags: Dashboard, Settings, Tax, Email
summary: Copy set-up now shows each change first, copies your company profile and email sending, and keeps a list of past copies.
---

**Copy set-up** (on the Transfer page) copies your configuration from one business to another.
Now you see each change before you copy, and you can copy more of your set-up.

- **Check the changes first.** Select **Check changes** to see each value that the copy changes,
  with its value now and its value after. Filter the list to new, replaced or left-out values.
  Secrets show as `••••`.
- **Leave out a section that cannot be copied.** If a section has a problem, the list tells you
  why. Select **Leave out these sections** to continue without it.
- **Copy your company profile.** Address, tax registration number, invoice issuer, default HSN/SAC
  code and default tax behavior.
- **Copy email sending.** Sender details and your SMTP or Amazon SES settings, with their secrets.
  Email templates stay with each business.
- **Keep each business's own numbers and links.** The destination keeps its invoice and credit
  note prefixes, its checkout return and cancel URLs and its portal error text. To give it new
  prefixes, enter them in the copy. The copy refuses a prefix that another business uses.
- **Start clean on a test business.** Select **Delete its catalog, coupons and taxes first** to
  give a test business an exact copy.
- **Copy the test businesses in the same run.** When you copy one live business to another, you
  can also copy their test businesses. The test businesses go first. If they fail, the live
  business does not change.

## Past copies

The **Past copies** list shows each copy for this business or for your whole organization, with
what it added and updated. Select **Repeat** to start a new copy with the same choices.

## Update a live business, with a confirmation

A live business takes only new records from a copy. To also change its settings, company
profile, email sending, numbering or tax profiles, an owner or admin selects **Also update what is
there** and types the business name to confirm. The audit log records each value that changed.
Invoices that you already issued keep their tax details.
