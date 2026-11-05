/**
 * Which payment instructions reach a given invoice.
 *
 * Two stages, both here so the settings screen's preview and the document agree:
 *
 *   1. TARGETING (`personalize`) — each instruction may narrow itself to a set of invoice
 *      currencies and/or customer billing countries. Off by default: send everything.
 *   2. RAIL (`mode`) — `all`, or only the rail the customer actually pays on.
 *
 * ⚠️ THE LIMIT OF `preferred_offline`, stated plainly. We have no "preferred offline
 * payment method" concept: `payment_methods` records a `provider_key` and a `type`, and
 * `offline` appears only as the provider key on a recorded PAYMENT. So the preferred rail
 * is inferred from the customer's stored method — a PayPal method selects the PayPal
 * instruction — and when nothing matches, the mode FALLS BACK to `all` rather than
 * printing nothing.
 *
 * The fallback direction is deliberate and is the whole reason this file has a docblock:
 * an invoice with no payment instructions is a customer who cannot pay it, which is a
 * worse outcome than one showing a bank block they will not use.
 */
import { and, asc, eq } from "drizzle-orm";
import { paymentInstructions } from "@db/schema";
import type { Tx } from "@/platform/db";
import type { PaymentInstructionSettings } from "./customization";

/** One instruction as the document prints it. */
export interface RenderedPaymentInstruction {
  kind: string;
  title: string;
  description: string | null;
  fields: Array<{ label: string; value: string }>;
}

/** The subset of a row the selection rules read. */
export interface SelectableInstruction extends RenderedPaymentInstruction {
  currencies: string[];
  countries: string[];
}

/**
 * Coerce the stored `fields` jsonb into label/value pairs, dropping anything malformed.
 *
 * Dropped rather than printed as `undefined`: this array is merchant-authored and lands
 * on a customer-facing document, so a half-written pair is noise on an invoice.
 */
export function parseInstructionFields(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { label, value } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof value !== "string") continue;
    const l = label.trim();
    const v = value.trim();
    if (l && v) out.push({ label: l, value: v });
  }
  return out;
}

/**
 * Apply the two selection stages. PURE, so the dashboard can show a merchant exactly
 * which instructions a given currency/country/rail combination would print.
 *
 * Comparisons are case-insensitive on both sides: currency codes and alpha-2 countries
 * are conventionally upper-case but arrive from merchant input and from customer records
 * that do not agree on case.
 */
export function selectPaymentInstructions(
  all: SelectableInstruction[],
  settings: PaymentInstructionSettings,
  ctx: { currency: string; country: string | null; preferredKind: string | null },
): RenderedPaymentInstruction[] {
  const up = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

  let matched = all;
  if (settings.personalize) {
    const cur = up(ctx.currency);
    const country = up(ctx.country);
    matched = all.filter((i) => {
      // An empty targeting array means "applies to all" — never "applies to none".
      const curOk = i.currencies.length === 0 || i.currencies.some((c) => up(c) === cur);
      const cnyOk =
        i.countries.length === 0 || (!!country && i.countries.some((c) => up(c) === country));
      return curOk && cnyOk;
    });
  }

  if (settings.mode === "preferred_offline" && ctx.preferredKind) {
    const preferred = matched.filter((i) => i.kind === ctx.preferredKind);
    // Only narrow when the preference actually selects something. See the file docblock:
    // an invoice with no instructions is worse than one with a rail they will not use.
    if (preferred.length > 0) matched = preferred;
  }

  return matched.map(({ kind, title, description, fields }) => ({
    kind,
    title,
    description,
    fields,
  }));
}

/**
 * Load a business's live instructions, ordered as the merchant arranged them. Archived
 * rows are excluded — they stay readable so an already-issued invoice can be explained,
 * but they stop printing.
 */
export async function loadPaymentInstructions(
  tx: Tx,
  businessId: string,
): Promise<SelectableInstruction[]> {
  const rows = await tx
    .select({
      kind: paymentInstructions.kind,
      title: paymentInstructions.sectionTitle,
      description: paymentInstructions.description,
      fields: paymentInstructions.fields,
      currencies: paymentInstructions.currencies,
      countries: paymentInstructions.countries,
    })
    .from(paymentInstructions)
    .where(
      and(eq(paymentInstructions.businessId, businessId), eq(paymentInstructions.archived, false)),
    )
    .orderBy(asc(paymentInstructions.position), asc(paymentInstructions.createdAt));

  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    description: r.description,
    fields: parseInstructionFields(r.fields),
    currencies: r.currencies ?? [],
    countries: r.countries ?? [],
  }));
}
