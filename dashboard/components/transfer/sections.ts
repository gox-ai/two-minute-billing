import type { TransferSection } from "@/lib/api/transfer";

export const SECTIONS: Array<{
  id: TransferSection;
  label: string;
  description: string;
  /** Ticked when the form opens. The two newer sections are opt-in, like the API. */
  defaultOn: boolean;
}> = [
  {
    id: "catalog",
    label: "Catalog",
    description: "Product groups, products, prices, attached items and differential prices.",
    defaultOn: true,
  },
  {
    id: "coupons",
    label: "Coupons",
    description: "Coupon codes and their item constraints.",
    defaultOn: true,
  },
  {
    id: "tax_rates",
    label: "Taxes",
    description: "Tax profiles, regions, rate components and state registrations.",
    defaultOn: true,
  },
  {
    id: "settings",
    label: "Settings",
    description:
      "Billing behavior: payment terms, dunning, proration, cancellation and checkout fields.",
    defaultOn: true,
  },
  {
    id: "company_profile",
    label: "Company profile",
    description:
      "Address, tax registration number, invoice issuer, default HSN/SAC and tax behavior.",
    defaultOn: false,
  },
  {
    id: "email_sending",
    label: "Email sending",
    description:
      "Sender details and the SMTP or Amazon SES settings, with their secrets. Not the templates.",
    defaultOn: false,
  },
];

export const SECTION_LABEL: Record<string, string> = {
  ...Object.fromEntries(SECTIONS.map((s) => [s.id, s.label])),
  numbering: "Numbering",
};

const FIELD_LABEL: Record<string, string> = {
  address: "Address",
  tax_registration_number: "Tax registration number",
  invoice_issuer: "Invoice issuer",
  default_tax_code: "Default HSN/SAC code",
  default_tax_behavior: "Default tax behavior",
  invoice_prefix: "Invoice prefix",
  credit_note_prefix: "Credit note prefix",
  default_invoice_notes: "Invoice notes",
  default_due_days: "Payment terms (days)",
  dunning_retry_days: "Dunning retry days",
  dunning_config: "Dunning",
  storefront_config: "Checkout and portal",
  email_config: "Sender details",
  smtp_config: "SMTP server",
  smtp_credentials: "SMTP password",
  ses_config: "Amazon SES",
  ses_credentials: "Amazon SES secret key",
};

/** `default_cancel_option` → "Default cancel option". */
export function fieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field]!;
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
