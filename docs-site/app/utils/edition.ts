import { MARKETING_ROUTES } from "./routes";

/**
 * The edition this site is built for, from NUXT_PUBLIC_EDITION: `cloud` is our public site
 * (marketing pages, pricing, sign-up links); `self_hosted`, the default, is the docs alone.
 * The engine reads the same values from TMBILLING_EDITION.
 */
export type Edition = "cloud" | "self_hosted";

/** Unset means self-hosted; any other value is refused, as the engine refuses it at boot. */
export function parseEdition(value: string | undefined): Edition {
  if (!value || value === "self_hosted") return "self_hosted";
  if (value === "cloud") return "cloud";
  throw new Error(`NUXT_PUBLIC_EDITION must be "cloud" or "self_hosted", not "${value}"`);
}

/** Marketing pages: Cloud only. `/` is not here; a self-hosted build sends it to the docs. */
const MARKETING = MARKETING_ROUTES.filter((r) => r !== "/");

/** Does this site-relative link open a marketing page (`/pricing`, `/product/tax?x#y`)? */
export function isMarketingPath(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/\/+$/, "");
  return MARKETING.some((r) => path === r || path.startsWith(`${r}/`));
}

/**
 * A docs page's markdown for a self-hosted build: a list item that is only a marketing link
 * is dropped (and a Related heading left empty), and any other marketing link keeps
 * its text without the link.
 */
export function stripMarketingLinks(markdown: string): string {
  const link = /\[([^\]\n]+)\]\((\/[^)\s]*)\)/g;
  return markdown
    .split("\n")
    .filter((line) => {
      const m = /^\s*[-*]\s+\[[^\]\n]+\]\((\/[^)\s]*)\)\s*$/.exec(line);
      return !(m && isMarketingPath(m[1]!));
    })
    .join("\n")
    .replace(/^## Related[ \t]*\n(?:[ \t]*\n)*(?=## |(?![\s\S]))/gm, "")
    .replace(link, (all, text: string, href: string) => (isMarketingPath(href) ? text : all));
}
