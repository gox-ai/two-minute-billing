"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import {
  createGatewayAccount,
  updateGatewayAccount,
  deleteGatewayAccount,
  verifyGatewayAccount,
  setDefaultGatewayAccount,
  getGatewayCatalog,
  type GatewayVerifyResult,
  getGatewayWebhookEndpoint,
  provisionGatewayWebhookEndpoint,
  saveGatewayWebhookSecret,
  type GatewayWebhookEndpoint,
  registerWalletDomain,
  type WalletDomainStatus,
  getGatewayBalance,
  type GatewayBalance,
} from "@/lib/api/gateways";

const gatewaysPath = (biz: string) => `/businesses/${biz}/settings/gateways`;

function fromWrite(
  res: { ok: boolean; status: number; error?: string; requestId?: string },
  okMessage: string,
): ActionResult {
  if (res.ok) return actionOk(okMessage);
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this gateway account after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? `We could not complete the request (${res.status}).`, {
    requestId: res.requestId,
  });
}

/**
 * Collect credential inputs (named cred_<key>) for the given gateway, or null when the
 * catalogue does not know it. Blank fields are dropped.
 */
async function collectCredentials(
  gatewayKey: string,
  formData: FormData,
): Promise<Record<string, string> | null> {
  const entry = (await getGatewayCatalog()).find((g) => g.key === gatewayKey);
  if (!entry) return null;
  const out: Record<string, string> = {};
  for (const f of entry.credential_fields) {
    const v = formData.get(`cred_${f.key}`);
    if (typeof v === "string" && v.trim() !== "") out[f.key] = v.trim();
  }
  return out;
}

function collectCurrencies(formData: FormData): string[] | null {
  const list = formData
    .getAll("currencies")
    .filter((v): v is string => typeof v === "string" && v.length === 3)
    .map((c) => c.toUpperCase());
  return list.length > 0 ? list : null;
}

/**
 * Selected payment methods, or null for "no restriction". Null and [] mean the same
 * thing to the router (`handlesMethod` treats a null column as match-anything), but
 * the API's zod requires `.min(1)` on the array — so an empty selection MUST post
 * null, not [].
 */
function collectMethodTypes(formData: FormData): string[] | null {
  const list = formData
    .getAll("method_types")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return list.length > 0 ? list : null;
}

// ─── Create ────────────────────────────────────────────────────────────────

const createSchema = z.object({
  biz: z.string().min(1),
  gateway_key: z.string().min(1),
  label: z.string().min(1, "Enter a label.").max(200),
});

export async function createGatewayAccountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("gateways:manage", "admin");

  const parsed = createSchema.safeParse({
    biz: formData.get("biz"),
    gateway_key: formData.get("gateway_key"),
    label: formData.get("label"),
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] = issue.message;
    return actionError("Correct the highlighted fields.", { errors });
  }
  const { biz, gateway_key, label } = parsed.data;
  const credentials = await collectCredentials(gateway_key, formData);
  if (!credentials) return actionError("We could not read the request. Reload the page.");
  const res = await createGatewayAccount(biz, {
    gateway_key,
    label,
    credentials,
    currencies: collectCurrencies(formData),
    method_types: collectMethodTypes(formData),
  });
  if (!res.ok) return fromWrite(res, "");
  revalidatePath(gatewaysPath(biz));
  const id = (res.data as { id?: string } | undefined)?.id;
  return actionOk("Gateway added", id ? `${gatewaysPath(biz)}/${id}` : gatewaysPath(biz));
}

// ─── Edit (label / currencies / status) ────────────────────────────────────

const updateSchema = z.object({
  biz: z.string().min(1),
  gwa: z.string().min(1),
  label: z.string().min(1, "Enter a label.").max(200),
  status: z.enum(["active", "disabled"]),
});

export async function updateGatewayAccountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("gateways:manage", "admin");

  const parsed = updateSchema.safeParse({
    biz: formData.get("biz"),
    gwa: formData.get("gwa"),
    label: formData.get("label"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] = issue.message;
    return actionError("Correct the highlighted fields.", { errors });
  }
  const { biz, gwa, label, status } = parsed.data;
  const res = await updateGatewayAccount(biz, gwa, {
    label,
    status,
    currencies: collectCurrencies(formData),
    method_types: collectMethodTypes(formData),
    // Only a form that shows the switch posts it (`international_switch`): an unchecked switch
    // posts nothing, which must not turn it off on another gateway's form.
    ...(formData.has("international_switch")
      ? { international_enabled: formData.get("international_enabled") === "on" }
      : {}),
  });
  if (res.ok) {
    revalidatePath(gatewaysPath(biz));
    revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  }
  return fromWrite(res, "Gateway account saved");
}

// ─── Credential rotation (write-only) ──────────────────────────────────────

export async function rotateCredentialsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("gateways:manage", "admin");

  const biz = String(formData.get("biz") ?? "");
  const gwa = String(formData.get("gwa") ?? "");
  const gatewayKey = String(formData.get("gateway_key") ?? "");
  const credentials = biz && gwa ? await collectCredentials(gatewayKey, formData) : null;
  if (!credentials) return actionError("We could not read the request. Reload the page.");
  if (Object.keys(credentials).length === 0)
    return actionError("Enter at least one credential to rotate.");
  const res = await updateGatewayAccount(biz, gwa, { credentials });
  if (res.ok) revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  return fromWrite(res, "Credentials rotated. We store them write-only.");
}

// ─── Verify / Set default / Delete (imperative, called from client buttons) ─

