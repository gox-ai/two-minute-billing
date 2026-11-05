import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml, emailHtmlToText, escapeHtml } from "@/modules/emails/sanitize";

/**
 * The sanitiser is the only thing standing between a merchant-editable body and script
 * running in that merchant's own customers' mail clients. Bodies were plain text until
 * the editor gained rich text (`a,u,p,b,h1,i`), so these tests are the evidence that
 * relaxing the escaping did not reopen the hole.
 */
describe("email body sanitiser", () => {
  describe("backward compatibility with plain-text bodies", () => {
    it("renders a pre-rich-text body exactly as before: escaped, newlines as <br>", () => {
      // Every existing DEFAULT_TEMPLATES body looks like this. If this changes, every
      // built-in email changes shape.
      const body = "Hi Maya,\n\nYour invoice INV-1 is ready.";
      expect(sanitizeEmailHtml(body)).toBe("Hi Maya,<br><br>Your invoice INV-1 is ready.");
    });

    it("escapes text that only looks like markup", () => {
      expect(sanitizeEmailHtml("5 < 6 & 7 > 3")).toBe("5 &lt; 6 &amp; 7 &gt; 3");
    });

    it("leaves merge placeholders untouched so fill() can still find them", () => {
      // The whole security argument depends on this: `{{key}}` survives a sanitise, so
      // the template can be sanitised BEFORE values are substituted (escaped).
      expect(sanitizeEmailHtml("Hi {{customerName}}, you owe {{amount}}.")).toContain(
        "{{customerName}}",
      );
      expect(sanitizeEmailHtml("<p>Hi {{customerName}}</p>")).toBe("<p>Hi {{customerName}}</p>");
    });
  });

  describe("script execution", () => {
    it("drops a script tag AND its content", () => {
      // Keeping the text would print the attack into the customer's email.
      expect(sanitizeEmailHtml("a<script>alert(1)</script>b")).toBe("ab");
    });

    it("drops style content rather than printing CSS at the customer", () => {
      expect(sanitizeEmailHtml("a<style>body{color:red}</style>b")).toBe("ab");
    });

    it("drops an unterminated script to the end of the body", () => {
      expect(sanitizeEmailHtml("safe<script>alert(1)")).toBe("safe");
    });

    it("drops iframe, object and svg content", () => {
      expect(sanitizeEmailHtml('<iframe src="//evil">x</iframe>')).toBe("");
      expect(sanitizeEmailHtml('<object data="//evil">x</object>')).toBe("");
      expect(sanitizeEmailHtml("<svg><script>alert(1)</script></svg>")).toBe("");
    });

    it("strips every attribute, including event handlers, from allowed tags", () => {
      expect(sanitizeEmailHtml('<p onclick="alert(1)" class="x" style="color:red">hi</p>')).toBe(
        "<p>hi</p>",
      );
    });

    it("drops img entirely — no tracking pixels, no unvetted hosts", () => {
      expect(sanitizeEmailHtml('<img src="//evil/pixel.gif" onerror="alert(1)">')).toBe("");
    });
  });

  describe("href schemes", () => {
    const link = (href: string) => sanitizeEmailHtml(`<a href="${href}">click</a>`);

    it("keeps http, https and mailto", () => {
      expect(link("https://apps.example.com")).toBe(
        '<a href="https://apps.example.com" rel="noopener noreferrer">click</a>',
      );
      expect(link("http://apps.example.com")).toContain('href="http://apps.example.com"');
      expect(link("mailto:billing@example.com")).toContain('href="mailto:billing@example.com"');
    });

    it("drops the link but KEEPS the words for javascript:", () => {
      // The sentence is still worth reading; the link is not.
      expect(link("javascript:alert(1)")).toBe("click");
    });

    it("drops an entity-obfuscated javascript: URL", () => {
      // `&#106;` is `j`. A startsWith('javascript:') check waves this through because
      // the browser decodes it and the check did not.
      expect(link("&#106;avascript:alert(1)")).toBe("click");
      expect(link("&#x6a;avascript:alert(1)")).toBe("click");
    });

    it("drops a javascript: URL split by control characters", () => {
      // Mail clients ignore the newline/tab and execute it anyway.
      expect(link("java\nscript:alert(1)")).toBe("click");
      expect(link("java\tscript:alert(1)")).toBe("click");
      expect(link("  javascript:alert(1)")).toBe("click");
    });

    it("drops data: URLs", () => {
      expect(link("data:text/html;base64,PHNjcmlwdD4=")).toBe("click");
    });

    it("drops relative URLs — an email has no document base to resolve against", () => {
      expect(link("/portal")).toBe("click");
      expect(link("portal.html")).toBe("click");
    });

    it("allows an engine-supplied URL variable as a whole href", () => {
      expect(link("{{portalUrl}}")).toBe(
        '<a href="{{portalUrl}}" rel="noopener noreferrer">click</a>',
      );
    });

    it("refuses a variable that is not on the engine-supplied allowlist", () => {
      // `note` is operator-typed; letting it be an href would be a hole.
      expect(link("{{note}}")).toBe("click");
      expect(link("{{customerName}}")).toBe("click");
    });

    it("does not let a quoted > inside an attribute end the tag early", () => {
      const out = sanitizeEmailHtml('<a href="https://x.test/a>b">click</a>');
      expect(out).not.toContain("&gt;b&quot;");
      expect(out).toContain("click");
    });
  });

  describe("structure", () => {
    it("closes tags the merchant left open, so the shell cannot be swallowed", () => {
      expect(sanitizeEmailHtml("<ul><li>a")).toBe("<ul><li>a</li></ul>");
      expect(sanitizeEmailHtml("<b>bold")).toBe("<b>bold</b>");
    });

    it("drops a stray closing tag", () => {
      expect(sanitizeEmailHtml("hello</p>world")).toBe("helloworld");
    });

    it("keeps the words when dropping an unknown tag", () => {
      expect(sanitizeEmailHtml('<span class="x">keep me</span>')).toBe("keep me");
      expect(sanitizeEmailHtml("<div><p>hi</p></div>")).toBe("<p>hi</p>");
    });

    it("normalises tag case", () => {
      expect(sanitizeEmailHtml('<B>bold</B> <A HREF="https://x.test">l</A>')).toBe(
        '<b>bold</b> <a href="https://x.test" rel="noopener noreferrer">l</a>',
      );
    });

    it("drops comments and doctypes", () => {
      expect(sanitizeEmailHtml("a<!-- sneaky -->b")).toBe("ab");
      expect(sanitizeEmailHtml("<!DOCTYPE html>hi")).toBe("hi");
    });

    it("treats an unterminated tag as text", () => {
      expect(sanitizeEmailHtml("a <p")).toBe("a &lt;p");
    });

    it("does not turn source indentation between block tags into blank lines", () => {
      // `</p>\n<p>` is formatting; `Hi\n\nthere` inside a paragraph is content.
      expect(sanitizeEmailHtml("<p>a</p>\n  <p>b</p>")).toBe("<p>a</p><p>b</p>");
      expect(sanitizeEmailHtml("<p>a\n\nb</p>")).toBe("<p>a<br><br>b</p>");
    });

    it("keeps a single space between inline tags", () => {
      expect(sanitizeEmailHtml("<b>a</b> <b>b</b>")).toBe("<b>a</b> <b>b</b>");
    });

    it("survives pathological nesting without unbounded output", () => {
      const out = sanitizeEmailHtml("<b>".repeat(500) + "x");
      expect(out).toContain("x");
      expect(out.length).toBeLessThan(2000);
    });

    it("is idempotent — sanitising twice changes nothing", () => {
      // Not academic: the sanitiser runs at save AND at render, so a non-idempotent
      // one corrupts stored bodies. `5 < 6` became `5 &amp;lt; 6` before this was fixed.
      for (const body of [
        "Hi {{customerName}},\n\nthanks.",
        '<p>Hi <b>there</b></p><a href="https://x.test">link</a>',
        "<script>bad</script><span>ok</span>",
        "5 < 6",
        "Terms &amp; conditions",
        '<a href="https://x.test/a?b=1&c=2">query</a>',
      ]) {
        expect(sanitizeEmailHtml(sanitizeEmailHtml(body))).toBe(sanitizeEmailHtml(body));
      }
    });

    it("preserves an entity the merchant typed instead of double-escaping it", () => {
      expect(sanitizeEmailHtml("Terms &amp; conditions")).toBe("Terms &amp; conditions");
      expect(sanitizeEmailHtml("Save 25% &amp; more")).toBe("Save 25% &amp; more");
    });

    it("leaves quotes alone in text — they only need escaping in an attribute", () => {
      // The body is sanitised on SAVE, so escaping quotes here baked `&#39;` into every
      // stored template and the merchant saw the entities in the editor forever.
      expect(sanitizeEmailHtml("the 'Pay Now' button")).toBe("the 'Pay Now' button");
      expect(sanitizeEmailHtml('a "quoted" word')).toBe('a "quoted" word');
    });

    it("still escapes a quote inside an href, where it WOULD break out", () => {
      const out = sanitizeEmailHtml('<a href="https://x.test/a&quot;onmouseover=alert(1)">x</a>');
      expect(out).not.toMatch(/"\s*onmouseover/);
    });

    it("still escapes a bare ampersand that is not an entity", () => {
      expect(sanitizeEmailHtml("Bell & Co")).toBe("Bell &amp; Co");
      expect(sanitizeEmailHtml("a &notanentity b")).toBe("a &amp;notanentity b");
    });
  });

  describe("plain-text half", () => {
    it("derives text from the sanitised HTML so the two halves agree", () => {
      const html = sanitizeEmailHtml("<p>Hi Maya</p><p>Your invoice is <b>ready</b>.</p>");
      expect(emailHtmlToText(html)).toBe("Hi Maya\nYour invoice is ready.");
    });

    it("marks list items and decodes entities", () => {
      const html = sanitizeEmailHtml("<ul><li>Add users</li><li>Save 25% &amp; more</li></ul>");
      expect(emailHtmlToText(html)).toBe("- Add users\n- Save 25% & more");
    });

    it("carries no markup through", () => {
      expect(emailHtmlToText(sanitizeEmailHtml("<script>x</script><p>hi</p>"))).toBe("hi");
    });
  });

  it("escapeHtml covers the five characters the render path depends on", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
