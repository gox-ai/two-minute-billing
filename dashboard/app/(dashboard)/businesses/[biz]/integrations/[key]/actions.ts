"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import {
  connectIntegration,
  disconnectIntegration,
  redeliverFailedIntegrationDeliveries,
  redeliverIntegrationDelivery,
  updateIntegration,
  type IntegrationAttempt,
  type IntegrationRedelivery,
} from "@/lib/api/integrations";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const revalidate = (biz: string, key: string) => {
  revalidatePath(`/businesses/${biz}/integrations/${key}`);
  revalidatePath(`/businesses/${biz}/integrations`);
};

/** `<prefix><key>` fields, as the catalogue-driven form names them. */
function collect(fd: FormData, prefix: string, keepBlank: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith(prefix)) continue;
    const value = String(v).trim();
    if (value || keepBlank) out[k.slice(prefix.length)] = value;
  }
  return out;
}

function target(fd: FormData): { biz: string; key: string } | null {
  const biz = str(fd, "biz");
  const key = str(fd, "key");
  return biz && key ? { biz, key } : null;
}

const MISSING = "The business or integration is missing. Reload the page.";

export async function connectIntegrationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const t = target(fd);
  if (!t) return actionError(MISSING);
  const credentials = collect(fd, "cred_", false);
  // Blank settings use the integration's default, so they are not sent.
  const config = collect(fd, "cfg_", false);
  const res = await connectIntegration(t.biz, t.key, {
    credentials,
    ...(Object.keys(config).length ? { config } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not connect the integration.");
  revalidate(t.biz, t.key);
  return actionOk(`${str(fd, "label") || "Integration"} connected.`);
}

/** Settings only. A blank value restores the default, so blanks are sent. */
export async function saveIntegrationSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const t = target(fd);
  if (!t) return actionError(MISSING);
  const res = await updateIntegration(t.biz, t.key, { config: collect(fd, "cfg_", true) });
  if (!res.ok) return actionError(res.error ?? "We could not save the settings.");
  revalidate(t.biz, t.key);
  return actionOk("Settings saved.");
}

/** Replaces every credential: the API stores the set as one unit. */
export async function changeIntegrationCredentialsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const t = target(fd);
  if (!t) return actionError(MISSING);
  const credentials = collect(fd, "cred_", false);
  if (!Object.keys(credentials).length)
    return actionError("We could not change the credentials. Enter all the credentials.");
  const res = await updateIntegration(t.biz, t.key, { credentials });
  if (!res.ok) return actionError(res.error ?? "We could not change the credentials.");
  revalidate(t.biz, t.key);
  return actionOk("Credentials changed.");
}

export async function setIntegrationEnabledAction(
  biz: string,
  key: string,
  enabled: boolean,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const res = await updateIntegration(biz, key, { enabled });
  if (!res.ok)
    return actionError(
      res.error ?? `We could not ${enabled ? "enable" : "disable"} the integration.`,
    );
  revalidate(biz, key);
  return actionOk(enabled ? "Integration enabled." : "Integration disabled.");
}

export async function disconnectIntegrationAction(biz: string, key: string): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const res = await disconnectIntegration(biz, key);
  if (!res.ok) return actionError(res.error ?? "We could not disconnect the integration.");
  revalidate(biz, key);
  return actionOk("Integration disconnected.");
}

/** Resend one delivery now. The transcript exists only in this result. */
export async function redeliverIntegrationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult & { attempt?: IntegrationAttempt }> {
  await requirePermission("integrations:manage", "admin");
  const t = target(fd);
  const delivery = str(fd, "delivery");
  if (!t || !delivery) return actionError(MISSING);
  const res = await redeliverIntegrationDelivery(t.biz, t.key, delivery);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "This delivery is already waiting to send.", {
        code: "conflict",
      });
    return actionError(res.error ?? "We could not resend the delivery.");
  }
  revalidate(t.biz, t.key);
  const attempt = (res.data as IntegrationRedelivery | undefined)?.attempt;
  if (!attempt) return actionOk("Delivery resent.");
  const what = attempt.response
    ? `The partner answered HTTP ${attempt.response.status} in ${attempt.latency_ms}ms.`
    : `No response came back: ${attempt.error ?? "the request failed"}.`;
  return { ...actionOk(`Delivery resent. ${what}`), attempt };
}

export async function redeliverFailedIntegrationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const t = target(fd);
  if (!t) return actionError(MISSING);
  const res = await redeliverFailedIntegrationDeliveries(t.biz, t.key);
  if (!res.ok) return actionError(res.error ?? "We could not queue the failed deliveries.");
  const n = (res.data as { requeued?: number } | undefined)?.requeued ?? 0;
  revalidate(t.biz, t.key);
  return actionOk(
    n === 0
      ? "No failed deliveries to resend."
      : `${n} failed ${n === 1 ? "delivery" : "deliveries"} queued. The billing clock sends them.`,
  );
}
