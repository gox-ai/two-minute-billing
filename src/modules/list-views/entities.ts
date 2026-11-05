import { CUSTOMER_FILTER_OPS } from "@/modules/customers/service";
import { SUBSCRIPTION_FILTER_OPS } from "@/modules/subscriptions/service";
import { INVOICE_FILTER_OPS } from "@/modules/invoicing/service";
import { CREDIT_NOTE_FILTER_OPS } from "@/modules/credit-notes/service";
import { TRANSACTION_FILTER_OPS } from "@/modules/transactions/service";
import { EVENT_FILTER_OPS } from "@/modules/events/service";
import { EMAIL_FILTER_OPS } from "@/modules/emails/service";
import { AUDIT_FILTER_OPS } from "@/modules/audit/service";
import { GATEWAY_REQUEST_FILTER_OPS } from "@/modules/gateway/activity";
import { GATEWAY_WEBHOOK_FILTER_OPS } from "@/modules/gateway/inbound";

/**
 * Every list a view can be saved against, keyed the way the dashboard keys its own
 * list proxy (`/api/lists/<entity>`). One vocabulary across the engine, the proxy and
 * the URL, so a stored view, a shared link and an API call all name the same list.
 *
 * A closed list rather than free text: an entity typo would produce a view that saves
 * successfully and then never appears on any screen, which is the worst shape a bug
 * can take here — no error, no rows, and an operator who believes they saved something.
 * A DB enum was rejected instead of this because adding a list would then need a
 * migration; the same trade-off `COMMENT_RESOURCE_TYPES` makes.
 */
export const LIST_VIEW_ENTITIES = [
  // Server-backed, business-scoped.
  "customers",
  "subscriptions",
  "invoices",
  "credit_notes",
  "transactions",
  "payment_intents",
  "emails",
  "events",
  "gateway_webhooks",
  "gateway_requests",
  "audit_logs",
  "retries",
  // Server-backed, org-level — `business_id` is NULL for these (see the schema note).
  "org_audit_logs",
  // Bounded lists the dashboard filters in the browser (catalog, settings). They have
  // no engine filter allow-list, so `fieldOpsFor` returns null and the field/operator
  // check is skipped — see `validateFilters`.
  "products",
  "prices",
  "coupons",
  "coupon_sets",
  "item_groups",
  "tax_regions",
  "gateways",
  "disputes",
  "businesses",
] as const;

export type ListViewEntity = (typeof LIST_VIEW_ENTITIES)[number];

/** Visibility vocabulary. Mirrored by `list_views_visibility_check` in 0219. */
export const LIST_VIEW_VISIBILITY = ["private", "everyone"] as const;
export type ListViewVisibility = (typeof LIST_VIEW_VISIBILITY)[number];

/**
 * `entity → (field → operators)` for the lists whose filtering runs in SQL.
 *
 * Reusing each module's own `*_FILTER_OPS` — the same map its route validates
 * against — is what makes a saved view unable to hold a filter the list would later
 * reject. A second, hand-maintained copy would drift, and the drift would only show up
 * as a view that 400s months after it was saved.
 */
const SERVER_FIELD_OPS: Partial<Record<ListViewEntity, Record<string, readonly string[]>>> = {
  customers: CUSTOMER_FILTER_OPS,
  subscriptions: SUBSCRIPTION_FILTER_OPS,
  invoices: INVOICE_FILTER_OPS,
  credit_notes: CREDIT_NOTE_FILTER_OPS,
  transactions: TRANSACTION_FILTER_OPS,
  events: EVENT_FILTER_OPS,
  emails: EMAIL_FILTER_OPS,
  audit_logs: AUDIT_FILTER_OPS,
  org_audit_logs: AUDIT_FILTER_OPS,
  gateway_requests: GATEWAY_REQUEST_FILTER_OPS,
  gateway_webhooks: GATEWAY_WEBHOOK_FILTER_OPS,
};

/**
 * The field allow-list for one entity, or null when that list filters in the browser
 * and the engine has no opinion about its fields.
 *
 * ⚠ null means "cannot check", NOT "anything goes". `validateFilters` still checks the
 * operator against the global vocabulary and the value against nothing — a client-side
 * list's own `filterFields` is the authority there, and the dashboard drops unknown
 * fields before it ever applies them.
 */
export function fieldOpsFor(entity: ListViewEntity): Record<string, readonly string[]> | null {
  return SERVER_FIELD_OPS[entity] ?? null;
}
