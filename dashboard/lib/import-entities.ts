/** The CSV files an import takes, one per section, in import order. Client-safe. */
export const IMPORT_ENTITIES = [
  "plans",
  "addons",
  "coupons",
  "customers",
  "subscriptions",
  "invoices",
  "credit_notes",
  "payments",
  "usage",
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
/** The sections that carry history. */
export const HISTORY_ENTITIES: readonly ImportEntity[] = [
  "invoices",
  "credit_notes",
  "payments",
  "usage",
];
