"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  CornerDownLeft,
  CreditCard,
  Plus,
  Receipt,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { StatusChip } from "@/components/patterns/chip";
import { useDisplayTz } from "@/components/business-tz";
import { cn } from "@/lib/utils";
import { fmtDate, money } from "@/lib/format";
import { businessNavTargets } from "@/lib/business-nav";
import { CREATE_PAGES, PALETTE_PAGES } from "@/lib/palette-pages";
import {
  clearRecent,
  readRecent,
  RECENT_EVENT,
  type RecentKind,
  type RecentRecord,
} from "@/lib/recent-records";
import {
  markPaletteUsed,
  OPEN_EVENT,
  openPalette,
  slashBelongsElsewhere,
  usePaletteKey,
} from "@/lib/palette-hints";
import type { BizRef } from "@/components/AppNav";

export interface CommandAction {
  id: string;
  label: string;
  /** Group heading the action appears under. */
  group?: string;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /** Extra search terms (keywords) beyond the label. */
  keywords?: string[];
  /** Navigate here on select… */
  href?: string;
  /** …or run this. One of href / onSelect should be set. */
  onSelect?: () => void;
}

/** `/api/search` rows. `terms` = the raw fields the engine matched on. */
interface CustomerHit {
  id: string;
  label: string;
  email: string | null;
  company: string | null;
  terms: string[];
}
interface SubscriptionHit {
  id: string;
  label: string;
  customer_name: string | null;
  status: string;
  amount_minor: number | null;
  currency: string;
  interval: string | null;
  renews_at: string | null;
  ends_at: string | null;
  cancelled_at: string | null;
  terms: string[];
}
interface InvoiceHit {
  id: string;
  label: string;
  customer_name: string | null;
  status: string;
  amount_minor: number;
  currency: string;
  due_date: string | null;
  date: string | null;
  terms: string[];
}
interface SearchResults {
  customers: CustomerHit[];
  subscriptions: SubscriptionHit[];
  invoices: InvoiceHit[];
}

type Filter = "all" | "customers" | "subscriptions" | "invoices" | "pages";
const FILTERS: Filter[] = ["all", "customers", "subscriptions", "invoices", "pages"];
const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  customers: "Customers",
  subscriptions: "Subscriptions",
  invoices: "Invoices",
  pages: "Pages",
};

/** Type identity for a record row: icon, tile tone, the word shown in Recent. */
const KIND: Record<RecentKind, { icon: LucideIcon; tile: string; word: string; path: string }> = {
  customer: {
    icon: Users,
    tile: "bg-muted text-muted-foreground",
    word: "Customer",
    path: "customers",
  },
  subscription: {
    icon: CreditCard,
    tile: "bg-muted text-muted-foreground",
    word: "Subscription",
    path: "subscriptions",
  },
  invoice: {
    icon: Receipt,
    tile: "bg-muted text-muted-foreground",
    word: "Invoice",
    path: "invoices",
  },
};
const ID_PREFIX: Record<string, RecentKind> = {
  cus: "customer",
  sub: "subscription",
  inv: "invoice",
};

/** Create pages: the `idle` ones show before typing, the rest only on a match. */
const CREATE = CREATE_PAGES;

/** The Go-to pages shown before typing, by path under the business. */
const MAIN_PAGES = [
  "",
  "/customers",
  "/subscriptions",
  "/invoices",
  "/retries",
  "/reports/dashboards",
  "/catalog/plans",
  "/settings/billing-rules",
];

const INTERVAL_SHORT: Record<string, string> = { day: "day", week: "wk", month: "mo", year: "yr" };
const TERMINAL = new Set(["cancelled", "canceled", "expired"]);
const UNPAID = new Set(["payment_due", "not_paid", "posted", "pending", "open"]);

