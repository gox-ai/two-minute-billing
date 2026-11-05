/**
 * Per-business email template overrides: read, upsert, reset, preview.
 *
 * The store is SPARSE — a row exists only for a type a merchant edited. Every read
 * therefore falls back to the built-in rather than assuming a row is there, and "reset to
 * default" is a delete. See db/schema/emails.ts for why that shape was chosen.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { withTenant } from "@/platform/db";
import { businesses, emailTemplates } from "@db/schema";
import { publicId } from "@/platform/ids";
import {
  EMAIL_TYPES,
  EMAIL_DOCUMENT,
  ZERO_VALUE_PDF_TYPES,
  ZERO_VALUE_SEND_TYPES,
  attachmentRule,
  resolveEmailConfig,
  type EmailConfig,
  type EmailType,
} from "./config";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_VARS,
  SAMPLE_RENDER_VARS,
  sampleVarsFor,
  VAR_LABELS,
  DEFAULT_FOOTER,
  BLOCK_ORDER_DEFAULT,
  isBlockOrder,
  templateCapabilities,
  renderEmail,
  // The same block builder the outbox uses, so a preview and a real send cannot disagree
  // about which facts and which button an email carries.
  blocksFor,
  type TemplateDef,
  type RenderedEmail,
  type RenderVars,
  type BlockKey,
} from "./templates";
import { sanitizeEmailHtml } from "./sanitize";
import { checkField, type TemplateIssue } from "./template-lang";

export class TemplateError extends Error {}

export interface TemplateView {
  object: "email_template";
  id: string | null;
  type: EmailType;
  subject: string;
  heading: string;
  body: string;
  /** This email's own footer; null uses `default_footer`. */
  footer: string | null;
  /** What a null `footer` falls back to: the business footer, else the built-in one. */
  default_footer: string;
  /** Button text override; null keeps `default_cta_label`. */
  cta_label: string | null;
  show_facts: boolean;
  block_order: BlockKey[];
  /** The engine's button label, or null when this type never has a button. */
  default_cta_label: string | null;
  /** Whether this type ever carries a facts card. */
  has_facts: boolean;
  /** The built-in wording, so an editor can offer "reset to default" as an unsaved draft. */
  built_in: { subject: string; heading: string; body: string };
  /** False when this is the built-in — i.e. no row exists for this (business, type). */
  customized: boolean;
  /**
   * Set when this type has no override of its own and is using another type's (see
   * INHERITS_FROM): the fields above are that override's, and saving creates this type's own.
   */
  inherits_from: EmailType | null;
  /** Merge variables the outbox actually populates for this type. */
  variables: Array<{ key: string; label: string; always: boolean; sample: string | null }>;
  /**
   * The business's attachment rule for this type (business config, not template wording —
   * so it is NOT part of `customized`). Null when this email is about no document.
   * A `can_*` false means the option does not apply to this type.
   */
  attachments: {
    document: "invoice" | "credit_note";
    pdf: boolean;
    skip_zero_pdf: boolean;
    skip_zero_send: boolean;
    can_skip_zero_pdf: boolean;
    can_skip_zero_send: boolean;
  } | null;
  updated_at: string | null;
}

type Row = typeof emailTemplates.$inferSelect;

function rowToDef(row: Row): TemplateDef {
  return {
    subject: row.subject,
    heading: row.heading,
    body: row.body,
    footer: row.footer,
    ctaLabel: row.ctaLabel,
    showFacts: row.showFacts,
    blockOrder: isBlockOrder(row.blockOrder) ? row.blockOrder : null,
  };
}

function variablesFor(type: EmailType): TemplateView["variables"] {
  return TEMPLATE_VARS[type].map((v) => {
    const sample = (SAMPLE_RENDER_VARS as Record<string, unknown>)[v.key];
    return {
      key: v.key,
      label: VAR_LABELS[v.key] ?? v.key,
      always: v.always,
      sample: typeof sample === "string" ? sample : null,
    };
  });
}