export async function verifyGatewayAccountAction(
  biz: string,
  gwa: string,
): Promise<Pick<GatewayVerifyResult, "ok" | "detail" | "checks">> {
  await requirePermission("gateways:manage", "admin");

  const res = await verifyGatewayAccount(biz, gwa);
  if (!res.ok)
    return {
      ok: false,
      detail: res.error ?? `We could not verify the gateway account (${res.status}).`,
    };
  const data = res.data as GatewayVerifyResult;
  return { ok: data.ok, detail: data.detail, ...(data.checks ? { checks: data.checks } : {}) };
}

/**
 * Register our Notification URL with the provider (Stripe/PayPal) or mint the
 * shared secret (RazorPay). The operator never supplies a secret — tmbilling
 * owns it.
 */
export async function provisionWebhookEndpointAction(
  biz: string,
  gwa: string,
  force = false,
): Promise<{ ok: boolean; detail?: string; endpoint?: GatewayWebhookEndpoint }> {
  await requirePermission("gateways:manage", "admin");

  const res = await provisionGatewayWebhookEndpoint(biz, gwa, force);
  if (!res.ok)
    return {
      ok: false,
      detail: res.error ?? `We could not configure the webhook endpoint (${res.status}).`,
    };
  revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  return { ok: true, endpoint: res.data as GatewayWebhookEndpoint };
}

/** Store the secret a `secret_in` gateway minted (write-only). */
export async function saveWebhookSecretAction(
  biz: string,
  gwa: string,
  secret: string,
): Promise<{ ok: boolean; detail?: string; endpoint?: GatewayWebhookEndpoint }> {
  await requirePermission("gateways:manage", "admin");

  const value = secret.trim();
  if (!value) return { ok: false, detail: "Enter the webhook secret." };
  const res = await saveGatewayWebhookSecret(biz, gwa, value);
  if (!res.ok)
    return {
      ok: false,
      detail: res.error ?? `We could not save the webhook secret (${res.status}).`,
    };
  const endpoint = res.data as GatewayWebhookEndpoint;
  // An API that ignored the field still answers 200, so read the result, not the status.
  if (!endpoint?.configured)
    return { ok: false, detail: "We could not save the webhook secret. Try again." };
  revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  return { ok: true, endpoint };
}

/**
 * Register a storefront domain for wallet buttons (Apple Pay, Google Pay, Link).
 *
 * Admin, because it changes what a buyer is offered on a public storefront. The result is
 * the gateway's own per-wallet verdict — the only honest answer to "is Apple Pay live?",
 * since an unregistered or unverified domain renders no button and reports nothing.
 */
export async function registerWalletDomainAction(
  biz: string,
  gwa: string,
  domain: string,
): Promise<{ ok: boolean; detail?: string; status?: WalletDomainStatus }> {
  await requirePermission("gateways:manage", "admin");

  // Blank means "use the configured storefront domain" — sent as an omitted field, not an
  // empty string, so the API's own resolution is what runs.
  const res = await registerWalletDomain(biz, gwa, domain.trim() || undefined);
  if (!res.ok)
    return { ok: false, detail: res.error ?? `We could not register the domain (${res.status}).` };
  revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  return { ok: true, status: res.data as WalletDomainStatus };
}

/** The Show/Copy action — fetches the secret only on explicit request. */
export async function revealWebhookSecretAction(
  biz: string,
  gwa: string,
): Promise<{ ok: boolean; secret?: string | null; detail?: string }> {
  await requirePermission("gateways:manage", "admin");

  try {
    const ep = await getGatewayWebhookEndpoint(biz, gwa, true);
    return { ok: true, secret: ep.secret };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export async function setDefaultGatewayAction(biz: string, gwa: string): Promise<ActionResult> {
  await requirePermission("gateways:manage", "admin");

  const res = await setDefaultGatewayAccount(biz, gwa);
  if (res.ok) {
    revalidatePath(gatewaysPath(biz));
    revalidatePath(`${gatewaysPath(biz)}/${gwa}`);
  }
  return fromWrite(res, "Default gateway set");
}

export async function deleteGatewayAccountAction(biz: string, gwa: string): Promise<ActionResult> {
  await requirePermission("gateways:manage", "admin");

  const res = await deleteGatewayAccount(biz, gwa);
  if (!res.ok) return fromWrite(res, "");
  revalidatePath(gatewaysPath(biz));
  // The webhook at the gateway is removed best effort; what is left to do is the operator's.
  const removal = (
    res.data as { webhook_removal?: { status?: string; instructions?: string[] } } | undefined
  )?.webhook_removal;
  const steps = removal?.instructions ?? [];
  if (steps.length > 0 && removal?.status !== "removed")
    return {
      ok: true,
      warning: true,
      message:
        removal?.status === "failed"
          ? `Gateway account deleted. We could not delete its webhook at the gateway. ${steps.join(" ")}`
          : removal?.status === "deactivated"
            ? `Gateway account deleted. We disabled its webhook at the gateway. ${steps.join(" ")}`
            : `Gateway account deleted. ${steps.join(" ")}`,
    };
  return actionOk("Gateway account deleted.");
}

/**
 * Balance for the refund dialogs, loaded when one opens. No permission gate here: the API
 * checks `gateways:view`, and an operator without it simply sees no balance.
 */
export async function loadGatewayBalanceAction(
  biz: string,
  gwa: string,
  currency: string,
): Promise<GatewayBalance | null> {
  return getGatewayBalance(biz, gwa, currency).catch(() => null);
}
