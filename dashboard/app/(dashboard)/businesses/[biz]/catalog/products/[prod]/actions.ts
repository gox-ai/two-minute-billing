"use server";

import { resetOf, type AllowanceReset, type ResetDraft } from "@/lib/reset";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePermission } from "@/lib/session";
import { listApplicablePlans, apiWrite, type AttachedItemConfig } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import type { SecretLinkResult } from "@/lib/secret-link";

const productUrl = (biz: string, prod: string) => `/businesses/${biz}/catalog/products/${prod}`;

/**
 * Mint a hosted-checkout link for a price (#10d operator entry point).
 * Mirrors the customer "Portal link" action: POST the checkout_sessions mint
 * route and hand the one-time /checkout/s/<token> URL back to the dialog that shows it.
 *
 * The label renders the mint response's own `expires_at` rather than restating a
 * duration — same fix, same reasoning, as `createPortalLinkAction` in
 * `customers/[cus]/actions.ts`: a hardcoded "valid 72h" drifted the moment
 * `CHECKOUT_SESSION_TTL_HOURS` moved to 24, and a hardcoded replacement would only
 * drift again next time the TTL changes. Reading the field means it can't.
 *
 * The label also carries the session's `cosess_…` public id (F-19a): the mint
 * response includes it, but until now nothing surfaced it to the operator, so
 * `POST …/checkout_sessions/:id/revoke` — the only lever for a leaked link — was
 * unreachable in practice. The id is not a credential; showing it does not widen
 * what the reveal exposes.
 */
export async function createCheckoutLinkAction(
  biz: string,
  price: string,
): Promise<SecretLinkResult> {
  await requirePermission("catalog:manage", "ops");
  return mintCheckoutLink(biz, price, "create");
}

/** A one-time product's link: a purchase, paid once, with no subscription. */
export async function createPurchaseLinkAction(
  biz: string,
  price: string,
): Promise<SecretLinkResult> {
  await requirePermission("checkout_sessions:manage", "ops");
  return mintCheckoutLink(biz, price, "purchase");
}

async function mintCheckoutLink(
  biz: string,
  price: string,
  mode: "create" | "purchase",
): Promise<SecretLinkResult> {
  await requirePermission("checkout_sessions:manage", "ops");
  if (!biz || !price) return { ok: false, error: "The price ID is missing. Reload the page." };
  const res = await apiWrite(`/v1/businesses/${biz}/checkout_sessions`, { price, mode });
  if (!res.ok) return { ok: false, error: res.error ?? "We could not create the checkout link." };
  const data = res.data as { id: string; token: string; url?: string; expires_at: string };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  // Only the exchange route (`/checkout/s/<token>`) and `/checkout` actually exist —
  // the pre-W1 `/checkout/<token>` path 404s. This fallback only fires when
  // PORTAL_BASE_URL is unset and `data.url` is absent.
  const url = data.url ?? `${origin}/checkout/s/${data.token}`;
  return {
    ok: true,
    label: `Hosted checkout link (${data.id}). It works until ${fmtDateTime(data.expires_at, await businessTz(biz))}`,
    secret: url,
  };
}

/**
 * Replace a product's JSON metadata.
 * `PATCH …/products/:prod` accepts `metadata` and ASSIGNS it, so this stores exactly what
 * was typed; blank sends null, which clears it.
 *
 * The dialog parses the JSON too, for an error next to the field — this parse is the one
 * that matters, because an editable textarea is never a trusted input.
 */
export async function updateProductMetadataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const prod = String(formData.get("prod") ?? "").trim();
  const raw = String(formData.get("metadata") ?? "").trim();
  if (!biz || !prod) return actionError("The product ID is missing. Reload the page.");

  let metadata: Record<string, unknown> | null = null;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const message = `Metadata is not valid JSON: ${(e as Error).message}`;
      return actionError(message, { errors: { metadata: message } });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const message = 'Metadata must be a JSON object. For example, {"tier":"gold"}.';
      return actionError(message, { errors: { metadata: message } });
    }
    metadata = parsed as Record<string, unknown>;
  }

  const res = await apiWrite(`/v1/businesses/${biz}/products/${prod}`, { metadata }, "PATCH");
  revalidatePath(productUrl(biz, prod));
  return res.ok
    ? actionOk("Metadata saved.")
    : actionError(res.error ?? "We could not save the metadata.");
}

/**
 * Grant a feature on this plan. The engine upserts on (product, feature), so the same
 * action edits an existing grant. It also validates the value against the feature type.
 */
export async function setPlanEntitlementAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const prod = String(formData.get("prod") ?? "").trim();
  const feature = String(formData.get("feature") ?? "").trim();
  const unlimited = formData.get("unlimited") === "on";
  const value = unlimited ? "unlimited" : String(formData.get("value") ?? "").trim();
  if (!biz || !prod) return actionError("The product ID is missing. Reload the page.");
  if (!feature || !value) return actionError("Select a feature and a value.");
  // A meter allowance's "Renews" (G3b): null = the next invoice's usage window; "Same as the
  // credits" posts the link, which the engine resolves per subscription.
  let reset: AllowanceReset | null | undefined;
  if (formData.get("reset_present") === "1" && formData.get("reset_same") === "on") {
    reset = { same_as_credits: true };
  } else if (formData.get("reset_present") === "1") {
    let draft: ResetDraft;
    try {
      draft = JSON.parse(String(formData.get("reset_json") ?? ""));
    } catch {
      return actionError("We could not read the renewal fields. Reload the page.");
    }
    const r = resetOf(draft);
    if (!r.ok) return actionError(r.message);
    reset = r.value;
  }

  const res = await apiWrite(`/v1/businesses/${biz}/products/${prod}/entitlements`, {
    feature,
    value,
    ...(reset !== undefined ? { reset } : {}),
  });
  revalidatePath(productUrl(biz, prod));
  return res.ok
    ? actionOk("Entitlement saved")
    : actionError(res.error ?? "We could not save the entitlement.");
}

