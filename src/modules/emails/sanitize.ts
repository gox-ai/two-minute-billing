/**
 * HTML sanitiser for merchant-editable email bodies.
 *
 * Bodies used to be plain text: `renderEmail` escaped the whole template and the only
 * markup in an email came from `brandedShell`. That was safe by construction but it
 * cost us every link, every bold word and every heading — the editor offers
 * `a,u,p,b,h1,i` and 121 of the 62 imported templates' content blocks use them. This
 * file is what makes relaxing that safe.
 *
 * ## The rule that must not be broken
 *
 * `renderEmail` sanitises the TEMPLATE and only then substitutes merge values, still
 * escaped:
 *
 *     fill(sanitizeEmailHtml(def.body), vars, /* escape *​/ true)
 *
 * Never the other way round. Filling first would let a value — a customer's own name,
 * an operator's ad-hoc note — carry markup that this sanitiser then blesses as
 * merchant-authored. Sanitising first works because `{{key}}` uses no character
 * `escapeHtml` touches, so placeholders pass through a sanitise untouched while every
 * substituted value stays escaped. That is the same argument the plain-text version
 * relied on; only the first step changed.
 *
 * ## How it is safe
 *
 * Nothing from the input is ever copied into the output. The tokeniser reads the input
 * and REBUILDS a document from an allowlist: known tags are re-emitted in a normalised
 * form, text is escaped, and everything else — unknown tags, attributes, comments,
 * doctypes, a stray `<` — degrades to escaped text or disappears. A construct this
 * parser fails to understand cannot therefore survive as markup, which is the property
 * a regex-based "strip the bad bits" sanitiser can never have.
 *
 * Output is always balanced: unclosed tags are closed at the end, stray closers are
 * dropped, so a half-finished `<ul>` cannot swallow the shell's footer.
 */

/**
 * What a merchant may write. Deliberately small — this is billing mail, not a page.
 *
 * `img` is NOT here. The logo comes from the shell (Brand Styles, 0185), so an image in
 * the body buys nothing, while a merchant-set image URL in mail is a tracking pixel and
 * a request the recipient's client makes to a host we never vetted.
 */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "h1",
  "h2",
  "ul",
  "ol",
  "li",
  "a",
]);

/** Tags that never have a closing partner, so they are emitted and forgotten. */
const VOID_TAGS = new Set(["br"]);

/**
 * Tags whose CONTENT is dropped along with the tag, rather than kept as text.
 *
 * For everything else "drop the tag, keep the words" is right — an unknown `<span>`
 * around a sentence should still render the sentence. For these it is catastrophic:
 * keeping the text of a `<script>` would print the attack, and keeping the text of a
 * `<style>` would print CSS into the customer's email.
 */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
  "title",
]);

/**
 * Block-level tags. Used only to decide that a newline sitting between two of them is
 * the merchant's source formatting rather than a line break they meant to see.
 */
const BLOCK_TAGS = new Set(["p", "h1", "h2", "ul", "ol", "li"]);

/**
 * Merge variables allowed to be a whole `href`.
 *
 * A template cannot know the customer's portal URL when it is written, so `{{portalUrl}}`
 * has to be linkable. These are ENGINE-supplied values (config / the outbox resolver),
 * never anything a customer or an operator types, which is why they can skip the scheme
 * check that every literal href faces. Adding a var here without checking where it comes
 * from would reintroduce exactly the hole this file exists to close.
 */
const URL_VARS = new Set(["portalUrl", "actionUrl"]);

/** Nesting cap. Pathological input should degrade, not produce megabytes of closers. */
const MAX_DEPTH = 64;

/** Escape text for HTML. The one definition — `templates.ts` imports this. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Escape a TEXT NODE while leaving already-valid entities alone — which is what makes
 * `sanitizeEmailHtml` idempotent.
 *
 * It has to be idempotent because the sanitiser runs twice on purpose: once when the
 * merchant saves, and again at render (rows predate the sanitiser, and the importer
 * writes through the service, not the HTTP API). With a plain `escapeHtml` the second
 * pass turns the stored `5 &lt; 6` into `5 &amp;lt; 6` and the customer receives the
 * markup instead of the sentence.
 *
 * Leaving `&lt;` intact is not a hole: an entity renders as a literal character and can
 * never open a tag. A real `<` in the text is still escaped, every time.
 */
function escapeText(s: string): string {
  // Quotes are deliberately NOT escaped. They only need escaping inside an attribute
  // value, and this is text content — `escapeHtml` still handles the attribute cases
  // (hrefs, and every substituted value, which can land in one).
  //
  // It matters because the body is sanitised on the way IN: escaping quotes here meant a
  // merchant who typed "the 'Pay Now' button" got `the &#39;Pay Now&#39; button` stored,
  // and saw those entities in the editor for the rest of the template's life. The email
  // rendered correctly; the editing experience was quietly ruined.
  return s
    .replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * Decode entities in an attribute VALUE before validating it.
 *
 * `<a href="&#106;avascript:alert(1)">` is a `javascript:` URL that a naive
 * `startsWith('javascript:')` check waves through, because the browser decodes the
 * entity and we did not. Validation has to see what the mail client will see.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code)
        : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Validate an `href`, returning the value to emit or null to drop the link.
 *
 * Only `http:`, `https:` and `mailto:` survive. A relative URL is dropped too: there is
 * no document base in an email, so it can only resolve against the mail client's idea of
 * one — which is nothing useful.
 */
