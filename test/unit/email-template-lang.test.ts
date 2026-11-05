import { describe, it, expect } from "vitest";
import { renderBody, renderText, checkField } from "@/modules/emails/template-lang";
import {
  renderEmail,
  DEFAULT_TEMPLATES,
  SAMPLE_RENDER_VARS,
  blocksFor,
  type RenderVars,
} from "@/modules/emails/templates";

const VARS = [
  { key: "customerName", always: true },
  { key: "invoiceNumber", always: false },
];

describe("template language — rendering", () => {
  it("fills a value, escaped in the body", () => {
    expect(renderBody("Hi {{customerName}}", { customerName: "<b>Ann</b>" })).toBe(
      "Hi &lt;b&gt;Ann&lt;/b&gt;",
    );
  });

  it("uses the fallback only when the value is empty", () => {
    const t = 'Hi {{customerName | default: "there"}}';
    expect(renderText(t, { customerName: "Ann" })).toBe("Hi Ann");
    expect(renderText(t, { customerName: "  " })).toBe("Hi there");
    expect(renderText(t, {})).toBe("Hi there");
  });

  it("shows an if-section only when its value is present, else the else-branch", () => {
    const t = "Paid{{#if invoiceNumber}} for {{invoiceNumber}}{{else}} in full{{/if}}.";
    expect(renderText(t, { invoiceNumber: "INV-1" })).toBe("Paid for INV-1.");
    expect(renderText(t, {})).toBe("Paid in full.");
  });

  it("unless is the inverse, and sections nest", () => {
    const t = "{{#unless a}}no-a{{#if b}}+b{{/if}}{{/unless}}";
    expect(renderText(t, {})).toBe("no-a");
    expect(renderText(t, { b: "1" })).toBe("no-a+b");
    expect(renderText(t, { a: "1", b: "1" })).toBe("");
  });

  it("a hidden paragraph-level section leaves no empty paragraph behind", () => {
    const t =
      "<p>One</p><p>{{#if invoiceNumber}}</p><p>Two {{invoiceNumber}}</p><p>{{/if}}</p><p>Three</p>";
    expect(renderBody(t, {})).toBe("<p>One</p><p>Three</p>");
    expect(renderBody(t, { invoiceNumber: "INV-1" })).toBe(
      "<p>One</p><p>Two INV-1</p><p>Three</p>",
    );
  });

  it("a hidden line-level section in a plain-text body leaves no blank line", () => {
    const t = "One\n{{#if invoiceNumber}}\nTwo\n{{/if}}\nThree";
    expect(renderBody(t, {})).toBe("One<br>Three");
  });

  it("a value cannot open a section or smuggle markup", () => {
    const out = renderBody("Hi {{customerName}}", {
      customerName: "{{#if x}}<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>");
  });

  it("a fallback in the body cannot carry a tag", () => {
    expect(checkField("body", '{{invoiceNumber | default: "<b>x</b>"}}', VARS)[0]?.severity).toBe(
      "error",
    );
  });
});

describe("an empty value on its own line", () => {
  const note = [{ key: "note", always: false }];
  it("disappears instead of leaving a gap", () => {
    expect(renderBody("Hi Ann,\n\n{{note}}\n\nHere it is.", {})).toBe("Hi Ann,<br><br>Here it is.");
    expect(renderBody("<p>Hi</p><p>{{note}}</p><p>Bye</p>", {})).toBe("<p>Hi</p><p>Bye</p>");
  });
  it("renders normally when set", () => {
    expect(renderBody("Hi Ann,\n\n{{note}}\n\nHere it is.", { note: "Thanks!" })).toBe(
      "Hi Ann,<br><br>Thanks!<br><br>Here it is.",
    );
  });
  it("needs no guard, but a value mid-sentence still does", () => {
    expect(checkField("body", "Hi,\n\n{{note}}\n\nRest", note)).toEqual([]);
    expect(checkField("body", "Hi, {{note}} rest", note)[0]?.severity).toBe("warning");
  });
});

describe("template language — checks", () => {
  it("rejects a variable this email never has", () => {
    const issues = checkField("subject", "Hi {{planName}}", VARS);
    expect(issues).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("planName") }),
    ]);
  });

  it("rejects unbalanced sections", () => {
    expect(checkField("subject", "{{#if invoiceNumber}}x", VARS)[0]?.severity).toBe("error");
    expect(checkField("subject", "x{{/if}}", VARS)[0]?.severity).toBe("error");
    expect(checkField("subject", "{{#if invoiceNumber}}x{{/unless}}", VARS)[0]?.severity).toBe(
      "error",
    );
  });

  it("rejects a section that straddles formatting", () => {
    const issues = checkField("body", "<b>{{#if invoiceNumber}}x</b>{{/if}}", VARS);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("warns about a sometimes-empty value used bare, but not when guarded", () => {
    expect(checkField("subject", "Invoice {{invoiceNumber}}", VARS)).toEqual([
      expect.objectContaining({ severity: "warning" }),
    ]);
    expect(checkField("subject", '{{invoiceNumber | default: "n/a"}}', VARS)).toEqual([]);
    expect(checkField("subject", "{{#if invoiceNumber}}{{invoiceNumber}}{{/if}}", VARS)).toEqual(
      [],
    );
  });

  it("every built-in template is free of errors and warnings", async () => {
    const { TEMPLATE_VARS } = await import("@/modules/emails/templates");
    for (const [type, def] of Object.entries(DEFAULT_TEMPLATES)) {
      const vars = TEMPLATE_VARS[type as keyof typeof TEMPLATE_VARS];
      for (const f of ["subject", "heading", "body", "footer"] as const) {
        // Warnings too: a built-in must never render a hole for any customer.
        expect(checkField(f, def[f] ?? "", vars), `${type}.${f}`).toEqual([]);
      }
    }
  });
});