/** Every whitespace-separated token of `q` appears somewhere in `hay`. */
function matches(q: string, ...hay: Array<string | null | undefined>): boolean {
  const text = hay.filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.includes(t));
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "opened just now";
  if (m < 60) return `opened ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `opened ${h}h ago`;
  return `opened ${Math.round(h / 24)}d ago`;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-card px-1.5 font-sans text-xs font-semibold text-muted-foreground">
      {children}
    </kbd>
  );
}

/** The rail's search row — opens the global palette. Looks like a field because it acts like one. */
export function GoToRow({ className }: { className?: string }) {
  const keys = usePaletteKey();
  const label = keys ? `Search or jump (${keys} or /)` : "Search or jump";
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label={label}
      title={label}
      className={cn(
        "nav-row flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        className,
      )}
    >
      <Search className="size-4 shrink-0" />
      {/* Truncates rather than wraps: the key chip needs the room in a narrow rail. The
          aria-label still names both keys. */}
      <span className="nav-label min-w-0 flex-1 truncate text-left">Search</span>
      {keys ? (
        <kbd
          data-collapse="hide"
          className="shrink-0 rounded-md border border-sidebar-border px-1.5 font-sans text-xs whitespace-nowrap text-muted-foreground"
        >
          {keys}
        </kbd>
      ) : null}
    </button>
  );
}

/** One selectable row. `value` doubles as the key into the palette's href map. */
interface Row {
  value: string;
  href?: string;
  run?: () => void;
  keywords?: string[];
}

const ITEM =
  "gap-3 rounded-lg px-2.5 py-2 data-[selected=true]:bg-info-soft data-[selected=true]:text-foreground";

function GroupHeading({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="tracking-wider uppercase">{title}</span>
      {right ? <span className="ms-auto font-medium normal-case">{right}</span> : null}
    </div>
  );
}

function Tile({ icon: Icon, tone }: { icon: LucideIcon; tone: string }) {
  return (
    <span className={cn("flex size-7.5 shrink-0 items-center justify-center rounded-md", tone)}>
      <Icon className="size-4 text-current" />
    </span>
  );
}

/** A record-shaped row: tile, name over a muted detail, right-hand facts, ↵ when selected. */
function RecordRow({
  row,
  onPick,
  icon,
  tone,
  label,
  detail,
  right,
}: {
  row: Row;
  onPick: (row: Row) => void;
  icon: LucideIcon;
  tone: string;
  label: string;
  detail?: string;
  right?: React.ReactNode;
}) {
  return (
    <CommandItem
      value={row.value}
      keywords={row.keywords}
      onSelect={() => onPick(row)}
      className={cn("group/row", ITEM)}
    >
      <Tile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      {right ? (
        <div className="flex shrink-0 items-center gap-2.5 text-sm whitespace-nowrap text-muted-foreground tabular-nums">
          {right}
        </div>
      ) : null}
      <CornerDownLeft className="invisible size-4 text-primary group-data-[selected=true]/row:visible" />
    </CommandItem>
  );
}

/** A page-shaped row for the two-column grids: icon, label, section on the right. */
function PageRow({
  row,
  onPick,
  icon: Icon,
  label,
  section,
}: {
  row: Row;
  onPick: (row: Row) => void;
  icon?: LucideIcon | null;
  label: string;
  section?: string;
}) {
  return (
    <CommandItem value={row.value} onSelect={() => onPick(row)} className={ITEM}>
      {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
      <span className="min-w-0 truncate text-sm">{label}</span>
      {section ? (
        <span className="ms-auto truncate text-xs text-muted-foreground">{section}</span>
      ) : null}
    </CommandItem>
  );
}

const GRID =
  "[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:gap-x-2 sm:[&_[cmdk-group-items]]:grid-cols-2";
const GROUP =
  "px-2 pt-1.5 pb-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground";

/**
 * Global ⌘K palette. Inside a business: recent records, create actions and pages before
 * typing; live record search (customers / subscriptions / invoices) plus matching pages
 * after. At org level: pages and the businesses list.
 */
export function CommandPalette({
  actions,
  businesses = [],
}: {
  actions: CommandAction[];
  /** Loaded by the layout for the sidebar; reused here so ⌘K can jump between businesses. */
  businesses?: BizRef[];
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<{ q: string; hits: SearchResults } | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [selected, setSelected] = React.useState("");
  const [recent, setRecent] = React.useState<RecentRecord[]>([]);
  const router = useRouter();
  const path = usePathname();
  const tz = useDisplayTz();
  const biz = path.match(/^\/businesses\/([^/]+)/)?.[1];
  const current = biz ? businesses.find((b) => b.id === biz) : undefined;
  const q = query.trim();
  const typing = !!biz && q.length >= 2;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !slashBelongsElsewhere(e)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  React.useEffect(() => {
    if (open) markPaletteUsed();
  }, [open]);

  // Recent is read on open and whenever a detail page records a visit.
  React.useEffect(() => {
    if (!open || !biz) return;
    const load = () => setRecent(readRecent(biz));
    load();
    window.addEventListener(RECENT_EVENT, load);
    return () => window.removeEventListener(RECENT_EVENT, load);
  }, [open, biz]);

  // Debounced entity search within the current business.
  React.useEffect(() => {
    if (!open || !biz || q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    // In flight from the KEYSTROKE, not from the request: the debounce gap is where
    // "no matches" used to render as though it were an answer.
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?biz=${encodeURIComponent(biz)}&q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        if (res.ok) setResults({ q, hits: (await res.json()) as SearchResults });
        setSearching(false);
      } catch {
        // Transient — keep prior results. An abort is the newer query's doing, and that
        // query already owns the in-flight flag.
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, biz, q]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setFilter("all");
    }
  }

  function pick(row: Row) {
    onOpenChange(false);
    if (row.href) router.push(row.href);
    row.run?.();
  }

  /**
   * THE BUSINESS'S OWN PAGES, from the same list the sidebar renders.
   *
   * ⚠️ PERMISSIONS ARE NOT RE-DERIVED HERE. This is client-side and cannot be trusted with a
   * role check, so it passes every perm and relies on the server refusing a destination the
   * operator cannot open — the contract every link in this app has. `testMode` is permissive
   * too: Time Travel elsewhere lands on a page that says it is sandbox-only. To tighten
   * this, pass the real perms down from the layout; do not invent a check in the browser.
   */
  const pageTargets = React.useMemo(
    () =>
      biz
        ? businessNavTargets({
            biz,
            perms: { ops: true, manager: true, admin: true },
            testMode: true,
          })
        : [],
    [biz],
  );

  // Results carry the query they answered, so a slow reply for "joh" cannot render
  // under "john doe" while the newer one is still out.
  const hits = typing && results && results.q === q ? results.hits : null;
  const base = biz ? `/businesses/${biz}` : "";

  const matchedPages: Array<{
    key: string;
    href?: string;
    run?: () => void;
    label: string;
    section?: string;
    icon?: LucideIcon | null;
  }> = typing
    ? [
        ...pageTargets
          .filter((t) => matches(q, t.label, t.section))
          .map((t) => ({
            key: `page:${t.href}`,
            href: t.href,
            label: t.label,
            section: t.section,
            icon: t.icon,
          })),
        ...PALETTE_PAGES.filter((p) => matches(q, p.label, p.section, ...(p.keywords ?? []))).map(
          (p) => {
            const href = p.scope === "biz" ? `${base}${p.path}` : p.path;
            return { key: `page:${href}`, href, label: p.label, section: p.section, icon: null };
          },
        ),
        ...actions
          .filter((a) => matches(q, a.label, ...(a.keywords ?? [])))
          .map((a) => ({
            key: `action:${a.id}`,
            href: a.href,
            run: a.onSelect,
            label: a.label,
            section: a.group,
            icon: null,
          })),
      ].filter((p, i, all) => all.findIndex((o) => o.key === p.key) === i)
    : [];
  const matchedCreate = typing ? CREATE.filter((c) => matches(q, c.label, c.section, "new")) : [];

  const idMatch = biz ? q.match(/^(cus|sub|inv)_[A-Za-z0-9]+$/) : null;
  const idKind = idMatch ? ID_PREFIX[idMatch[1]] : undefined;

  const counts: Record<Filter, number | null> = {
    all: null,
    customers: hits?.customers.length ?? 0,
    subscriptions: hits?.subscriptions.length ?? 0,
    invoices: hits?.invoices.length ?? 0,
    pages: matchedPages.length + matchedCreate.length,
  };
  const perType = filter === "all" ? 2 : 5;
  const show = (f: Filter) => filter === "all" || filter === f;

  // ⌘↵ opens the highlighted row's href in a new tab; this maps cmdk's value back to it.
  const hrefs = new Map<string, string>();
  const reg = (row: Row) => {
    const value = row.value.toLowerCase();
    if (row.href) hrefs.set(value, row.href);
    return { ...row, value };
  };

  const subDetail = (s: SubscriptionHit) => {
    const when = s.cancelled_at
      ? `cancelled ${fmtDate(s.cancelled_at, tz)}`
      : s.ends_at
        ? `ends ${fmtDate(s.ends_at, tz)}`
        : s.renews_at && !TERMINAL.has(s.status)
          ? `renews ${fmtDate(s.renews_at, tz)}`
          : null;
    return [s.customer_name, when].filter(Boolean).join(" · ");
  };
  const invDetail = (i: InvoiceHit) => {
    const when =
      i.due_date && UNPAID.has(i.status)
        ? `due ${fmtDate(i.due_date, tz)}`
        : i.date
          ? fmtDate(i.date, tz)
          : null;
    return [i.customer_name, when].filter(Boolean).join(" · ");
  };

  const openAll = (f: "customers" | "subscriptions" | "invoices", n: number) =>
    filter === "all" ? (
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setFilter(f)}
        className="cursor-pointer text-muted-foreground hover:text-foreground"
      >
        {n} · show all
      </button>
    ) : (
      <Link
        href={`${base}/${f}?q=${encodeURIComponent(q)}`}
        tabIndex={-1}
        onClick={() => onOpenChange(false)}
        className="text-primary hover:underline"
      >
        Open all in {FILTER_LABEL[f]} →
      </Link>
    );

  const recordGroups = hits ? (
    <>
      {show("customers") && hits.customers.length > 0 ? (
        <CommandGroup
          className={GROUP}
          heading={
            <GroupHeading title="Customers" right={openAll("customers", hits.customers.length)} />
          }
        >
          {hits.customers.slice(0, perType).map((c) => (
            <RecordRow
              key={c.id}
              row={reg({
                value: `customer:${c.id}`,
                href: `${base}/customers/${c.id}`,
                keywords: c.terms,
              })}
              onPick={pick}
              icon={KIND.customer.icon}
              tone={KIND.customer.tile}
              label={c.label}
              detail={[c.email, c.company].filter(Boolean).join(" · ") || c.id}
            />
          ))}
        </CommandGroup>
      ) : null}
      {show("subscriptions") && hits.subscriptions.length > 0 ? (
        <CommandGroup
          className={GROUP}
          heading={
            <GroupHeading
              title="Subscriptions"
              right={openAll("subscriptions", hits.subscriptions.length)}
            />
          }
        >
          {hits.subscriptions.slice(0, perType).map((s) => (
            <RecordRow
              key={s.id}
              row={reg({
                value: `subscription:${s.id}`,
                href: `${base}/subscriptions/${s.id}`,
                keywords: s.terms,
              })}
              onPick={pick}
              icon={KIND.subscription.icon}
              tone={KIND.subscription.tile}
              label={s.label}
              detail={subDetail(s)}
              right={
                <>
                  <StatusChip status={s.status} />
                  {s.amount_minor != null && !TERMINAL.has(s.status) ? (
                    <span>
                      {money(s.amount_minor, s.currency)}
                      {s.interval ? ` / ${INTERVAL_SHORT[s.interval] ?? s.interval}` : ""}
                    </span>
                  ) : null}
                </>
              }
            />
          ))}
        </CommandGroup>
      ) : null}
      {show("invoices") && hits.invoices.length > 0 ? (
        <CommandGroup
          className={GROUP}
          heading={
            <GroupHeading title="Invoices" right={openAll("invoices", hits.invoices.length)} />
          }
        >
          {hits.invoices.slice(0, perType).map((i) => (
            <RecordRow
              key={i.id}
              row={reg({
                value: `invoice:${i.id}`,
                href: `${base}/invoices/${i.id}`,
                keywords: i.terms,
              })}
              onPick={pick}
              icon={KIND.invoice.icon}
              tone={KIND.invoice.tile}
              label={i.label}
              detail={invDetail(i)}
              right={
                <>
                  <StatusChip status={i.status} />
                  <span>{money(i.amount_minor, i.currency)}</span>
                </>
              }
            />
          ))}
        </CommandGroup>
      ) : null}
    </>
  ) : null;

  const pagesCap = filter === "all" ? 6 : 50;
  const pageGroups = (
    <>
      {show("pages") && matchedPages.length > 0 ? (
        <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Pages" />}>
          {matchedPages.slice(0, pagesCap).map((p) => (
            <PageRow
              key={p.key}
              row={reg({ value: p.key, href: p.href, run: p.run })}
              onPick={pick}
              icon={p.icon}
              label={p.label}
              section={p.section}
            />
          ))}
        </CommandGroup>
      ) : null}
      {show("pages") && matchedCreate.length > 0 ? (
        <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Create" />}>
          {matchedCreate.map((c) => (
            <PageRow
              key={c.path}
              row={reg({ value: `create:${c.path}`, href: `${base}/${c.path}` })}
              onPick={pick}
              icon={Plus}
              label={c.label}
              section={c.section}
            />
          ))}
        </CommandGroup>
      ) : null}
    </>
  );

  const idRow =
    idKind && typing ? (
      <CommandGroup className={GROUP}>
        <RecordRow
          row={reg({ value: `open:${q}`, href: `${base}/${KIND[idKind].path}/${q}` })}
          onPick={pick}
          icon={KIND[idKind].icon}
          tone={KIND[idKind].tile}
          label={`Open ${q}`}
          detail={`${KIND[idKind].word} id`}
        />
      </CommandGroup>
    ) : null;

  const shownRecords = hits
    ? (show("customers") ? hits.customers.length : 0) +
      (show("subscriptions") ? hits.subscriptions.length : 0) +
      (show("invoices") ? hits.invoices.length : 0)
    : 0;
  const shownPages = show("pages") ? matchedPages.length + matchedCreate.length : 0;
  const nothing = typing && !searching && !!hits && shownRecords + shownPages === 0 && !idRow;

  const noMatches = nothing ? (
    <>
      <div className="px-6 pt-7 pb-4 text-center">
        <div className="text-base font-semibold">No matches for “{q}”</div>
        <div className="mt-1 text-sm text-muted-foreground">
          Search by name, email, company, phone, subscription or invoice number, or paste an id.
        </div>
      </div>
      <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Try" />}>
        <PageRow
          row={reg({ value: "try:customers", href: `${base}/customers` })}
          onPick={pick}
          icon={Users}
          label="All customers"
        />
        <PageRow
          row={reg({ value: "try:invoices", href: `${base}/invoices` })}
          onPick={pick}
          icon={Receipt}
          label="All invoices"
        />
      </CommandGroup>
    </>
  ) : null;

  const idle =
    biz && !typing ? (
      <>
        {recent.length > 0 ? (
          <CommandGroup
            className={GROUP}
            heading={
              <GroupHeading
                title="Recent"
                right={
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => clearRecent(biz)}
                    className="cursor-pointer text-primary hover:underline"
                  >
                    Clear
                  </button>
                }
              />
            }
          >
            {recent.map((r) => (
              <RecordRow
                key={r.id}
                row={reg({ value: `recent:${r.id}`, href: `${base}/${KIND[r.kind].path}/${r.id}` })}
                onPick={pick}
                icon={KIND[r.kind].icon}
                tone={KIND[r.kind].tile}
                label={r.label}
                detail={[KIND[r.kind].word, r.detail].filter(Boolean).join(" · ")}
                right={ago(r.at)}
              />
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Create" />}>
          {CREATE.filter((c) => c.idle).map((c) => (
            <RecordRow
              key={c.path}
              row={reg({ value: `create:${c.path}`, href: `${base}/${c.path}` })}
              onPick={pick}
              icon={Plus}
              tone="bg-muted text-foreground/80"
              label={c.label}
              detail={c.section}
            />
          ))}
        </CommandGroup>
        <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Go to" />}>
          {MAIN_PAGES.map((suffix) => pageTargets.find((t) => t.href === `${base}${suffix}`))
            .filter((t): t is NonNullable<typeof t> => !!t)
            .map((t) => (
              <PageRow
                key={t.href}
                row={reg({ value: `page:${t.href}`, href: t.href })}
                onPick={pick}
                icon={t.icon}
                label={t.label}
                section={t.section}
              />
            ))}
        </CommandGroup>
        <div className="px-5 pt-0.5 pb-2 text-xs text-muted-foreground">
          Type to search every page
        </div>
      </>
    ) : null;

  // Org level: no entity search, so pages and businesses, filtered here.
  const orgRows = !biz
    ? {
        businesses: businesses.filter((b) => matches(q, "business", b.name, b.id)),
        pages: q
          ? PALETTE_PAGES.filter(
              (p) => p.scope === "org" && matches(q, p.label, p.section, ...(p.keywords ?? [])),
            )
          : [],
        // A business page per business, matched on the page AND optionally the business's
        // name ("dunning acme"). Capped: an org with many businesses must not flood the list.
        businessPages: q
          ? businesses
              .flatMap((b) =>
                PALETTE_PAGES.filter((p) => p.scope === "biz")
                  .filter(
                    (p) =>
                      matches(q, p.label, p.section, b.name, ...(p.keywords ?? [])) &&
                      // At least one word must name the PAGE, or typing a business's name
                      // alone would list every one of its settings pages.
                      q
                        .split(/\s+/)
                        .some((t) => matches(t, p.label, p.section, ...(p.keywords ?? []))),
                  )
                  .map((p) => ({ biz: b, page: p })),
              )
              .slice(0, 8)
          : [],
        groups: Array.from(
          actions
            .filter((a) => matches(q, a.label, ...(a.keywords ?? [])))
            .reduce((m, a) => {
              const g = a.group ?? "Actions";
              m.set(g, [...(m.get(g) ?? []), a]);
              return m;
            }, new Map<string, CommandAction[]>()),
        ),
      }
    : null;
  const org = orgRows ? (
    orgRows.businesses.length +
      orgRows.groups.length +
      orgRows.pages.length +
      orgRows.businessPages.length ===
    0 ? (
      <div className="px-6 py-7 text-center text-base font-semibold">No matches for “{q}”</div>
    ) : (
      <>
        {orgRows.businesses.length > 0 ? (
          <CommandGroup className={GROUP} heading={<GroupHeading title="Businesses" />}>
            {orgRows.businesses.map((b) => (
              <PageRow
                key={b.id}
                row={reg({ value: `business:${b.id}`, href: `/businesses/${b.id}` })}
                onPick={pick}
                icon={Building2}
                label={b.name}
                section={b.livemode === "live" ? "Live" : "Test"}
              />
            ))}
          </CommandGroup>
        ) : null}
        {orgRows.groups.map(([group, items]) => (
          <CommandGroup key={group} className={GROUP} heading={<GroupHeading title={group} />}>
            {items.map((a) => (
              <CommandItem
                key={a.id}
                value={reg({ value: `action:${a.id}`, href: a.href }).value}
                onSelect={() => pick({ value: a.id, href: a.href, run: a.onSelect })}
                className={ITEM}
              >
                {a.icon}
                <span className="text-sm">{a.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {orgRows.pages.length > 0 ? (
          <CommandGroup className={cn(GROUP, GRID)} heading={<GroupHeading title="Pages" />}>
            {orgRows.pages.map((p) => (
              <PageRow
                key={p.path}
                row={reg({ value: `page:${p.path}`, href: p.path })}
                onPick={pick}
                icon={null}
                label={p.label}
                section={p.section}
              />
            ))}
          </CommandGroup>
        ) : null}
        {orgRows.businessPages.length > 0 ? (
          <CommandGroup
            className={cn(GROUP, GRID)}
            heading={<GroupHeading title="In a business" />}
          >
            {orgRows.businessPages.map(({ biz: b, page: p }) => {
              const href = `/businesses/${b.id}${p.path}`;
              return (
                <PageRow
                  key={href}
                  row={reg({ value: `page:${href}`, href })}
                  onPick={pick}
                  icon={null}
                  label={p.label}
                  section={b.name}
                />
              );
            })}
          </CommandGroup>
        ) : null}
      </>
    )
  ) : null;

  // cmdk keeps its highlight on a row that is still mounted, so async record groups
  // landing ABOVE the pages would leave a page highlighted. Re-home to the first row.
  const listRef = React.useRef<HTMLDivElement>(null);
  const signature = Array.from(hrefs.keys()).join("|");
  React.useEffect(() => {
    const first = listRef.current?.querySelector("[cmdk-item]");
    setSelected(first?.getAttribute("data-value") ?? "");
  }, [signature, filter]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const href = hrefs.get(selected);
      if (href) window.open(href, "_blank", "noopener");
      return;
    }
    if (e.key === "Tab" && typing) {
      // Stop the dialog's focus trap too: Shift+Tab from the input would move focus to the ×.
      e.preventDefault();
      e.stopPropagation();
      const i = FILTERS.indexOf(filter);
      setFilter(FILTERS[(i + (e.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length]);
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick search"
      description="Search records and jump to pages"
      size="lg"
      commandProps={{
        shouldFilter: false,
        value: selected,
        onValueChange: setSelected,
        onKeyDown,
        loop: true,
      }}
    >
      <CommandInput
        placeholder={
          biz
            ? "Search customers, subscriptions and invoices, or jump to a page"
            : "Jump to a page or a business…"
        }
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          if (v.trim().length < 2) setFilter("all");
        }}
        trailing={
          <>
            {current ? (
              <span className="hidden max-w-56 shrink-0 truncate rounded-md border bg-muted px-2 py-0.5 text-xs text-foreground/80 sm:inline">
                {current.name} · {current.livemode === "live" ? "Live" : "Test"}
              </span>
            ) : null}
            <Kbd>esc</Kbd>
          </>
        }
      />
      {typing ? (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b px-4 py-2.5">
          {FILTERS.map((f) => {
            const n = counts[f];
            return (
              <button
                key={f}
                type="button"
                tabIndex={-1}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center rounded-full border px-3 py-0.5 text-xs font-medium",
                  filter === f
                    ? "border-foreground bg-foreground text-background"
                    : "bg-card text-foreground/80 hover:bg-muted",
                )}
              >
                {FILTER_LABEL[f]}
                {n ? <span className="ms-1.5 opacity-70">{n}</span> : null}
              </button>
            );
          })}
          <span className="ms-auto hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
            <Kbd>Tab</Kbd> next filter
          </span>
        </div>
      ) : null}
      <CommandList ref={listRef} className="max-h-[min(520px,60vh)] py-1">
        {org}
        {idle}
        {typing ? (
          nothing ? (
            noMatches
          ) : (
            <>
              {idRow}
              {searching && !hits ? (
                <div className="px-5 py-3 text-sm text-muted-foreground">Searching…</div>
              ) : null}
              {recordGroups}
              {pageGroups}
            </>
          )
        ) : null}
      </CommandList>
      <div className="flex items-center gap-4 border-t bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="hidden items-center gap-1 sm:inline-flex">
          <Kbd>⌘</Kbd> <Kbd>↵</Kbd> open in new tab
        </span>
        <span className="ms-auto inline-flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </CommandDialog>
  );
}
