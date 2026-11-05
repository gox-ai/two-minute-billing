import * as React from "react";
import { Check, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { BrandMark } from "@/components/brand/brand-mark";
import { brandCss } from "@/lib/brand";
import { instrumentLabel } from "@/lib/instrument-label";
import { StorefrontFooter, StorefrontInstrumentProvider } from "./storefront-footer";

export { StorefrontFooter, instrumentLabel };

/**
 * Shared chrome for the HOSTED (buyer-facing) pages — the portal and checkout.
 * Server components only; nothing here may import `@/lib/api` or `@/lib/session`
 * (see the storefront root layout), which is why it lives inside this route
 * group rather than in `components/`.
 *
 * These are the only screens a paying customer of one of OUR customers ever
 * sees, so they carry more finish than an operator screen: a branded header, a
 * statement at the top, divided lists instead of a stack of bordered boxes. It
 * is still only design-system tokens and primitives — the richness comes from
 * hierarchy and spacing, not from colour or a second palette.
 */

/**
 * The brand a hosted page renders. `null`/absent everywhere is normal — a business
 * that has set no Brand Styles still gets an initials mark and our own tokens.
 */
export interface Brand {
  name: string;
  logo_url?: string | null;
  icon_url?: string | null;
  favicon_url?: string | null;
  brand_color?: string | null;
  /** `test` on a business's test mode: the header then says no real money moves. */
  livemode?: string;
}

/**
 * Paints the tenant's brand colour onto the subtree, and nowhere else.
 *
 * A `<style>` element rather than an inline `style` prop so the same CSS can be
 * reused verbatim by the Brand Styles previews — one derivation, so a preview cannot
 * disagree with the page. Scoped to `[data-brand]`, which is what keeps a tenant
 * colour out of the operator dashboard: that identity is ours. `brandCss` returns ''
 * when there is no brand, and re-validates the hex before interpolating it.
 */
export function BrandTheme({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  const css = brandCss(brand.brand_color);
  return (
    <>
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      {/* `display: contents` so this is layout-neutral — custom properties inherit
          down the DOM tree regardless of display, so the subtree gets the brand
          without this wrapper adding a box the page has to account for. */}
      <div data-brand className="contents">
        <StorefrontInstrumentProvider>{children}</StorefrontInstrumentProvider>
      </div>
    </>
  );
}

/**
 * Page header. The business is the brand here, not us — its name leads, and
 * `aside` carries whatever identifies the session on the right (the portal puts
 * the signed-in buyer there; checkout has nobody yet, so it passes nothing).
 */
export function StorefrontHeader({
  brand,
  eyebrow,
  subtitle,
  aside,
}: {
  brand: Brand;
  /** Tracked micro-label under the name ("Billing portal"). */
  eyebrow?: string;
  /** Sentence-case line under the name, when a whole sentence fits better than an eyebrow. */
  subtitle?: string;
  aside?: React.ReactNode;
}) {
  const business = brand.name;
  // With a wordmark the business name is already IN the image; repeating it beside the
  // logo is the classic branded-header mistake. The name only leads when there is no
  // wordmark to lead with.
  const hasWordmark = Boolean(brand.logo_url);
  return (
    <>
      {brand.livemode === "test" ? (
        <Alert tone="warning" title="Test mode">
          This page does not charge real money. Use a test card or a test payment method.
        </Alert>
      ) : null}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BrandMark name={business} logoUrl={brand.logo_url} iconUrl={brand.icon_url} />
          <div className="min-w-0">
            {hasWordmark ? null : (
              <div className="truncate text-lg font-semibold tracking-tight">{business}</div>
            )}
            {eyebrow ? (
              <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                {eyebrow}
              </div>
            ) : null}
            {subtitle ? <div className="text-sm text-muted-foreground">{subtitle}</div> : null}
          </div>
        </div>
        {/* NOT `hidden sm:block` any more. That hid the whole block below 640px, so on
          every phone the buyer had no name, no email and — the part that matters — no
          way to SIGN OUT of a hosted billing page on a shared device. The caller now
          decides what survives the narrow screen (the portal keeps Sign out and drops
          the identity); this just stops the header hiding all of it. */}
        {aside ? <div className="min-w-0 text-right">{aside}</div> : null}
      </header>
    </>
  );
}

/**
 * A titled section. The header rule and the padded body are the section's own —
 * `Card`'s default `gap-6 py-6` is overridden so a divided row list can run edge
 * to edge under the rule, which is what makes the lists read as one object
 * rather than as boxes inside a box.
 */
export function StorefrontSection({
  title,
  description,
  action,
  children,
  bodyClassName,
  hideTitle = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
  /**
   * Render the heading for assistive tech only. For the portal's three account panes,
   * whose titles are word-for-word the tab button sitting directly above them in both
   * layouts — the heading was a line of vertical space restating the control the buyer
   * had just pressed. It stays in the accessibility tree because the section still needs
   * a name: the strip is a pressed-button group, not a tablist, so nothing else labels it.
   */
  hideTitle?: boolean;
}) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className={hideTitle ? "sr-only" : "text-sm font-semibold tracking-tight"}>
            {title}
          </h2>
          {description ? (
            <p
              className={
                hideTitle ? "text-sm text-muted-foreground" : "mt-0.5 text-xs text-muted-foreground"
              }
            >
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Divided list — pass `bodyClassName="p-0"` on the section that holds it. */
export function RowList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}

export function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4",
        className,
      )}
    >
      {children}
    </li>
  );
}

