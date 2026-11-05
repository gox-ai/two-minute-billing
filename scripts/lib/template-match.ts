/**
 * Invert a template: match a rendered string against it and return what each variable
 * rendered as. Built on the engine's own parser, so `{{#if}}` sections and fallbacks are
 * understood (a section becomes an alternation of its two branches). Anchored at both
 * ends: unanchored, a trailing lazy capture matches the empty string and hides the very
 * blank it is meant to catch.
 *
 * A variable inside a branch that did not render is left out of the result, not
 * reported empty.
 */
import { parseTemplate } from "@/modules/emails/template-lang";

type Nodes = ReturnType<typeof parseTemplate>["nodes"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove a template's rendered text from the END of `text` (a paragraph of its own). */
export function stripTemplateTail(text: string, tpl: string | null | undefined): string {
  if (!tpl) return text;
  const m = new RegExp(`\\n\\n${templateSource(tpl, [])}$`).exec(text);
  return m ? text.slice(0, m.index) : text;
}

function templateSource(tpl: string, keys: string[]): string {
  const build = (nodes: Nodes): string =>
    nodes
      .map((n) => {
        if (n.kind === "text") return esc(n.text);
        if (n.kind === "var") {
          keys.push(n.key);
          return "([\\s\\S]*?)";
        }
        return `(?:${build(n.then)}|${build(n.else)})`;
      })
      .join("");
  return build(parseTemplate(tpl).nodes);
}

export function matchTemplate(tpl: string, rendered: string): Map<string, string[]> | null {
  const keys: string[] = [];
  const source = templateSource(tpl, keys);
  const m = new RegExp(`^${source}$`).exec(rendered);
  if (!m) return null;
  const out = new Map<string, string[]>();
  keys.forEach((k, i) => {
    const v = m[i + 1];
    if (v !== undefined) out.set(k, [...(out.get(k) ?? []), v]);
  });
  return out;
}