function num(fd: FormData, key: string): number | undefined {
  const v = String(fd.get(key) ?? "").trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A stored link config back in the PUT's shape, so a save keeps every field of the other plans. */
function linkToWire(v: AttachedItemConfig) {
  return {
    charge_on_event: v.chargeOnEvent,
    charge_once: v.chargeOnce,
    default_quantity: v.defaultQuantity,
    billing_cycles: v.billingCycles,
    min_quantity: v.minQuantity ?? null,
    max_quantity: v.maxQuantity ?? null,
    quantity_step: v.quantityStep ?? 1,
    customer_can_change_quantity: v.customerCanChangeQuantity ?? true,
  };
}

/**
 * Attach an addon/charge to a plan with full config (applicability,
 * charge_on_event, charge_once, default_quantity, billing_cycles).
 *
 * Two-arg form for useActionState / ActionForm.
 */
export async function attachItemToPlanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const plan = String(formData.get("plan") ?? "").trim();
  const addon = String(formData.get("addon") ?? "").trim();
  const applicability = String(formData.get("applicability") ?? "optional").trim();
  const postedEvent = String(formData.get("charge_on_event") ?? "").trim() || undefined;
  const defaultQty = num(formData, "default_quantity");
  const billingCycles = num(formData, "billing_cycles") ?? null;

  if (!biz || !plan || !addon) return actionError("Some required fields are empty.");

  let current: Awaited<ReturnType<typeof listApplicablePlans>>;
  try {
    current = await listApplicablePlans(biz, addon);
  } catch {
    return actionError("We could not load the addon links.");
  }

  const plans = Array.from(new Set([...current.plans, plan]));
  const applicabilityMap: Record<string, string> = {
    ...current.applicability,
    [plan]: applicability,
  };

  // Merge existing config, then overwrite for this plan.
  const existingConfig = current.config ?? {};
  const planConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existingConfig)) planConfig[k] = linkToWire(v);
  // The dialog offers no event or charge-once control for an add-on, so an edit must keep
  // what the link already has rather than resetting it to subscription_creation / recurring.
  const prior = existingConfig[plan];
  const chargeOnEvent = postedEvent ?? prior?.chargeOnEvent;
  // The portal limits are posted only where the dialog shows them; otherwise keep the stored ones.
  const portal = formData.has("portal_limits")
    ? {
        min_quantity: num(formData, "min_quantity") ?? null,
        max_quantity: num(formData, "max_quantity") ?? null,
        quantity_step: num(formData, "quantity_step") ?? 1,
        customer_can_change_quantity: formData.get("customer_can_change_quantity") === "on",
      }
    : prior
      ? {
          min_quantity: prior.minQuantity ?? null,
          max_quantity: prior.maxQuantity ?? null,
          quantity_step: prior.quantityStep ?? 1,
          customer_can_change_quantity: prior.customerCanChangeQuantity ?? true,
        }
      : {};
  if (
    portal.min_quantity != null &&
    portal.max_quantity != null &&
    portal.min_quantity > portal.max_quantity
  )
    return actionError("Correct the highlighted fields.", {
      errors: { max_quantity: "Enter a maximum that is not less than the minimum." },
    });
  planConfig[plan] = {
    ...(chargeOnEvent ? { charge_on_event: chargeOnEvent } : {}),
    charge_once: prior?.chargeOnce ?? false,
    ...(defaultQty != null ? { default_quantity: defaultQty } : {}),
    billing_cycles: billingCycles,
    ...portal,
  };

  const res = await apiWrite(
    `/v1/businesses/${biz}/products/${addon}/applicable_plans`,
    { plans, applicability: applicabilityMap, config: planConfig },
    "PUT",
  );
  revalidatePath(productUrl(biz, plan));
  const editing = current.plans.includes(plan);
  return res.ok
    ? actionOk(editing ? "Item saved." : "Item added.")
    : actionError(
        res.error ?? (editing ? "We could not save the item." : "We could not add the item."),
      );
}

/**
 * Detach an addon/charge from a plan.
 */
export async function detachItemFromPlanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const plan = String(formData.get("plan") ?? "").trim();
  const addon = String(formData.get("addon") ?? "").trim();
  if (!biz || !plan || !addon) return actionError("The item ID is missing. Reload the page.");

  let current: Awaited<ReturnType<typeof listApplicablePlans>>;
  try {
    current = await listApplicablePlans(biz, addon);
  } catch {
    return actionError("We could not load the addon links.");
  }

  const plans = current.plans.filter((p) => p !== plan);
  const applicability = Object.fromEntries(
    Object.entries(current.applicability).filter(([k]) => k !== plan),
  );
  const existingConfig = current.config ?? {};
  const config = Object.fromEntries(
    Object.entries(existingConfig)
      .filter(([k]) => k !== plan)
      .map(([k, v]) => [k, linkToWire(v)]),
  );

  const res = await apiWrite(
    `/v1/businesses/${biz}/products/${addon}/applicable_plans`,
    { plans, applicability, config },
    "PUT",
  );
  revalidatePath(productUrl(biz, plan));
  return res.ok
    ? actionOk("Item removed.")
    : actionError(res.error ?? "We could not remove the item.");
}