describe("layout", () => {
  const vars = (): RenderVars => {
    const v: RenderVars = { ...SAMPLE_RENDER_VARS, businessName: "Acme" };
    return { ...v, ...blocksFor("payment_failed", v) };
  };

  it("the default order is body, button, facts", () => {
    const { html } = renderEmail("payment_failed", vars());
    expect(html.indexOf("Pay now")).toBeLessThan(html.indexOf("Invoiced amount"));
  });

  it("honours a custom order, button label and hidden facts — in html and text", () => {
    const def = {
      ...DEFAULT_TEMPLATES.payment_failed,
      ctaLabel: "Settle {{amount}}",
      blockOrder: ["facts", "body", "action", "footer"] as const,
    };
    const { html, text } = renderEmail("payment_failed", vars(), {
      ...def,
      blockOrder: [...def.blockOrder],
    });
    expect(html).toContain("Settle $4,999.00");
    expect(html.indexOf("Invoiced amount")).toBeLessThan(html.indexOf("Settle"));
    expect(text.indexOf("Invoiced amount")).toBeLessThan(text.indexOf("Settle"));

    const hidden = renderEmail("payment_failed", vars(), {
      ...def,
      blockOrder: null,
      showFacts: false,
    });
    expect(hidden.html).not.toContain("Invoiced amount");
    expect(hidden.text).not.toContain("Invoiced amount");
  });

  it("the footer comes after the button and the details card, in html and text", () => {
    const { html, text } = renderEmail("payment_failed", vars(), {
      ...DEFAULT_TEMPLATES.payment_failed,
      footer: "Cheers from {{businessName}}",
    });
    expect(html.indexOf("Cheers from Acme")).toBeGreaterThan(html.indexOf("Invoiced amount"));
    expect(html.indexOf("Cheers from Acme")).toBeGreaterThan(html.indexOf("Pay now"));
    expect(text.trimEnd().endsWith("Cheers from Acme")).toBe(true);
  });

  it("the footer: the email's own, else the business's, else the built-in", () => {
    const base = DEFAULT_TEMPLATES.payment_failed;
    const own = renderEmail(
      "payment_failed",
      { ...vars(), footerNote: "Biz footer" },
      { ...base, footer: "Own" },
    );
    expect(own.html).toContain("Own");
    expect(own.html).not.toContain("Biz footer");
    const biz = renderEmail("payment_failed", {
      ...vars(),
      footerNote: "Biz footer for {{customerName}}",
    });
    expect(biz.text.trimEnd().endsWith("Biz footer for Sample Customer")).toBe(true);
    const builtIn = renderEmail("payment_failed", vars());
    expect(builtIn.text.trimEnd().endsWith("Thanks,\nAcme team")).toBe(true);
  });

  it("the footer can move above the message", () => {
    const { html, text } = renderEmail("payment_failed", vars(), {
      ...DEFAULT_TEMPLATES.payment_failed,
      footer: "Foot",
      blockOrder: ["footer", "body", "action", "facts"],
    });
    expect(html.indexOf("Foot")).toBeLessThan(html.indexOf("Hi Sample"));
    expect(text.startsWith("Foot\n\nHi Sample")).toBe(true);
  });

  it("a button label never adds a button to an email that has none", () => {
    const v: RenderVars = { ...SAMPLE_RENDER_VARS, businessName: "Acme" };
    const { html } = renderEmail(
      "subscription_canceled",
      { ...v, ...blocksFor("subscription_canceled", v) },
      { ...DEFAULT_TEMPLATES.subscription_canceled, ctaLabel: "Click" },
    );
    expect(html).not.toContain("Click");
  });
});