function attachmentsView(type: EmailType, cfg: EmailConfig): TemplateView["attachments"] {
  const rule = attachmentRule(cfg, type);
  const document = EMAIL_DOCUMENT[type];
  if (!rule || !document) return null;
  return {
    document,
    pdf: rule.pdf,
    skip_zero_pdf: rule.skipZeroPdf,
    skip_zero_send: rule.skipZeroSend,
    can_skip_zero_pdf: ZERO_VALUE_PDF_TYPES.has(type),
    can_skip_zero_send: ZERO_VALUE_SEND_TYPES.has(type),
  };
}

function toView(
  type: EmailType,
  row: Row | undefined,
  cfg: EmailConfig,
  inherited?: Row,
): TemplateView {
  const def = row ? rowToDef(row) : inherited ? rowToDef(inherited) : DEFAULT_TEMPLATES[type];
  const caps = templateCapabilities(type);
  return {
    object: "email_template",
    id: row?.publicId ?? null,
    type,
    subject: def.subject,
    heading: def.heading,
    body: def.body,
    footer: def.footer?.trim() || null,
    default_footer: cfg.footerNote ?? DEFAULT_FOOTER,
    cta_label: def.ctaLabel ?? null,
    show_facts: def.showFacts !== false,
    block_order: isBlockOrder(def.blockOrder) ? def.blockOrder : BLOCK_ORDER_DEFAULT,
    default_cta_label: caps.defaultCtaLabel,
    has_facts: caps.hasFacts,
    built_in: {
      subject: DEFAULT_TEMPLATES[type].subject,
      heading: DEFAULT_TEMPLATES[type].heading,
      body: DEFAULT_TEMPLATES[type].body,
    },
    customized: !!row,
    inherits_from: !row && inherited ? (INHERITS_FROM[type] ?? null) : null,
    variables: variablesFor(type),
    attachments: attachmentsView(type, cfg),
    updated_at: row?.updatedAt?.toISOString() ?? null,
  };
}

async function loadConfig(tx: Tx, businessId: string): Promise<EmailConfig> {
  const [biz] = await tx
    .select({ emailConfig: businesses.emailConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return resolveEmailConfig(biz ?? null);
}

/** Every problem in a draft, field by field. Errors block a save; warnings don't. */
export function checkTemplate(type: EmailType, def: TemplateDef): TemplateIssue[] {
  const vars = TEMPLATE_VARS[type];
  return [
    ...checkField("subject", def.subject, vars),
    ...checkField("heading", def.heading, vars),
    ...checkField("body", def.body, vars),
    ...(def.footer ? checkField("footer", def.footer, vars) : []),
    ...(def.ctaLabel ? checkField("cta_label", def.ctaLabel, vars) : []),
  ];
}

function assertType(type: string): asserts type is EmailType {
  if (!EMAIL_TYPES.includes(type as EmailType)) {
    throw new TemplateError(`Unknown email type '${type}'. Known types: ${EMAIL_TYPES.join(", ")}`);
  }
}

/**
 * The render-path lookup, used by the outbox. Returns null when the business has not
 * customised this type, which renderEmail treats as "use the built-in".
 *
 * Takes a Tx because the outbox calls it inside the same transaction that inserts the
 * message row — a template read that could see a different snapshot than the enqueue
 * would let an edit land between the two.
 */
export async function loadTemplateOverride(
  tx: Tx,
  businessId: string,
  type: EmailType,
): Promise<TemplateDef | null> {
  const [row] = await tx
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.type, type)))
    .limit(1);
  if (row) return rowToDef(row);
  // Split out of invoice_issued: a business that customised that email keeps its words
  // for offline invoices too, until it customises this one.
  const parent = INHERITS_FROM[type];
  return parent ? loadTemplateOverride(tx, businessId, parent) : null;
}

/** A type that uses another type's override until it has its own. */
export const INHERITS_FROM: Partial<Record<EmailType, EmailType>> = {
  invoice_to_pay: "invoice_issued",
};

