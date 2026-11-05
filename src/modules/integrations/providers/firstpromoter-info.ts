import type { IntegrationInfo, ApiKeyConnect } from "../types";

/**
 * FirstPromoter's static description. Split from `firstpromoter.ts` so listing integrations never
 * loads the delivery code — keep this file free of runtime imports.
 */

export const DEFAULT_TID_FIELD = "fp_tid";

export const firstPromoterInfo: IntegrationInfo & { connect: ApiKeyConnect } = {
  key: "firstpromoter",
  label: "FirstPromoter",
  kind: "push",
  category: "affiliate",
  blurb: "We send sales, refunds, sign-ups and cancellations to FirstPromoter when they occur.",
  icon: { monogram: "FP", src: "/logos/firstpromoter.svg" },
  connect: {
    method: "api_key",
    defaultUrl: "https://api.firstpromoter.com/api/v2",
    eventTypes: [
      "customer_created",
      "invoice_paid",
      "refund_created",
      "refund_settled",
      "subscription_canceled",
    ],
    credentials: [
      {
        key: "apiKey",
        label: "FirstPromoter API key",
        hint: "Settings → Integrations → Manage API keys",
      },
      {
        key: "accountId",
        label: "Account ID",
        hint: "Settings → Integrations → API integration",
        secret: false,
      },
    ],
    fields: [
      {
        key: "tidField",
        label: "Referral-id custom field",
        placeholder: DEFAULT_TID_FIELD,
        help: `Enter the name of the field, not its value, as it shows in Settings → Custom fields. A leading cf_ is permitted. Leave blank to use ${DEFAULT_TID_FIELD}.`,
      },
    ],
    prerequisite: {
      title: "Do this first",
      body:
        "Define that as a customer custom field and pass the visitor's _fprom_tid cookie into it " +
        "when you create the customer. Without it, we cannot attribute referrals. We skip the " +
        "sign-ups of customers that do not have it, and do not send them.",
    },
  },
};