/** Square icon tile that gives every row a fixed left edge to scan down. */
export function Glyph({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground [&_svg]:size-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A line's product picture in the `Glyph` box, or `fallback` when it has none. Decorative:
 * the line's name beside it says what it is.
 */
export function ProductGlyph({
  src,
  fallback,
  className,
}: {
  src?: string | null;
  fallback: React.ReactNode;
  className?: string;
}) {
  if (!src) return <Glyph className={className}>{fallback}</Glyph>;
  return (
    <span
      aria-hidden
      className={cn("flex size-9 shrink-0 overflow-hidden rounded-md border bg-card", className)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a merchant image on our CDN */}
      <img src={src} alt="" className="size-full object-cover" />
    </span>
  );
}

/** Tracked micro-label over a value — the recessed strips under a statement. */
export function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 min-w-0 text-sm">{children}</div>
    </div>
  );
}

/**
 * The whole-page answer: an expired link, a finished checkout, a completed
 * order. One component so "this is over" looks the same on both surfaces —
 * these used to be four hand-rolled centred divs that had already drifted
 * (one had an icon, three did not; one used `--primary` as a success mark).
 */
export function NoticeCard({
  icon,
  tone = "neutral",
  title,
  children,
}: {
  icon: React.ReactNode;
  /** `success` only for an outcome the buyer wanted; everything else is neutral. */
  tone?: "neutral" | "success";
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span
          aria-hidden
          className={cn(
            "flex size-11 items-center justify-center rounded-full [&_svg]:size-5",
            tone === "success" ? "bg-success-soft text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <div className="text-lg font-semibold tracking-tight">{title}</div>
        {children ? <div className="max-w-sm text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </Card>
  );
}

/**
 * Where the buyer is in a multi-step flow. Driven by the flow's REAL state, and
 * deliberately not clickable — a step you cannot jump to must not look like a
 * link. Callers build the array from what will actually happen, so a checkout
 * that needs no card never renders a payment step.
 */
export function Steps({
  steps,
  current,
}: {
  steps: Array<{ key: string; label: string }>;
  current: string;
}) {
  const idx = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <React.Fragment key={s.key}>
            {i > 0 ? <li aria-hidden className="h-px w-5 shrink-0 bg-border sm:w-8" /> : null}
            <li
              className="flex min-w-0 items-center gap-2"
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium [&_svg]:size-3",
                  done || active
                    ? "bg-solid text-solid-foreground"
                    : "border bg-muted text-muted-foreground",
                )}
              >
                {done ? <Check aria-hidden /> : i + 1}
              </span>
              <span
                className={cn(
                  "truncate",
                  active ? "font-medium text-foreground" : "hidden text-muted-foreground sm:inline",
                )}
              >
                {s.label}
              </span>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
}

/**
 * The commit bar that closes an add-a-payment-method block, on BOTH hosted surfaces.
 *
 * One component because it was one surface's: the portal grew it (a bare button under the
 * options left the block ending on a stray control, and the buyer is about to hand their
 * bank a standing authorization — the moment earns its own surface), and the checkout's
 * card step still ended on the bare button, so the same step looked like two products
 * depending on which door the buyer came through. Same reason `method-choice.tsx` is
 * shared: this is the buyer's most consequential click and it should not drift.
 *
 * The reassurance is deliberately the SHORT claim, not the footer's. `StorefrontFooter`
 * makes the precise one (the PAN never touches our servers) once per page; beside a
 * button the sentence has to be readable at a glance, and the two say the same thing at
 * two lengths. Both surfaces render both today.
 *
 * The button is a child rather than a prop: every caller's label and disabled state is
 * rail-dependent, and passing eight branches through would only move them here.
 */
export function CommitBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>Your payments are secure and encrypted</span>
      </div>
      {children}
    </div>
  );
}
