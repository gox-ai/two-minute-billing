"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  createNotificationDestination,
  removeNotificationDestination,
  resendDestinationConfirmation,
  sendTestToDestination,
  updateNotificationDestination,
  type BusinessFilter,
  type DestinationKind,
  type NotificationDestination,
} from "@/lib/api/notifications";

const PATH = "/settings/notifications";
const CHAT_URL = "Enter a Google Chat webhook URL. It starts with https://chat.googleapis.com/.";

/** Owners and admins only: the API refuses everyone else, so refuse before the round trip. */
function manager(u: { role: string }): ActionResult | null {
  return u.role === "owner" || u.role === "admin"
    ? null
    : actionError(
        "We could not change team notifications. Only owners and admins can change them.",
      );
}

const filterOf = (business: string | undefined): BusinessFilter =>
  business ? { mode: "selected", business_ids: [business] } : { mode: "all" };

const chatSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for the space.").max(100),
  url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https:\/\/chat\.googleapis\.com\//, CHAT_URL),
  business: z.string().max(64).optional(),
  hide_names: z.literal("on").optional(),
});

/** "Send test and add": Google Chat gets a test message first; a failed one adds nothing. */
export async function addChatSpaceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const refused = manager(await requireUser());
  if (refused) return refused;
  const parsed = parseForm(chatSchema, formData);
  if (parsed.error)
    return { ...parsed.error, values: { name: String(formData.get("name") ?? "") } };
  const d = parsed.data;
  const r = await createNotificationDestination({
    type: "chat",
    name: d.name,
    url: d.url,
    send_test: true,
    business_filter: filterOf(d.business),
    hide_names: d.hide_names === "on",
  });
  if (!r.ok)
    return actionError(r.error ?? "We could not add the space.", {
      errors: r.status === 400 ? { url: r.error ?? CHAT_URL } : undefined,
      values: { name: d.name },
      requestId: r.requestId,
    });
  revalidatePath(PATH);
  const row = r.data as NotificationDestination;
  return actionOk("Space added. We sent a test message to it.", `${PATH}/${row.id}`);
}

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address.")
    .max(254)
    .email("Enter an email address."),
  business: z.string().max(64).optional(),
});

/** An outside address starts pending: it gets a confirmation email, nothing else. */
export async function addOutsideEmailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const refused = manager(await requireUser());
  if (refused) return refused;
  const parsed = parseForm(emailSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const r = await createNotificationDestination({
    type: "email",
    email: d.email,
    business_filter: filterOf(d.business),
  });
  if (!r.ok)
    return actionError(r.error ?? "We could not add the address.", {
      errors: r.status === 400 ? { email: r.error ?? "Enter an email address." } : undefined,
      values: { email: d.email },
      requestId: r.requestId,
    });
  revalidatePath(PATH);
  const row = r.data as NotificationDestination;
  return actionOk("Address added. We sent it a confirmation email.", `${PATH}/${row.id}`);
}

const kindSchema = z.object({
  on: z.boolean(),
  above: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().min(0)).optional(),
});
const editSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, "Enter a name.").max(100).optional(),
  url: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === "" || /^https:\/\/chat\.googleapis\.com\//.test(v), CHAT_URL)
    .optional(),
  config: z
    .string()
    .max(100_000)
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "We could not read the form. Reload the page." });
        return z.NEVER;
      }
    })
    .pipe(
      z.object({
        business_filter: z.union([
          z.object({ mode: z.literal("all") }),
          z.object({
            mode: z.literal("selected"),
            business_ids: z.array(z.string().max(64)).max(500),
          }),
        ]),
        kinds: z.record(z.string().max(64), kindSchema),
        daily: z.boolean(),
        weekly: z.boolean(),
        hide_names: z.boolean(),
      }),
    ),
});

/** The edit view of one space or address. A new webhook URL makes a space work again. */
export async function updateDestinationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const refused = manager(await requireUser());
  if (refused) return refused;
  const parsed = parseForm(editSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (
    d.config.business_filter.mode === "selected" &&
    d.config.business_filter.business_ids.length === 0
  )
    return actionError("Correct the highlighted fields.", {
      errors: { business_filter: "Select at least one business." },
    });
  const r = await updateNotificationDestination(d.id, {
    ...(d.name ? { name: d.name } : {}),
    ...(d.url ? { url: d.url } : {}),
    business_filter: d.config.business_filter as BusinessFilter,
    kinds: d.config.kinds as Record<string, DestinationKind>,
    daily: d.config.daily,
    weekly: d.config.weekly,
    hide_names: d.config.hide_names,
  });
  if (!r.ok)
    return actionError(r.error ?? "We could not save the changes.", {
      errors: r.status === 400 && d.url ? { url: r.error ?? CHAT_URL } : undefined,
      requestId: r.requestId,
    });
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${d.id}`);
  return actionOk("Changes saved.");
}

type Plain = { ok: true; message: string } | { ok: false; message: string };
const ID = /^[A-Za-z0-9_]{1,64}$/;

export async function removeDestinationAction(id: string): Promise<Plain> {
  const refused = manager(await requireUser());
  if (refused) return { ok: false, message: refused.message ?? "" };
  if (!ID.test(id)) return { ok: false, message: "We could not find this destination." };
  const r = await removeNotificationDestination(id);
  revalidatePath(PATH);
  return r.ok
    ? { ok: true, message: "Destination removed." }
    : { ok: false, message: r.error ?? "We could not remove the destination." };
}

export async function testDestinationAction(id: string): Promise<Plain> {
  const refused = manager(await requireUser());
  if (refused) return { ok: false, message: refused.message ?? "" };
  if (!ID.test(id)) return { ok: false, message: "We could not find this destination." };
  const r = await sendTestToDestination(id);
  revalidatePath(PATH);
  return r.ok
    ? { ok: true, message: "Test sent." }
    : { ok: false, message: r.error ?? "We could not send the test." };
}

export async function resendConfirmationAction(id: string): Promise<Plain> {
  const refused = manager(await requireUser());
  if (refused) return { ok: false, message: refused.message ?? "" };
  if (!ID.test(id)) return { ok: false, message: "We could not find this destination." };
  const r = await resendDestinationConfirmation(id);
  revalidatePath(PATH);
  return r.ok
    ? { ok: true, message: "Confirmation email sent." }
    : { ok: false, message: r.error ?? "We could not send the confirmation email." };
}
