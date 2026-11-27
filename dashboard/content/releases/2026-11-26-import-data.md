---
title: Import and export your customers, subscriptions and billing history as CSV files
date: 2026-11-26
type: Feature
tags: Migration, Customers, Subscriptions, Invoicing, Payments, Dashboard, Developers
summary: Bring plans, coupons, customers with their saved cards, subscriptions, invoices, payments, credit notes and usage over from CSV files, and export them the same way. Check every row first, then import, and undo if you need to.
---

Move your billing from another system in the dashboard, with no code, and take a copy of it out
whenever you need one. Open **Settings → Import and export data**, or select **Import customers**
on the Customers list.

## Your set-up and your customers

- **One file for each section.** Upload plans and prices, add-ons, coupons, customers and
  subscriptions. Each section has a template with an example row. Columns with a known name are
  matched to their field, so most exports need no changes. You can also upload the migration JSON
  file.
- **Saved cards come with the customer.** A customer row can refer to a card that is saved at your
  payment gateway. Renewals charge that card when the same gateway account is connected. Card
  numbers are never in the file.

## Your billing history

- **Invoices.** Paid, open and void invoices, one row for each line, with their tax and discount.
  We check that each invoice adds up to its total before anything is written.
- **Payments and refunds.** Each payment with the invoice it paid, and refunds of those payments.
- **Credit notes.** The credit a customer can still use becomes credit on the customer.
- **Usage.** Usage records for a usage price that is on a subscription.
- **Open invoices are not collected unless you choose it.** They import as owed, because your
  current system may still collect them. Select **Collect them** in the review to have your retry
  schedule collect them from their due date, or collect one later with **Collect payment** on the
  invoice.

## Check, import, undo

- **Check before anything changes.** **Check what changes** reads every row. The review shows each
  row as new, blocked or in this business already, with the reason for each blocked row. Leave out
  blocked rows, or correct the file and upload it again.
- **See what arrives.** The review shows the monthly recurring revenue the subscriptions bring,
  how many customers have a card at a connected gateway, the first renewal date, what open invoices
  owe, the credit customers can use, and your next invoice number if the imported numbers change
  it. It tells you about subscriptions that renew in the next 24 hours, so you can stop them in
  your old system first or leave them out.
- **No surprises for customers.** An import charges no customer, and sends no emails or webhooks.
  In a live business, you type the business name to start it.
- **Results for each row.** The import runs in the background, and the person who started it gets
  an email when it ends. Download each file again with the result of each row.
- **Undo an import.** **Undo import** deletes only the records the import added, and reverses the
  opening balances of its open invoices and credit in the ledger. You can undo an import until the
  first renewal, invoice, payment or change on a record it added.
- **Past imports.** Every import stays on the list, with who started it and when.
- **Import with the API too.** The same import is in the API: upload, check, start, read the
  results and undo.

## Export your data

- **Every record type in one zip.** Select plans, add-ons, coupons, customers, subscriptions,
  invoices, credit notes, payments and usage on **Export data**. Each one is a CSV file, and all
  the files are taken at the same moment.
- **Files that import as they are.** Each file has the columns that the import reads, so you can
  upload it on **Import files** in another business without changes.
- **Only the rows you want.** Filter each record type by status and by date. The screen shows how
  many records each file gets, and **Preview** shows the first rows as the file has them.
- **Nothing is missing.** An export of last month's invoices also brings their customers,
  subscriptions and prices, so the files import on their own. You can turn this off.
- **It runs in the background.** You get an email when the files are ready. Download the zip or
  one file, and select **Export again** to take a new copy with the same choices. We keep the
  files for 7 days, and the audit log records each download.
- **From any list.** **Export › Export all in the background** on Customers, Subscriptions,
  Invoices and other lists opens the export for that list's records.
- **An email when an import ends.** When an import or an undo ends in the background, you get an
  email with a link to it.

## Also in this release

- **Long lists in dialogs scroll.** A dropdown list in a dialog or a side panel, such as the
  attribute list in **Add a filter** on Customers, now scrolls with the mouse wheel.

Read [Import your data](https://twominutebilling.com/help/guides/import-your-data) for the columns
of each file, and [Export your data](https://twominutebilling.com/help/guides/export-your-data). To
use the API, see [Import from CSV files](https://twominutebilling.com/help/developers/recipes/import-from-csv-files)
and [Export to CSV files](https://twominutebilling.com/help/developers/recipes/export-to-csv-files).