/** Every type, built-ins included, so the dashboard can list all five without N calls. */
export async function listTemplates(
  organizationId: string,
  businessId: string,
): Promise<TemplateView[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.businessId, businessId));
    const byType = new Map(rows.map((r) => [r.type, r]));
    const cfg = await loadConfig(tx, businessId);
    return EMAIL_TYPES.map((t) => {
      const parent = INHERITS_FROM[t];
      return toView(t, byType.get(t), cfg, parent ? byType.get(parent) : undefined);
    });
  });
}

export async function getTemplate(
  organizationId: string,
  businessId: string,
  type: string,
): Promise<TemplateView> {
  assertType(type);
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.type, type)))
      .limit(1);
    const parent = INHERITS_FROM[type];
    const [inherited] =
      !row && parent
        ? await tx
            .select()
            .from(emailTemplates)
            .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.type, parent)))
            .limit(1)
        : [];
    return toView(type, row, await loadConfig(tx, businessId), inherited);
  });
}

/**
 * Write a business's override. Upsert on (business_id, type) so two admins saving at once
 * produce one row rather than a unique-violation for whoever lost the race.
 */
export async function upsertTemplate(
  organizationId: string,
  businessId: string,
  type: string,
  input: TemplateDef,
): Promise<TemplateView> {
  assertType(type);
  const subject = input.subject?.trim() ?? "";
  const heading = input.heading?.trim() ?? "";
  // Sanitised on the way IN as well as at render. Storing the cleaned body means the
  // merchant sees on their next edit exactly what their customers will receive, rather
  // than markup that silently disappears at send time. Render sanitises again because
  // rows written before this existed — and rows written by the importer, which
  // calls this service directly — must not be trusted on the way out either.
  // `sanitizeEmailHtml` is idempotent, so the second pass is a no-op on clean input.
  const body = sanitizeEmailHtml(input.body ?? "").trim();
  // Caught here as well as by the CHECK so the merchant gets a sentence naming the field.
  if (!subject) throw new TemplateError("Subject cannot be empty.");
  if (!heading) throw new TemplateError("Heading cannot be empty.");
  // Checked AFTER sanitising: a body of nothing but `<script>` is empty once cleaned,
  // and storing it would trip the not-blank CHECK with a database error instead of a
  // sentence the merchant can act on.
  if (!body) throw new TemplateError("Body cannot be empty.");
  // The sign-in email exists to carry the code; without it the customer cannot sign in.
  if (type === "portal_sign_in_code" && !/\{\{\s*code\s*\}\}/.test(body))
    throw new TemplateError(
      "The body must contain {{code}}. The customer types this code to sign in.",
    );

  const footer = input.footer ? sanitizeEmailHtml(input.footer).trim() || null : null;
  const caps = templateCapabilities(type);
  const ctaLabel = input.ctaLabel?.trim() || null;
  if (ctaLabel && !caps.defaultCtaLabel)
    throw new TemplateError("This email has no button, so it has no button text to set.");
  const showFacts = input.showFacts !== false;
  if (input.blockOrder != null && !isBlockOrder(input.blockOrder))
    throw new TemplateError(
      `Section order must list each of ${BLOCK_ORDER_DEFAULT.join(", ")} once.`,
    );
  const blockOrder = input.blockOrder ?? null;

  // Saving the built-in unchanged is a reset, not a copy: a stored copy would freeze today's
  // wording and stop later improvements to the default from reaching this business.
  const builtIn = DEFAULT_TEMPLATES[type];
  // Not for a type that would otherwise inherit another's override: there, choosing the
  // built-in is a real choice, and removing the row would bring the inherited words back.
  const parent = INHERITS_FROM[type];
  const inheritsNow =
    !!parent &&
    (await withTenant(organizationId, (tx) => loadTemplateOverride(tx, businessId, parent))) !==
      null;
  if (
    !inheritsNow &&
    subject === builtIn.subject.trim() &&
    heading === builtIn.heading.trim() &&
    // A browser form submits line breaks as CRLF, so compare with them normalised.
    (input.body ?? "").replace(/\r\n?/g, "\n").trim() === builtIn.body.trim() &&
    !footer &&
    !ctaLabel &&
    showFacts &&
    (blockOrder === null || blockOrder.join() === BLOCK_ORDER_DEFAULT.join())
  ) {
    return resetTemplate(organizationId, businessId, type);
  }

  const errors = checkTemplate(type, { subject, heading, body, footer, ctaLabel }).filter(
    (i) => i.severity === "error",
  );
  if (errors.length) throw new TemplateError(errors.map((e) => e.message).join(" "));

  return withTenant(organizationId, async (tx) => {
    const [biz] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!biz) throw new TemplateError("Business not found");
    const [row] = await tx
      .insert(emailTemplates)
      .values({
        publicId: publicId("et"),
        organizationId,
        businessId,
        type,
        subject,
        heading,
        body,
        footer,
        ctaLabel,
        showFacts,
        blockOrder,
      })
      .onConflictDoUpdate({
        target: [emailTemplates.businessId, emailTemplates.type],
        set: {
          subject,
          heading,
          body,
          footer,
          ctaLabel,
          showFacts,
          blockOrder,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toView(type, row, await loadConfig(tx, businessId));
  });
}

/**
 * Reset to the built-in — a DELETE, because absence is what "not customised" means here.
 * Returns the built-in view, so the caller re-renders the default rather than an empty form.
 */
export async function resetTemplate(
  organizationId: string,
  businessId: string,
  type: string,
): Promise<TemplateView> {
  assertType(type);
  const cfg = await withTenant(organizationId, async (tx) => {
    await tx
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.type, type)));
    return loadConfig(tx, businessId);
  });
  return toView(type, undefined, cfg);
}