function safeHref(raw: string): string | null {
  const placeholder = raw.trim().match(/^\{\{(\w+)\}\}$/);
  if (placeholder) return URL_VARS.has(placeholder[1]!) ? raw.trim() : null;

  // Strip whitespace AND C0/C1 controls before the scheme test: browsers ignore a
  // `java\nscript:` newline, and a NUL can truncate the string for one reader and not
  // another. Removing them means we test the string every consumer will act on.
  const decoded = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u00a0]/g, "");
  if (!/^(https?:|mailto:)/i.test(decoded)) return null;
  return decoded;
}

/** Pull `href` out of a tag's attribute region. */
function readHref(attrs: string): string | null {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    if (m[1]!.toLowerCase() !== "href") continue;
    return m[2] ?? m[3] ?? m[4] ?? "";
  }
  return null;
}

/** Find a tag's closing `>`, skipping any inside quoted attribute values. */
function findTagEnd(input: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

interface OpenTag {
  name: string;
  /** False when the tag was dropped but its content kept — no closer should be emitted. */
  emitted: boolean;
}

/**
 * Sanitise a merchant-authored email body to the allowlisted subset.
 *
 * Returns balanced HTML safe to place inside `brandedShell`. Plain text in, plain text
 * out (escaped, with newlines as `<br>`) — so a body written before rich text existed
 * renders exactly as it did.
 */
export function sanitizeEmailHtml(input: string): string {
  const out: string[] = [];
  const stack: OpenTag[] = [];
  let i = 0;

  const emitText = (raw: string): void => {
    if (!raw) return;
    if (!raw.trim()) {
      // Whitespace-only. A newline in it means source indentation between block tags
      // (`</p>\n  <p>`), which must not become a visible blank line; anything else is a
      // real space between words (`<b>a</b> <b>b</b>`).
      if (!raw.includes("\n")) out.push(" ");
      return;
    }
    out.push(escapeText(raw).replace(/\r?\n/g, "<br>"));
  };

  const closeTo = (name: string): boolean => {
    const at = stack.map((s) => s.name).lastIndexOf(name);
    if (at === -1) return false; // stray closer — drop it
    for (let d = stack.length - 1; d >= at; d--) {
      if (stack[d]!.emitted) out.push(`</${stack[d]!.name}>`);
    }
    stack.length = at;
    return true;
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      emitText(input.slice(i));
      break;
    }
    emitText(input.slice(i, lt));

    // Comments and declarations carry nothing a customer should read.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input[lt + 1] === "!" || input[lt + 1] === "?") {
      const end = input.indexOf(">", lt + 2);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(input.slice(lt, lt + 32));
    if (!nameMatch) {
      // A `<` that starts no tag — "5 < 6". Literal text.
      emitText("<");
      i = lt + 1;
      continue;
    }

    const end = findTagEnd(input, lt + 1);
    if (end === -1) {
      // Unterminated tag: the rest of the document is text, not markup.
      emitText(input.slice(lt));
      break;
    }

    const isClose = input[lt + 1] === "/";
    const name = nameMatch[1]!.toLowerCase();
    const attrs = input.slice(lt + 1 + nameMatch[1]!.length + (isClose ? 1 : 0), end);
    i = end + 1;

    if (DROP_WITH_CONTENT.has(name)) {
      if (!isClose) {
        // Skip to the matching closer; an unterminated one swallows the remainder,
        // which is the safe direction to fail.
        const close = new RegExp(`</${name}\\s*>`, "i").exec(input.slice(i));
        i = close ? i + close.index + close[0].length : input.length;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) continue; // drop the tag, keep the words

    if (isClose) {
      if (!VOID_TAGS.has(name)) closeTo(name);
      continue;
    }

    if (VOID_TAGS.has(name)) {
      out.push(`<${name}>`);
      continue;
    }

    if (name === "a") {
      const href = readHref(attrs);
      const safe = href === null ? null : safeHref(href);
      if (safe === null) {
        // Keep the anchor TEXT, lose the link. A link to nowhere (or to
        // `javascript:`) is worse than the words on their own.
        stack.push({ name, emitted: false });
        continue;
      }
      if (stack.length >= MAX_DEPTH) {
        stack.push({ name, emitted: false });
        continue;
      }
      stack.push({ name, emitted: true });
      out.push(`<a href="${escapeHtml(safe)}" rel="noopener noreferrer">`);
      continue;
    }

    if (stack.length >= MAX_DEPTH) {
      stack.push({ name, emitted: false });
      continue;
    }
    stack.push({ name, emitted: true });
    out.push(`<${name}>`);
  }

  // Balance whatever the merchant left open.
  for (let d = stack.length - 1; d >= 0; d--) {
    if (stack[d]!.emitted) out.push(`</${stack[d]!.name}>`);
  }

  return out.join("");
}

/**
 * The plain-text half of a rendered email, from the sanitised HTML.
 *
 * Derived from the sanitised markup rather than the raw body so the two halves of a
 * multipart message can never disagree about what the merchant wrote.
 */
export function emailHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h1|h2|li|ul|ol)>/gi, "\n")
      .replace(/<li>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when a body carries markup — used to decide whether an edit needs the HTML editor. */
export function hasMarkup(body: string): boolean {
  return sanitizeEmailHtml(body) !== escapeText(body).replace(/\r?\n/g, "<br>");
}

export const __testing = { safeHref, decodeEntities, BLOCK_TAGS };
