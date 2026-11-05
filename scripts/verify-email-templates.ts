/**
 * Proves the per-business email template store.
 *
 * The load-bearing claim is that the store is ADDITIVE: a business that has never edited a
 * template must render byte-for-byte what it rendered before the table existed, and an
 * override must actually reach the send path rather than sitting in a table nobody reads.
 * Both are asserted here, along with the sparse-store semantics (absence = built-in, reset
 * = delete) and cross-business isolation.
 *
 *   pnpm verify:email-templates
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { businesses, emailTemplates } from "@db/schema";
import { EMAIL_TYPES } from "@/modules/emails/config";
import { DEFAULT_TEMPLATES, renderEmail } from "@/modules/emails/templates";
import {
  listTemplates,
  getTemplate,
  upsertTemplate,
  resetTemplate,
  previewTemplate,
  TemplateError,
} from "@/modules/emails/template-service";
import { sendTestEmail } from "@/modules/emails/smtp-service";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}

const captured: OutboundEmail[] = [];
// `target: null` — an in-process fake reaches no network, so it can never be circuit-broken.
setMailer({
  kind: "console",
  target: null,
  async send(msg) {
    captured.push(msg);
    return { providerMessageId: "fake", status: "sent" };
  },
});

async function newBusiness(name: string) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ emailConfig: { enabled: true } })
      .where(eq(businesses.id, biz.id)),
  );
  return { orgId, bizId: biz.id, name };
}

async function main() {
  const a = await newBusiness("Templates A");
  const b = await newBusiness("Templates B");

  // ── 1. An untouched business renders the built-in ───────────────────────────
  const fresh = await getTemplate(a.orgId, a.bizId, "invoice_issued");
  ok("an untouched type reports customized:false", fresh.customized === false);
  ok("an untouched type has no override id", fresh.id === null);
  ok(
    "an untouched type returns the built-in wording",
    fresh.subject === DEFAULT_TEMPLATES.invoice_issued.subject,
    fresh.subject,
  );

  const all = await listTemplates(a.orgId, a.bizId);
  ok(
    "list returns every email type, not only customised ones",
    all.length === EMAIL_TYPES.length,
    all.length,
  );
  ok(
    "list marks all of them as built-ins initially",
    all.every((t) => !t.customized),
  );
  ok(
    "list advertises merge variables per type",
    all.every((t) => t.variables.length > 0),
  );
  // A variable the outbox never populates would render empty in real mail — the editor
  // must not offer one. Every advertised key has to exist on the built-in's var contract.
  const invoiceVars = all.find((t) => t.type === "invoice_issued")!.variables.map((v) => v.key);
  ok(
    "invoice_issued advertises invoiceNumber as always present",
    invoiceVars.includes("invoiceNumber"),
  );
  ok(
    "payment_receipt marks invoiceNumber as conditional",
    all.find((t) => t.type === "payment_receipt")!.variables.find((v) => v.key === "invoiceNumber")
      ?.always === false,
  );

  // ── 2. Upsert ───────────────────────────────────────────────────────────────
  const saved = await upsertTemplate(a.orgId, a.bizId, "invoice_issued", {
    subject: "Invoice {{invoiceNumber}} — {{businessName}}",
    heading: "Your invoice",
    body: "Hello {{customerName}}, you owe {{amount}}.",
  });
  ok("upsert marks the type customized", saved.customized === true);
  ok("upsert assigns an et_ public id", !!saved.id?.startsWith("et_"), saved.id);

  const again = await upsertTemplate(a.orgId, a.bizId, "invoice_issued", {
    subject: "Invoice {{invoiceNumber}} v2",
    heading: "Your invoice",
    body: "Hello {{customerName}}.",
  });
  ok(
    "a second save updates in place rather than creating a duplicate",
    again.id === saved.id,
    `${saved.id} → ${again.id}`,
  );
  const [count] = await withTenant(a.orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailTemplates)
      .where(eq(emailTemplates.businessId, a.bizId)),
  );
  ok("exactly one row exists for the edited type", count?.n === 1, count?.n);

  // ── 3. Validation, at the service and at the column ─────────────────────────
  let threw: unknown;
  try {
    await upsertTemplate(a.orgId, a.bizId, "invoice_issued", {
      subject: "   ",
      heading: "h",
      body: "b",
    });
  } catch (e) {
    threw = e;
  }
  ok("a blank subject is rejected", threw instanceof TemplateError, (threw as Error)?.message);

  let badType: unknown;
  try {
    await getTemplate(a.orgId, a.bizId, "not_a_type");
  } catch (e) {
    badType = e;
  }
  ok("an unknown email type is rejected", badType instanceof TemplateError);

  let dbRejected = false;
  try {
    await systemDb.execute(
      sql`UPDATE email_templates SET body = '   ' WHERE business_id = ${a.bizId}`,
    );
  } catch {
    dbRejected = true;
  }
  ok("the DB CHECK rejects a blank body independently of the service", dbRejected);

  // ── 4. The override actually reaches the send path ──────────────────────────
  // This is the point of the whole feature. sendTestEmail renders through the same
  // loadTemplateOverride the outbox uses, so a pass here means the store is wired in.
  captured.length = 0;
  const test = await sendTestEmail(a.orgId, a.bizId, { to: "ops@a.test", type: "invoice_issued" });
  ok("test send succeeded", test.ok, test.error);
  const sentSubject = captured.at(-1)?.subject ?? "";
  ok("the CUSTOM subject was sent, not the built-in", sentSubject.includes("v2"), sentSubject);
  ok(
    "the built-in subject was not used",
    !sentSubject.includes(DEFAULT_TEMPLATES.invoice_issued.heading),
  );

  // A type the business did NOT customise must still render the built-in.
  captured.length = 0;
  await sendTestEmail(a.orgId, a.bizId, { to: "ops@a.test", type: "payment_receipt" });
  ok(
    "an uncustomised type still renders the built-in",
    (captured.at(-1)?.subject ?? "").includes("Payment received"),
    captured.at(-1)?.subject,
  );

  // ── 5. Isolation: one business's template must not leak to another ──────────
  const bView = await getTemplate(b.orgId, b.bizId, "invoice_issued");
  ok(
    "another business still sees the built-in",
    bView.customized === false && bView.subject === DEFAULT_TEMPLATES.invoice_issued.subject,
  );

  // ── 6. Preview renders without sending or saving ────────────────────────────
  captured.length = 0;
  const preview = await previewTemplate(b.orgId, b.bizId, "payment_failed", {
    subject: "Draft subject for {{customerName}}",
    body: "Draft body {{amount}}",
  });
  ok("preview sends nothing", captured.length === 0);
  ok(
    "preview renders the unsaved draft",
    preview.subject.includes("Sample Customer"),
    preview.subject,
  );
  ok(
    "preview substitutes variables in the body",
    preview.text.includes("$4,999.00"),
    preview.text.slice(0, 80),
  );
  ok("preview reports the stored state, not the draft", preview.customized === false);
  const stillDefault = await getTemplate(b.orgId, b.bizId, "payment_failed");
  ok("preview did not persist the draft", stillDefault.customized === false);

  // Merchant-authored markup is sanitised into the HTML body. Without this, one merchant's
  // template edit becomes script running in their own customers' mail clients.
  //
  // Bodies carry rich text (the editor offers `a,u,p,b,h1,i`), so the body is no longer
  // escaped wholesale — it goes through `sanitizeEmailHtml`.
  // A `<script>` is now dropped WITH its content rather than escaped into view: this
  // assertion used to require the escaped text stay visible, which meant we printed
  // `<script>alert(1)</script>` into a customer's billing email. Silently swallowing
  // ordinary content would still be wrong, so that half is asserted below on a tag that
  // is merely unknown rather than dangerous.
  const injected = await previewTemplate(b.orgId, b.bizId, "payment_receipt", {
    body: "Hi <script>alert(1)</script> {{customerName}}",
  });
  ok(
    "HTML in a template body is sanitised, not emitted raw",
    !injected.html.includes("<script>"),
    injected.html.slice(0, 160),
  );
  ok(
    "a script is dropped with its content, not printed at the customer",
    !injected.html.includes("alert(1)") && !injected.text.includes("alert(1)"),
    injected.text.slice(0, 120),
  );
  ok(
    "the surrounding words survive",
    injected.html.includes("Hi") && injected.html.includes("Sample Customer"),
  );

  const kept = await previewTemplate(b.orgId, b.bizId, "payment_receipt", {
    body: 'Hi <span class="x">keep me</span> and <a href="https://apps.example.com">link me</a>',
  });
  ok(
    "an unknown tag is dropped but its words are kept",
    kept.html.includes("keep me"),
    kept.html.slice(0, 200),
  );
  ok(
    "an allowlisted link survives with a safe href",
    kept.html.includes('href="https://apps.example.com"'),
    kept.html.slice(0, 240),
  );

  const badLink = await previewTemplate(b.orgId, b.bizId, "payment_receipt", {
    body: 'Hi <a href="javascript:alert(1)">click</a>',
  });
  ok(
    "a javascript: link loses the link but keeps the words",
    !badLink.html.includes("javascript:") && badLink.html.includes("click"),
    badLink.html.slice(0, 200),
  );

  // ── 7. Reset is a delete ────────────────────────────────────────────────────
  const reset = await resetTemplate(a.orgId, a.bizId, "invoice_issued");
  ok(
    "reset returns the built-in",
    reset.customized === false && reset.subject === DEFAULT_TEMPLATES.invoice_issued.subject,
  );
  const [after] = await withTenant(a.orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailTemplates)
      .where(eq(emailTemplates.businessId, a.bizId)),
  );
  ok("reset removes the row rather than rewriting it", after?.n === 0, after?.n);

  captured.length = 0;
  await sendTestEmail(a.orgId, a.bizId, { to: "ops@a.test", type: "invoice_issued" });
  ok(
    "after reset the built-in is sent again",
    !(captured.at(-1)?.subject ?? "").includes("v2"),
    captured.at(-1)?.subject,
  );

  // ── 8. Template language + layout ───────────────────────────────────────────
  let rejected = "";
  try {
    await upsertTemplate(a.orgId, a.bizId, "invoice_issued", {
      subject: "Hi {{planName}}",
      heading: "H",
      body: "B",
    });
  } catch (e) {
    rejected = e instanceof TemplateError ? e.message : "";
  }
  ok("a variable the email never has is refused on save", rejected.includes("planName"), rejected);

  rejected = "";
  try {
    await upsertTemplate(a.orgId, a.bizId, "invoice_issued", {
      subject: "{{#if invoiceNumber}}open",
      heading: "H",
      body: "B",
    });
  } catch (e) {
    rejected = e instanceof TemplateError ? e.message : "";
  }
  ok("an unclosed section is refused on save", rejected.includes("never closed"), rejected);

  rejected = "";
  try {
    await upsertTemplate(a.orgId, a.bizId, "subscription_canceled", {
      ...DEFAULT_TEMPLATES.subscription_canceled,
      ctaLabel: "Click",
    });
  } catch (e) {
    rejected = e instanceof TemplateError ? e.message : "";
  }
  ok("button text on an email with no button is refused", rejected.includes("no button"), rejected);

  const laid = await upsertTemplate(a.orgId, a.bizId, "payment_failed", {
    ...DEFAULT_TEMPLATES.payment_failed,
    ctaLabel: "Settle {{amount}}",
    showFacts: false,
    blockOrder: ["action", "body", "facts", "footer"],
  });
  ok(
    "layout round-trips through the store",
    laid.cta_label === "Settle {{amount}}" &&
      laid.show_facts === false &&
      laid.block_order.join() === "action,body,facts,footer",
    laid,
  );
  ok(
    "the view says which layout controls apply",
    laid.default_cta_label === "Pay now" && laid.has_facts === true,
  );

  captured.length = 0;
  await sendTestEmail(a.orgId, a.bizId, { to: "ops@a.test", type: "payment_failed" });
  const laidHtml = captured.at(-1)?.html ?? "";
  ok(
    "the outbox render path applies the stored layout",
    laidHtml.includes("Settle $") &&
      !laidHtml.includes("Invoiced amount") &&
      laidHtml.indexOf("Settle") < laidHtml.indexOf("Hi Sample"),
    laidHtml.slice(0, 400),
  );

  const draftPreview = await previewTemplate(a.orgId, a.bizId, "payment_failed", {
    subject: "Hi {{invoiceNumber}} {{nope}}",
  });
  ok(
    "a preview reports problems instead of failing",
    draftPreview.issues.some((i) => i.severity === "error" && i.message.includes("nope")) &&
      draftPreview.issues.some((i) => i.severity === "warning"),
    draftPreview.issues,
  );

  captured.length = 0;
  await sendTestEmail(a.orgId, a.bizId, {
    to: "ops@a.test",
    type: "payment_failed",
    draft: {
      ...DEFAULT_TEMPLATES.payment_failed,
      subject: 'Draft {{customerName | default: "x"}}',
    },
  });
  ok(
    "a test send can send an unsaved draft",
    (captured.at(-1)?.subject ?? "").includes("Draft Sample Customer"),
    captured.at(-1)?.subject,
  );
  await resetTemplate(a.orgId, a.bizId, "payment_failed");

  // Saving the built-in unchanged is a reset, not a frozen copy.
  await upsertTemplate(a.orgId, a.bizId, "trial_started", {
    subject: "Custom",
    heading: "H",
    body: "B",
  });
  // CRLF, as a browser form posts it.
  const backToDefault = await upsertTemplate(a.orgId, a.bizId, "trial_started", {
    ...DEFAULT_TEMPLATES.trial_started,
    body: DEFAULT_TEMPLATES.trial_started.body.replace(/\n/g, "\r\n"),
  });
  const [left] = await withTenant(a.orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.businessId, a.bizId), eq(emailTemplates.type, "trial_started"))),
  );
  ok(
    "saving the untouched default removes the override",
    backToDefault.customized === false && left?.n === 0,
    left?.n,
  );

  // ── 9. renderEmail's own fallback contract ──────────────────────────────────
  const vars = { businessName: "Acme", customerName: "Pat" };
  ok(
    "renderEmail with no override equals renderEmail with null override",
    JSON.stringify(renderEmail("payment_receipt", vars)) ===
      JSON.stringify(renderEmail("payment_receipt", vars, null)),
  );

  console.log(`\n${fail === 0 ? "✅" : "❌"} email templates: ${pass} passed, ${fail} failed`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
