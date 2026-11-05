import * as React from "react";
import { CreditCard, FileText, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { brandCss } from "@/lib/brand";
import { SafeHtml } from "@/components/safe-html";
import { BrandMark } from "./brand-mark";

/**
 * Brand Styles previews — what a customer sees on each surface, with the brand that
 * is actually saved.
 *
 * The Email / Invoice / Checkout / Self-serve Portal tabs are previews of ONE brand,
 * not four editors: nobody can judge a logo or a colour from a form field.
 *
 * These are MOCKS of real surfaces, and the honesty rules are:
 *  - Structure mirrors the real page — the same `BrandMark`, the same header shape,
 *    the same brand-coloured element in the same place. A preview drawn by different
 *    code than the surface is a preview of something that does not exist, so the mark
 *    and the colour derivation are both shared with the real thing.
 *  - Nothing here is interactive. A button in a preview that looked pressable would
 *    be a control that does nothing.
 *  - The sample amounts and names are obviously sample data, never a real customer's.
 *  - They render LIGHT regardless of the operator's own theme, because the hosted
 *    pages are light-only. A dark preview of a page that is never dark is a lie.
 */

export interface PreviewBrand {
  name: string;
  logo_url?: string | null;
  icon_url?: string | null;
  favicon_url?: string | null;
  brand_color?: string | null;
}

/**
 * Frames a preview on its own surface and applies the brand to it — the same
 * `[data-brand]` scoping the hosted pages use, so what is previewed is derived by the
 * identical code path (including the contrast correction).
 */
function PreviewFrame({
  brand,
  label,
  children,
  className,
}: {
  brand: PreviewBrand;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const css = brandCss(brand.brand_color);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      <div
        data-brand
        aria-hidden
        className={cn(
          // `force-light` (globals.css) re-declares the light tokens on this subtree.
          // The hosted pages are light-only, so previewing them dark inside a dark
          // dashboard would preview a page that cannot exist.
          "force-light",
          // `bg-sidebar` is the storefront's own recessed ground, so a hosted-page
          // preview sits on the same surface the real page does.
          "rounded-xl border bg-sidebar p-4 select-none sm:p-6",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Mini portal: brand header, the balance statement, one invoice row. */
export function PortalPreview({ brand }: { brand: PreviewBrand }) {
  return (
    <PreviewFrame brand={brand} label="What a customer sees at /portal/…">
      <div className="mx-auto flex max-w-lg flex-col gap-3">
        <div className="flex items-center gap-3">
          <BrandMark
            name={brand.name}
            logoUrl={brand.logo_url}
            iconUrl={brand.icon_url}
            size="sm"
          />
          <div className="min-w-0">
            {brand.logo_url ? null : (
              <div className="truncate text-sm font-semibold tracking-tight">{brand.name}</div>
            )}
            <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Billing portal
            </div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="px-4 py-4">
            <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Amount due
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">$1,240.00</div>
            <div className="mt-1 text-xs text-muted-foreground">
              2 open invoices · due 12-Sep-2026
            </div>
          </div>
          <div className="flex items-center gap-3 border-t px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground">
              <FileText className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">INV-0042</div>
              <div className="text-xs text-muted-foreground">21-Aug-2026</div>
            </div>
            {/* The brand colour lands on the primary action, exactly as on the real page. */}
            <span className="rounded-md bg-solid px-2.5 py-1 text-xs font-medium text-solid-foreground">
              Pay now
            </span>
          </div>
        </div>
        <p className="text-center text-xs text-primary">Manage payment methods</p>
      </div>
    </PreviewFrame>
  );
}

/** Mini checkout: brand header, one plan row, the subscribe action. */
export function CheckoutPreview({ brand }: { brand: PreviewBrand }) {
  return (
    <PreviewFrame brand={brand} label="What a customer sees at /checkout/…">
      <div className="mx-auto flex max-w-lg flex-col gap-3">
        <div className="flex items-center gap-3">
          <BrandMark
            name={brand.name}
            logoUrl={brand.logo_url}
            iconUrl={brand.icon_url}
            size="sm"
          />
          <div className="min-w-0">
            {brand.logo_url ? null : (
              <div className="truncate text-sm font-semibold tracking-tight">{brand.name}</div>
            )}
            <div className="text-xs text-muted-foreground">Subscribe to continue.</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3 text-sm font-semibold">Your plan</div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Growth monthly</div>
              <div className="text-xs text-muted-foreground">Plan · USD</div>
            </div>
            <div className="text-sm font-semibold tabular-nums">USD 49.00 / month</div>
          </div>
          <div className="border-t px-4 py-3">
            <span className="inline-block rounded-md bg-solid px-3 py-1.5 text-xs font-medium text-solid-foreground">
              Continue to payment
            </span>
          </div>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Card details go straight to the payment provider.
        </p>
      </div>
    </PreviewFrame>
  );
}

/**
 * Mini invoice. Mirrors `renderInvoicePdf`'s header — logo left, INVOICE right —
 * because that is the document this brand actually prints on.
 *
 * Deliberately NOT brand-coloured: the PDF and the HTML invoice render the mark and
 * nothing else from Brand Styles. Showing a tinted invoice here would promise a colour
 * the document does not use.
 */
export function InvoicePreview({ brand }: { brand: PreviewBrand }) {
  return (
    <PreviewFrame brand={brand} label="The invoice PDF and its HTML twin">
      <div className="mx-auto max-w-lg rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <BrandMark
            name={brand.name}
            logoUrl={brand.logo_url}
            iconUrl={brand.icon_url}
            size="sm"
          />
          <div className="text-right">
            <div className="text-sm font-semibold tracking-widest uppercase">Invoice</div>
            <div className="text-xs text-muted-foreground">INV-0042</div>
          </div>
        </div>
        <div className="mt-5 space-y-1.5 border-t pt-4 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Growth monthly</span>
            <span className="tabular-nums">49.00</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Tax</span>
            <span className="tabular-nums">8.82</span>
          </div>
          <div className="flex justify-between gap-3 border-t pt-1.5 text-sm font-semibold">
            <span>Total</span>
            <span className="tabular-nums">USD 57.82</span>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          The invoice document uses only the logo. Its colors are fixed for print.
        </p>
      </div>
    </PreviewFrame>
  );
}

/**
 * The REAL rendered email, not a mock: `html` comes from the engine's own template
 * preview endpoint, which renders the same branded shell the outbox sends. There is
 * nothing to reimplement and therefore nothing to drift.
 *
 * On a white canvas with the email's own inline colours, because that is where mail
 * lands. Theming it to our dark mode would preview an email nobody receives — and the
 * body's inline `#222` on a dark card is unreadable, which is exactly the trap.
 */
export function EmailPreview({ html, subject }: { html: string | null; subject?: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The actual rendered email{subject ? <>. Subject: “{subject}”</> : null}
      </p>
      {html ? (
        <div className="overflow-hidden rounded-xl border">
          <SafeHtml
            className="p-5"
            style={{ background: "#ffffff", color: "#222222" }}
            html={html}
          />
        </div>
      ) : (
        <div className="rounded-xl border px-6 py-10 text-center text-sm text-muted-foreground">
          <CreditCard className="mx-auto mb-2 size-6" />
          We could not render the email preview. Check the email settings for this business.
        </div>
      )}
    </div>
  );
}
