---
title: A new account page, retention for your organization, and metadata rules
date: 2026-10-08
type: Feature
tags: Dashboard, Accounts, Customers, Subscriptions, Metrics
summary: Manage your profile and sessions, see retention for all businesses, and set and edit metadata with rules and suggestions.
---

[Your account](/account) shows your profile, appearance and security on one page.

- **Profile.** Enter your name and upload a profile photo. The sidebar and the Team list show them.
  If you sign in with Google and do not upload a photo, the dashboard shows your Google photo.
- **Appearance.** Select Light, Dark or System. The dashboard keeps your selection on all your
  browsers.
- **Active sessions.** See each browser where you are signed in and its last activity. Sign out
  one browser or all other browsers.

## Retention for your organization

The Performance card on the organization overview now shows the same rates as each business:
Quick ratio, Gross revenue retention, Net revenue retention and Customer churn. The organization
figures combine all your businesses in your reporting currency. A larger business has more effect
on the result than a smaller business. Each card shows the period that it measures.

## Rules for metadata

Set rules for the metadata on customers and subscriptions in **Settings → Metadata rules**.

- **Rules by path.** A rule applies to a key, or to a nested key such as `billing.po`. It sets the
  type of the value, and it can set a pattern, a maximum length or a list of permitted values.
- **Optional keys.** A rule examines a value only when the value is present. A missing key is
  always permitted.
- **On or off.** Validation is off until you enable it, separately for customers and for
  subscriptions. When it is on, the API and the dashboard refuse a value that does not obey a
  rule, and the error names the key.
- **Strict mode.** Enable strict mode to also refuse keys that do not have a rule.
- **Existing data stays.** Rules examine new and changed values only. Stored metadata does not
  change.
- **Number and list rules.** A number rule can permit only whole numbers and set a minimum and a
  maximum. A list rule can set the type of each item and the permitted item values.

## Edit metadata in a form

On a customer and on a subscription change, metadata is now a form, not a JSON text box.

- **A field for each rule.** A list of values shows as a menu or as buttons. A number shows as a
  number field. A nested key shows in a group. Errors show on the field before you save.
- **Key suggestions.** When you add a key, the form suggests the keys that your other customers or
  subscriptions use, with the number of records for each key. For a key with few values, the form
  also suggests the values.
- **Rules from your data.** In **Settings → Metadata rules**, the suggested keys have a **Create
  rule** button that fills in the rule for you.
- **JSON is still available.** Select **Edit as JSON** to edit the raw text.

## Search finds all pages

Push ⌘K (Ctrl K on Windows) and type the name of a page. All settings pages are in the search. This
includes dunning, email delivery, invoice settings, payment gateways and each billing rule. You can
also use common words. For example, "retries" finds dunning.

## On your phone

The account menu at the bottom of the navigation opens correctly. The navigation stays open below
the menu.
