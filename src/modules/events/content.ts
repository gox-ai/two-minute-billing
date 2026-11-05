/**
 * Event content enrichment (BLUEPRINT §11 Part B, items 2+3). Our webhooks
 * carry a FULL snapshot of the resource (and closely related resources), not
 * a thin `{id, status}` pointer. This module builds that
 * full-snapshot `content` object for `emitEvent` to store as the event's
 * `data`.
 *
 * CRITICAL: this file may import `modules/*\/serialize.ts` loaders but must
 * NEVER import a module's `service.ts` — every `service.ts` imports
 * `@/modules/events/emit`, and `emit.ts` imports this file, so
 * service → events/emit → events/content → serialize → service would be a
 * cycle. Each `serialize.ts` loader used below is verified free of any
 * `service.ts` import.
 *
 * Enrichment is always best-effort: any loader that throws or returns null is
 * skipped silently (never fails the emit). `content = { ...siteData, ...enriched }`.
 */
import type { Tx } from "@/platform/db";
import { loadSubscriptionSnapshot } from "@/modules/subscriptions/serialize";
import { loadCustomerSnapshot } from "@/modules/customers/serialize";
import { loadInvoiceSnapshot } from "@/modules/invoicing/serialize";
import { loadCreditNoteSnapshot } from "@/modules/credit-notes/serialize";
import {
  loadPaymentMethodSnapshot,
  loadPaymentMethodCustomerPublicId,
} from "@/modules/payment-methods/serialize";
import { loadTransactionSnapshot } from "@/modules/transactions/serialize";
import { createLogger } from "@/platform/logger";

const log = createLogger("events.content");

type Snapshot = Record<string, unknown>;

async function safeLoad<T>(what: string, loader: () => Promise<T | null>): Promise<T | null> {
  try {
    return await loader();
  } catch (e) {
    // Enrichment is best-effort by design (a failed loader must never fail the
    // emit), but a snapshot that quietly stops carrying its subscription is a
    // webhook consumer's bug report, not ours — so name what dropped out.
    log.warn("event content enrichment skipped — loader failed", {
      snapshot: what,
      error: (e as Error)?.message,
    });
    return null;
  }
}

/**
 * Build the enriched `content` object for an event. `siteData` is whatever the
 * caller would otherwise have stored (typically `buildEventData(...)`'s thin
 * envelope) — it is always preserved as the base, with full snapshots merged
 * on top under the category-appropriate keys.
 */