/**
 * Render without sending, and without saving.
 *
 * `draft` lets the editor preview unsaved edits — the merchant sees what they are typing,
 * not what is stored. Omit it to preview whatever is currently in effect.
 */
export async function previewTemplate(
  organizationId: string,
  businessId: string,
  type: string,
  draft?: Partial<TemplateDef>,
): Promise<RenderedEmail & { customized: boolean; issues: TemplateIssue[] }> {
  assertType(type);
  return withTenant(organizationId, async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!biz) throw new TemplateError("Business not found");
    const stored = await loadTemplateOverride(tx, businessId, type);
    const base = stored ?? DEFAULT_TEMPLATES[type];
    const def: TemplateDef = {
      subject: draft?.subject?.trim() || base.subject,
      heading: draft?.heading?.trim() || base.heading,
      body: draft?.body?.trim() || base.body,
      footer: draft && "footer" in draft ? draft.footer : base.footer,
      ctaLabel: draft && "ctaLabel" in draft ? draft.ctaLabel : base.ctaLabel,
      showFacts: draft?.showFacts ?? base.showFacts,
      blockOrder: draft?.blockOrder ?? base.blockOrder,
    };
    // The preview must be the WHOLE email, blocks included. Sample vars alone produced a
    // preview with no facts card, no typed action button and no sign-off — so the editor
    // showed a shape the customer would never receive, while telling the merchant it was
    // exactly what sends. `blocksFor` is the same function the outbox uses, so the two
    // cannot drift.
    const previewVars: RenderVars = {
      ...sampleVarsFor(type),
      // Shows an invoice email's "Pay now" button, which a real send carries only for an
      // invoice that is not collected automatically — otherwise its label is uneditable
      // blind.
      invoicePayable: true,
      businessName: biz.name,
      // Brand Styles (0185) — the preview must render the REAL brand, not the
      // unbranded shell. A preview that omits the logo is a preview of an email
      // nobody will receive.
      logoUrl: biz.logoUrl ?? undefined,
      iconUrl: biz.iconUrl ?? undefined,
      brandColor: biz.brandColor ?? undefined,
      ...(resolveEmailConfig(biz).footerNote
        ? { footerNote: resolveEmailConfig(biz).footerNote! }
        : {}),
    };
    return {
      ...renderEmail(type, { ...previewVars, ...blocksFor(type, previewVars) }, def),
      customized: !!stored,
      // Reported, not thrown: the editor previews on every keystroke, and a half-typed
      // `{{#if` should show as a message beside the preview, not replace it.
      issues: checkTemplate(type, def),
    };
  });
}
