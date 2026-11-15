/**
 * The ⌘K palette's matching, kept pure so it is unit-tested. No imports: the palette's
 * page lists stay in `palette-pages.ts` and `business-nav.ts`.
 */

/** Every whitespace-separated token of `q` appears somewhere in `hay`. */
export function matches(q: string, ...hay: Array<string | null | undefined>): boolean {
  const text = hay.filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.includes(t));
}

export interface OrgBusiness {
  id: string;
  name: string;
  livemode: string;
}

export interface OrgPageTarget {
  href: string;
  label: string;
  section?: string;
  keywords?: string[];
}

export interface OrgPageHit<P extends OrgPageTarget> {
  biz: OrgBusiness;
  page: P;
  /** The business, and Test for a sandbox: the row's right-hand label. */
  scope: string;
  /** The page's label; with its section when another hit of the business has the same label. */
  title: string;
}

/**
 * At organization level, each business's pages: its main pages (Customers, Invoices, …)
 * first, then its other pages. A row matches when every word is in the page or the business
 * name, and at least one word names the PAGE, or typing a business's name alone would list
 * every one of its pages. Live businesses before test ones; capped so an organization with
 * many businesses does not flood the list.
 */
export function orgBusinessPages<P extends OrgPageTarget>(
  q: string,
  businesses: OrgBusiness[],
  pagesOf: (biz: OrgBusiness) => P[],
  cap = 8,
): Array<OrgPageHit<P>> {
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const ordered = [...businesses].sort(
    (a, b) => Number(a.livemode === "test") - Number(b.livemode === "test"),
  );
  const hits: Array<OrgPageHit<P> & { rank: number }> = [];
  for (const b of ordered) {
    const seen = new Set<string>();
    pagesOf(b).forEach((p, i) => {
      if (seen.has(p.href)) return;
      seen.add(p.href);
      const own = [p.label, p.section, ...(p.keywords ?? [])];
      if (!matches(q, ...own, b.name)) return;
      if (!words.some((w) => matches(w, ...own))) return;
      // A word that starts the page's own label ranks first: "customers" → Customers.
      const label = p.label.toLowerCase();
      const head = words.some((w) => label.startsWith(w.toLowerCase())) ? 0 : 1;
      // A top-level page (/businesses/x/customers) before a nested one (a report, a setting).
      const depth = p.href.split("/").filter(Boolean).length > 3 ? 1 : 0;
      hits.push({
        biz: b,
        page: p,
        scope: b.livemode === "test" ? `${b.name} · Test` : b.name,
        title: p.label,
        rank: head * 1e7 + depth * 1e6 + i,
      });
    });
  }
  return hits
    .map((h, n) => ({ h, n }))
    .sort((x, y) => x.h.rank - y.h.rank || x.n - y.n)
    .slice(0, cap)
    .map(({ h }, _n, all) => {
      const twin = all.some(
        (o) => o.h !== h && o.h.biz.id === h.biz.id && o.h.page.label === h.page.label,
      );
      const nested = h.page.href.split("/").filter(Boolean).length > 3;
      const where = nested ? areaOf(h.page.href) : null;
      return {
        biz: h.biz,
        page: h.page,
        scope: h.scope,
        title: twin && where ? `${h.page.label} (${where})` : h.page.label,
      };
    });
}

/** The area a nested page belongs to, from its path: "settings" → "Settings". */
function areaOf(href: string): string | null {
  const seg = href.split("/").filter(Boolean)[2];
  if (!seg) return null;
  const words = seg.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
