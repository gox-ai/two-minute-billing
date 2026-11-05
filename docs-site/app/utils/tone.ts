/**
 * The colour a page or product area takes on the site, by meaning (marketing.css): running
 * billing is cyan, money won and growth is lime, everything else is neutral.
 */
const GROWTH = new Set(["/product/recovery", "/product/reporting"]);

export function toneClass(path: string): "mk-billing" | "mk-growth" | "mk-plain" {
  const p = path.replace(/\/+$/, "");
  if (GROWTH.has(p)) return "mk-growth";
  if (p.startsWith("/product/")) return "mk-billing";
  return "mk-plain";
}