export async function buildEventContent(
  tx: Tx,
  event: {
    type: string;
    resourceType: string;
    resourceId: string | null;
    businessId?: string | null;
  },
  siteData: unknown,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> =
    siteData && typeof siteData === "object" ? { ...(siteData as object) } : {};
  if (!event.resourceId) return base;

  const enriched: Record<string, unknown> = {};

  // Bugs #11: customer/subscription public ids are unique per BUSINESS, and `tx`'s
  // RLS scope is the ORGANIZATION (which may own several businesses) — so those two
  // loaders REQUIRE a business id. Every emitEvent call site passes one; if one ever
  // doesn't, skip that enrichment rather than resolve an ambiguous public id and risk
  // stamping another business's customer into the webhook payload. Enrichment is
  // best-effort by contract (see the file header), so a null degrades, never fails.
  // The invoice/credit-note/transaction/payment-method loaders need no such guard:
  // those public ids are engine-minted and their unique indexes stay global.
  const bizId = event.businessId ?? null;
  const cusSnap = async (cusId: string): Promise<Snapshot | null> =>
    bizId ? safeLoad("customer", () => loadCustomerSnapshot(tx, cusId, bizId)) : null;
  const subSnap = async (subId: string): Promise<Snapshot | null> =>
    bizId ? safeLoad("subscription", () => loadSubscriptionSnapshot(tx, subId, bizId)) : null;

  switch (event.resourceType) {
    case "subscription": {
      const sub = await subSnap(event.resourceId!);
      if (sub) {
        enriched.subscription = sub;
        const cusId = (sub as Snapshot).customer as string | undefined;
        if (cusId) {
          const cus = await cusSnap(cusId);
          if (cus) enriched.customer = cus;
        }
      }
      break;
    }
    case "invoice": {
      const inv = await safeLoad("invoice", () => loadInvoiceSnapshot(tx, event.resourceId!));
      if (inv) {
        enriched.invoice = inv;
        const cusId = (inv as Snapshot).customer as string | undefined;
        const subId = (inv as Snapshot).subscription as string | undefined;
        if (cusId) {
          const cus = await cusSnap(cusId);
          if (cus) enriched.customer = cus;
        }
        if (subId) {
          const sub = await subSnap(subId);
          if (sub) enriched.subscription = sub;
        }
      }
      break;
    }
    case "payment":
    case "refund":
    case "transaction": {
      const txn = await safeLoad("transaction", () =>
        loadTransactionSnapshot(tx, event.resourceId!),
      );
      let invId: string | undefined;
      if (txn) {
        enriched.transaction = txn;
        invId = (txn as Snapshot).invoice as string | undefined;
      } else {
        // `payment_succeeded` / `payment_failed` carry a PAYMENT public id (pay_…),
        // not a transaction id, so loadTransactionSnapshot misses. Recover the
        // invoice ref from the emitted payload so these events still enrich
        // customer + subscription — matching `payment_initiated`, which carries
        // the full customer/subscription snapshot.
        const payload = base[event.resourceType];
        if (payload && typeof payload === "object")
          invId = (payload as Snapshot).invoice as string | undefined;
      }
      if (invId) {
        const inv = await safeLoad("invoice", () => loadInvoiceSnapshot(tx, invId));
        if (inv) {
          enriched.invoice = inv;
          const cusId = (inv as Snapshot).customer as string | undefined;
          const subId = (inv as Snapshot).subscription as string | undefined;
          if (cusId) {
            const cus = await cusSnap(cusId);
            if (cus) enriched.customer = cus;
          }
          if (subId) {
            const sub = await subSnap(subId);
            if (sub) enriched.subscription = sub;
          }
        }
      }
      if (!enriched.customer) {
        // A payment with no invoice — the refused-signup charge, whose invoice was
        // never created — still names its customer on the payload. Enrich from that
        // so the envelope always says WHO the money belonged to.
        const payload = base[event.resourceType];
        const cusId =
          payload && typeof payload === "object"
            ? ((payload as Snapshot).customer as string | undefined)
            : undefined;
        if (cusId) {
          const cus = await cusSnap(cusId);
          if (cus) enriched.customer = cus;
        }
      }
      break;
    }
    case "credit_note": {
      const cn = await safeLoad("credit_note", () => loadCreditNoteSnapshot(tx, event.resourceId!));
      if (cn) {
        enriched.credit_note = cn;
        const invId = (cn as Snapshot).invoice as string | undefined;
        if (invId) {
          const inv = await safeLoad("invoice", () => loadInvoiceSnapshot(tx, invId));
          if (inv) {
            enriched.invoice = inv;
            const cusId = (inv as Snapshot).customer as string | undefined;
            const subId = (inv as Snapshot).subscription as string | undefined;
            if (cusId) {
              const cus = await cusSnap(cusId);
              if (cus) enriched.customer = cus;
            }
            if (subId) {
              const sub = await subSnap(subId);
              if (sub) enriched.subscription = sub;
            }
          }
        }
      }
      break;
    }
    case "customer":
    case "wallet": {
      const cus = await cusSnap(event.resourceId!);
      if (cus) enriched.customer = cus;
      break;
    }
    case "payment_source": {
      const pm = await safeLoad("payment_method", () =>
        loadPaymentMethodSnapshot(tx, event.resourceId!),
      );
      if (pm) {
        enriched.payment_source = pm;
        const cusId = await safeLoad("payment_method_customer", () =>
          loadPaymentMethodCustomerPublicId(tx, event.resourceId!),
        );
        if (cusId) {
          const cus = await cusSnap(cusId);
          if (cus) enriched.customer = cus;
        }
      }
      break;
    }
    // catalog / coupon / gateway_account / payment_intent / usage: no
    // enrichment defined — keep siteData as-is (task explicitly excludes these).
    default:
      break;
  }

  return { ...base, ...enriched };
}
