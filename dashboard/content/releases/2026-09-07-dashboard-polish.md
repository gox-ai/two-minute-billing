---
title: Forms, search and loading states
date: 2026-09-07
type: Fix
tags: Dashboard
summary: Saved values stay saved, search keeps up on long lists, and each page's loading state matches the page.
---

- **A saved form shows the saved values.** Save a form and what you see is what was written, straight
  away.
- **Search keeps up.** Typing in a list filter now only re-renders what actually changed, so long
  tables stay responsive as you type.
- **Loading states match their page.** Each screen's placeholder now has the shape of the screen that
  is coming — a table where a table is coming, sections where sections are coming — so it tells you
  where to look.
- **Organization screens follow your time zone.** System, Audit Log and Developers render timestamps
  in the display time zone you set, alongside every other date.
- **Reason codes, custom fields and error handling** read cleanly, and the decline-rules table now
  matches the density of every other list.
