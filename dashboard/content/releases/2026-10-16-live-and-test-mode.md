---
title: Each business has a live mode and a test mode
date: 2026-10-16
type: Feature
tags: Dashboard, Businesses, Developers, Payments
summary: Try your setup in the test mode of a business, then bill real customers in live mode.
---

When you create a business, you get two modes: live and test. Live mode bills your real
customers. Use test mode to try your catalog, settings and integration before you go live.

- **One switch.** Inside a business, use **Mode** at the bottom of the navigation. You go to the
  same page in the other mode.
- **A copy to start.** Test mode starts with the settings of the live business. After that, the
  two modes are separate. A change in one mode does not change the other.
- **Move your setup.** To copy the catalog and settings from one mode to the other, use
  **Transfer & Sample Data**. The other mode of the business is already selected.
- **Two business IDs.** Each mode has its own business ID. A test API key gets access only to test
  mode, and a live API key gets access only to live mode. On the **Developers** page, your keys
  show in two groups: Live keys and Test keys.

## Safe to test

- **No real money.** Test mode uses the TM Billing Test Gateway. The hosted checkout and the
  customer portal show a "Test mode" notice.
- **Email only to your team.** In test mode, we send email only to the addresses of your team
  members. Other customer emails are not sent, and the email log shows why.
- **Start again.** In test mode, **Delete test data** deletes all customers and their
  subscriptions, invoices and payments. The catalog and settings stay.
- **HubSpot is live only.** Test data does not go into your CRM, so you connect HubSpot in live
  mode.

## Your existing businesses

Your organization overview and reports show live data. A business that you created before today
gets its test mode the first time that you select **Mode → Test**. Test businesses that you
created before today continue to work. The organization overview lists them separately.
