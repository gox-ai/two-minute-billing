import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading states, one per PAGE ARCHETYPE.
 *
 * There used to be exactly one — a page header over an 8×5 table shimmer — and
 * all 31 `loading.tsx` files rendered it. On a detail page that promised a table
 * where sections and a right rail were coming; on Business Home it promised a
 * table where twelve charts were coming. A skeleton whose shape disagrees with
 * the page is worse than a spinner: it tells you where to look, and is wrong.
 *
 * So each one mirrors a real archetype (see the `ui` skill): List, Detail,
 * Dashboard, Settings, Form. If you add a route, pick the one its page uses.
 *
 * These are `aria-busy` regions, not decoration — screen readers announce them.
 */

/** The page opener every archetype shares: crumb, title, optional actions. */
function HeaderBones({ actions = 0 }: { actions?: number }) {
  return (
    <div className="mb-8 space-y-2.5">
      <Skeleton className="h-3 w-32" />
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-7 w-64" />
        {actions > 0 ? (
          <div className="flex gap-2">
            {Array.from({ length: actions }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-32" />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A table on its own surface — the same `rounded-xl border bg-card` the real
 * DataTable uses, so the shimmer occupies exactly the box the data will.
 */
function TableBones({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex gap-6 border-b px-4 py-3.5">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 border-b px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            // The first column carries a two-line identity cell in every list we
            // render, so it is taller. Uniform bars read as a different table.
            <div key={c} className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-full" />
              {c === 0 ? <Skeleton className="h-2.5 w-2/3" /> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function KpiBones({ count = 5 }: { count?: number }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="min-h-[104px] rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-7 rounded-md" />
          </div>
          <Skeleton className="mt-3 h-6 w-28" />
          <Skeleton className="mt-2 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** List archetype: toolbar, then a table. `stats` adds a KPI row above it. */
export function ListLoading({
  cols = 5,
  rows = 8,
  stats = 0,
}: {
  cols?: number;
  rows?: number;
  stats?: number;
}) {
  return (
    <div aria-busy="true" aria-label="Loading list">
      <HeaderBones actions={2} />
      {stats > 0 ? <KpiBones count={stats} /> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="ms-auto h-8 w-40" />
      </div>
      <TableBones rows={rows} cols={cols} />
    </div>
  );
}

/**
 * Detail archetype: section cards, with EITHER rail opt-in.
 *
 * ⚠️ Both rails default to OFF, and that is the whole point. The first version
 * drew both unconditionally, because the routes were classified by "does the page
 * import SectionCard" — which is true of any panel stack. Measured on the running
 * app, of the fifteen routes assigned this archetype only THREE have both rails:
 *
 *   left + right   customers/[cus], subscriptions/[sub], payment_intents/[pi]
 *   right only     invoices/[inv]
 *   left only      ops
 *   neither        transactions/[txn], events/[evt], audit/[id], time_travel,
 *                  developer, developer/webhooks/[id], parity, …
 *
 * So ten pages promised two columns that never arrived — the reported "unrelated
 * skeletons". Opting IN means a new route cannot inherit that mistake by default:
 * the wrong answer now requires someone to type it.
 *
 * A page's rails are a runtime fact, not an import: `invoices/[inv]` imports
 * `TabRail` and renders no left rail. Check the rendered page, not the source.
 *
 * `anchorRail` mirrors `TabRail` (`lg:` and up) and `actionRail` mirrors
 * `ActionRail` (`xl:` and up) — the same breakpoints the real components use, so
 * the skeleton never promises a column the viewport will not get either.
 */
export function DetailLoading({
  sections = 4,
  anchorRail = false,
  actionRail = false,
}: {
  sections?: number;
  anchorRail?: boolean;
  actionRail?: boolean;
}) {
  return (
    <div aria-busy="true" aria-label="Loading details">
      <HeaderBones actions={1} />
      <div className="flex gap-6">
        {anchorRail ? (
          <div className="hidden w-44 shrink-0 space-y-2 lg:block">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : null}

        <div className="min-w-0 flex-1 space-y-5">
          {Array.from({ length: sections }).map((_, s) => (
            <div key={s} className="space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <div className="rounded-xl border bg-card p-4">
                <div className="grid grid-cols-[168px_1fr] gap-x-6 gap-y-3.5">
                  {Array.from({ length: 8 }).map((_, r) => (
                    <React.Fragment key={r}>
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-1/2" />
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {actionRail ? (
          <div className="hidden w-60 shrink-0 space-y-4 xl:block">
            {Array.from({ length: 3 }).map((_, g) => (
              <div key={g} className="space-y-2 border-b pb-4 last:border-0">
                <Skeleton className="h-2.5 w-20" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-3.5 w-36" />
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Dashboard archetype: KPI strip, the divided figure strip, then a chart grid. */
/** One `RecordCard`: title bar, then either table rows or text lines. */
function CardBones({
  rows = 3,
  table = false,
  className,
}: {
  rows?: number;
  table?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card ${className ?? ""}`}
    >
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="ml-auto h-3.5 w-24" />
      </div>
      {table ? (
        <>
          <div className="flex gap-6 border-b px-5 py-3">
            {Array.from({ length: 5 }).map((_, c) => (
              <Skeleton key={c} className="h-3 flex-1" />
            ))}
          </div>
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0">
              {Array.from({ length: 5 }).map((_, c) => (
                <div key={c} className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-full" />
                  {c === 0 ? <Skeleton className="h-2.5 w-2/3" /> : null}
                </div>
              ))}
            </div>
          ))}
        </>
      ) : (
        <div className="flex flex-1 flex-col gap-3 px-5 py-4">
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A `Zone`: its small heading, then its rows. */
function ZoneBones({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex flex-col gap-3.5">
      <Skeleton className="h-4 w-20" />
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

/**
 * The customer and subscription pages (`patterns/record-page.tsx`): crumbs with Refresh,
 * the header card, four figure tiles, zoned rows (8/4 and 6/6), History, Activity |
 * Comments, and the folded details card. Same boxes, same gaps, so nothing jumps
 * when the page streams in.
 */
export function RecordLoading({
  variant,
}: {
  variant: "customer" | "subscription" | "invoice" | "credit_note" | "transaction";
}) {
  if (variant === "invoice" || variant === "credit_note" || variant === "transaction") {
    return <DocumentRecordBones variant={variant} />;
  }
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card px-6 py-5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-3">
              <Skeleton className="h-7 w-64" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-80 max-w-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-6">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-32" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones table rows={variant === "customer" ? 3 : 2} />
          {variant === "customer" ? (
            <CardBones rows={2} />
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              <CardBones rows={1} />
              <CardBones rows={3} className="flex-1" />
            </div>
          )}
        </div>
        {variant === "customer" ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CardBones rows={2} />
            <CardBones rows={2} />
          </div>
        ) : null}
      </ZoneBones>
      {variant === "subscription" ? (
        <ZoneBones>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CardBones table rows={2} />
            <CardBones table rows={2} />
          </div>
        </ZoneBones>
      ) : null}
      <ZoneBones>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-5 py-3.5">
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="px-5 py-4">
            <div className="mb-3 flex gap-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-20" />
              ))}
            </div>
            {Array.from({ length: 5 }).map((_, r) => (
              <div key={r} className="flex items-center gap-6 border-b py-3.5 last:border-0">
                {Array.from({ length: 5 }).map((_, c) => (
                  <Skeleton key={c} className="h-3.5 flex-1" />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones rows={4} />
          <CardBones rows={2} />
        </div>
      </ZoneBones>
      <div className="mt-4 overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-5 py-3.5">
          <Skeleton className="h-4 w-32" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-5 py-3.5 last:border-0">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="ml-auto size-4" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Crumbs with Refresh, then a record header card without an avatar. */
function RecordTopBones({ tiles = 0, actions = 0 }: { tiles?: number; actions?: number }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card px-6 py-5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        {actions ? (
          <div className="flex gap-2">
            {Array.from({ length: actions }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-24" />
            ))}
          </div>
        ) : null}
      </div>
      {tiles ? (
        <div
          className={`grid grid-cols-1 gap-6 md:grid-cols-2${tiles > 2 ? " xl:grid-cols-4" : ""}`}
        >
          {Array.from({ length: tiles }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-6">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-7 w-32" />
              <Skeleton className="mt-2 h-3 w-20" />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Payment-intent detail: header, Summary | Timeline, Customer, Attempts table. */
export function PaymentIntentLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones actions={1} />
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones rows={6} />
          <CardBones rows={3} />
        </div>
        <CardBones rows={2} />
      </ZoneBones>
      <ZoneBones>
        <CardBones table rows={2} />
      </ZoneBones>
    </div>
  );
}

/** Tax-region detail: header, Rates (8/4 then 6/6), then the settings cards. */
export function TaxRegionLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones />
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones rows={3} />
          <div className="flex min-w-0 flex-col gap-4">
            <CardBones rows={2} />
            <CardBones rows={2} className="flex-1" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardBones table rows={3} />
          <CardBones rows={3} />
        </div>
      </ZoneBones>
      <ZoneBones>
        <CardBones rows={5} />
        <CardBones rows={3} />
      </ZoneBones>
    </div>
  );
}

/** Coupon detail: header, two tiles, Discount | Details, Subscriptions | Sets, Redemptions, Records. */
export function CouponLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones tiles={2} actions={2} />
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardBones rows={4} />
          <CardBones rows={5} />
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones table rows={3} />
          <CardBones table rows={1} />
        </div>
        <CardBones table rows={3} />
      </ZoneBones>
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones rows={4} />
          <CardBones rows={2} />
        </div>
      </ZoneBones>
    </div>
  );
}

/** Coupon-set detail: header, two count tiles, the codes table, Activity log. */
export function CouponSetLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones tiles={2} actions={2} />
      <ZoneBones>
        <CardBones table rows={6} />
      </ZoneBones>
      <ZoneBones>
        <CardBones rows={3} />
      </ZoneBones>
    </div>
  );
}

/** Product detail: header, tiles, Pricing table, Selling pair, Records, folded details. */
export function ProductLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones tiles={2} actions={2} />
      <ZoneBones>
        <CardBones table rows={3} />
      </ZoneBones>
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardBones rows={2} />
          <CardBones rows={2} />
        </div>
      </ZoneBones>
      <ZoneBones>
        <CardBones rows={3} />
      </ZoneBones>
      <CardBones rows={4} className="mt-4" />
    </div>
  );
}

/** Price detail: header, tiles, Pricing, two 6/6 rows, Activity log. */
export function PriceLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones tiles={2} actions={2} />
      <ZoneBones>
        <CardBones table rows={3} />
      </ZoneBones>
      <ZoneBones>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardBones rows={4} />
          <CardBones rows={4} />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardBones rows={2} />
          <CardBones rows={2} />
        </div>
      </ZoneBones>
      <ZoneBones>
        <CardBones rows={3} />
      </ZoneBones>
    </div>
  );
}

/** Product group detail: header, tiles, the products table, Activity log. */
export function ProductGroupLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones tiles={2} actions={2} />
      <ZoneBones>
        <CardBones table rows={4} />
      </ZoneBones>
      <ZoneBones>
        <CardBones rows={3} />
      </ZoneBones>
    </div>
  );
}

export function DashboardLoading({ charts = 6 }: { charts?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <HeaderBones />
      <KpiBones />

      <div className="mb-8 flex rounded-xl border bg-card">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-1 space-y-3 px-5 py-4 not-first:border-l">
            <Skeleton className="h-2.5 w-28" />
            <div className="flex gap-4">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        ))}
      </div>

      <div className="mb-4 flex items-center gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: charts }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="mt-2.5 h-7 w-32" />
            {/* The plot area is one block, not bars: a bar-chart shimmer where a
                line chart is coming is the same lie in miniature. */}
            <Skeleton className="mt-4 h-[190px] w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Settings archetype: grouped rows, each a label with its current value. */
export function SettingsLoading({ groups = 3, rows = 4 }: { groups?: number; rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading settings">
      <HeaderBones />
      <div className="max-w-3xl space-y-6">
        {Array.from({ length: groups }).map((_, g) => (
          <div key={g} className="space-y-2">
            <Skeleton className="h-3.5 w-36" />
            <div className="rounded-xl border bg-card">
              {Array.from({ length: rows }).map((_, r) => (
                <div
                  key={r}
                  className="flex items-center justify-between gap-6 border-b px-4 py-3.5 last:border-0"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-2.5 w-72" />
                  </div>
                  <Skeleton className="h-4 w-24 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Form archetype: the ~720px measure, one column, generous field gaps. */
export function FormLoading({ fields = 6 }: { fields?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading form">
      <HeaderBones actions={1} />
      <div className="max-w-3xl space-y-5">
        <div className="rounded-xl border bg-card p-5">
          <Skeleton className="h-3.5 w-40" />
          <div className="mt-5 space-y-5">
            {Array.from({ length: fields }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-9 w-full max-w-72" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The old name. Kept so a route added before this split still compiles, and
 * pointed at the LIST shape because that is what it always drew.
 *
 * @deprecated pick the archetype that matches the route.
 */
export function RouteLoading() {
  return <ListLoading />;
}

/**
 * Invoice, credit note and transaction pages: crumbs, a header without an avatar, the
 * record's zones, then Activity | Comments (not on a transaction).
 */
function DocumentRecordBones({ variant }: { variant: "invoice" | "credit_note" | "transaction" }) {
  const split = "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]";
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <RecordTopBones actions={variant === "transaction" ? 0 : 2} />
      <ZoneBones>
        <div className={split}>
          <CardBones table={variant !== "transaction"} rows={variant === "transaction" ? 6 : 3} />
          {/* A transaction's right cell is its Timeline. */}
          <CardBones rows={variant === "transaction" ? 3 : 4} />
        </div>
        {variant === "credit_note" ? (
          <CardBones rows={2} />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CardBones rows={variant === "transaction" ? 1 : 2} />
            <CardBones rows={variant === "transaction" ? 3 : 2} />
          </div>
        )}
      </ZoneBones>
      {variant === "invoice" ? (
        <ZoneBones>
          <div className={split}>
            <CardBones rows={3} />
            <CardBones rows={3} />
          </div>
          <CardBones table rows={2} />
        </ZoneBones>
      ) : null}
      {variant !== "transaction" ? (
        <ZoneBones>
          <div className={split}>
            <CardBones rows={4} />
            <CardBones rows={2} />
          </div>
        </ZoneBones>
      ) : null}
    </div>
  );
}
