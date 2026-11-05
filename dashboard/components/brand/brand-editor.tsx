"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { useDefaultState } from "@/lib/use-default-state";
import { BrandImageField } from "./brand-image-field";
import type { BrandImageSupport } from "@/lib/api/brand-images";
import { ActionForm } from "@/components/form/action-form";
import type { ActionResult } from "@/lib/action-result";
import { SubmitButton } from "@/components/form/submit-button";
import { BrandMark } from "./brand-mark";
import { HEX_RE, contrastRatio, readableOn } from "@/lib/brand";
import type { PreviewBrand } from "./brand-previews";

/**
 * Brand Styles editor — the one place a brand is set. Everything else in this hub is
 * a preview of what is saved here.
 *
 * Each image is a URL, and uploading is one way to fill that URL in. The field is the
 * stored value in both cases, which is what let these columns be scheme-restricted
 * (SR-2026-016 Finding 3) — the earlier note here said uploads would land "against the
 * SAME fields, so nothing downstream changes", and that is what happened.
 *
 * The Upload buttons appear only when the deployment has object storage configured;
 * without it the URL fields alone are a complete way to set a brand. What each accepts
 * comes from the engine (`upload.accepts`) — a logo is embedded in the invoice PDF, which
 * cannot carry GIF or WebP, so it takes PNG or JPEG while an icon takes all four.
 */

/**
 * A neutral spread, not "nice colours". Each is dark enough to clear AA as a link on
 * white so the swatch row cannot hand someone an unreadable brand in one click — the
 * hex field still accepts anything valid, and the warning below explains the
 * correction rather than blocking it.
 */
const SWATCHES = [
  "#15181D",
  "#0F5FA6",
  "#0B6E4F",
  "#8A5A00",
  "#A3342A",
  "#6B2E8A",
  "#1F3A93",
  "#0E7490",
  "#B45309",
  "#BE185D",
  "#3F6212",
  "#374151",
];

export function BrandEditor({
  biz,
  brand,
  resourceVersion,
  upload,
  action,
}: {
  biz: string;
  brand: PreviewBrand;
  resourceVersion?: number | null;
  /** Whether uploads work here, and what each asset accepts. False ⇒ no picker drawn. */
  upload: BrandImageSupport;
  /** The server action, passed in so this stays a pure client component. */
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  // `useDefaultState`, not `useState`: a bare useState seeds once on mount, so after
  // ActionForm's router.refresh() these kept the pre-save values AND posted them back on
  // the next submit. Favicon was uncontrolled for that reason and is now state too,
  // because an upload has to be able to write into it.
  const [color, setColor] = useDefaultState(brand.brand_color ?? "");
  const [logo, setLogo] = useDefaultState(brand.logo_url ?? "");
  const [icon, setIcon] = useDefaultState(brand.icon_url ?? "");
  const [favicon, setFavicon] = useDefaultState(brand.favicon_url ?? "");

  const valid = HEX_RE.test(color);
  // The same correction the hosted pages apply, surfaced BEFORE saving: a merchant who
  // pastes a pale brand should learn here that links will be darkened, not discover it
  // by looking at their portal.
  const corrected = valid ? readableOn(color, "#ffffff") : null;
  const willAdjust = corrected != null && corrected.toLowerCase() !== color.toLowerCase();

  return (
    <ActionForm action={action} className="max-w-2xl space-y-8">
      <input type="hidden" name="biz" value={biz} />
      {resourceVersion != null ? (
        <input type="hidden" name="expected_version" value={resourceVersion} />
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground/80">Brand elements</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These appear on your customer-facing emails, invoices, checkout pages and self-serve
            portal. If a surface has no image, it shows your business initials.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <BrandImageField
            biz={biz}
            asset="logo"
            name="logo_url"
            label="Logo"
            /* SVG is refused on BOTH sides now (SR-2026-015): an upload will not take one,
               and as of 2026-09-09 `loadLogo` no longer rasterises one either — so an SVG
               URL renders on the web surfaces and leaves the invoice PDF with no
               letterhead. The copy says PNG or JPEG whichever path a merchant uses, because
               anything else is a logo that works in three places out of four. */
            help={
              upload.uploadEnabled
                ? "A wide wordmark. It appears first on the portal, checkout and invoice header. Upload a PNG or JPEG, or paste a URL. Both formats print on the invoice."
                : "A wide wordmark. It appears first on the portal, checkout and invoice header. Use a PNG or JPEG on a public URL."
            }
            value={logo}
            onValueChange={setLogo}
            upload={upload}
            placeholder="https://…/logo.png"
            className="sm:col-span-2"
          />
          <BrandImageField
            biz={biz}
            asset="icon"
            name="icon_url"
            label="Icon"
            help="A square mark. We use it where a wordmark does not fit, for example an email header on a phone."
            value={icon}
            onValueChange={setIcon}
            upload={upload}
            placeholder="https://…/icon.png"
          />
          <BrandImageField
            biz={biz}
            asset="favicon"
            name="favicon_url"
            label="Favicon"
            help="It appears on the browser tab of your hosted portal and checkout."
            value={favicon}
            onValueChange={setFavicon}
            upload={upload}
            placeholder="https://…/favicon.png"
          />
        </div>

        {/* Live, because a broken image URL is the single most likely mistake here and
            the form is the only place it can be caught before a customer sees it. */}
        <div className="flex items-center gap-4 rounded-lg bg-muted/50 px-4 py-3">
          <BrandMark name={brand.name} logoUrl={logo || null} iconUrl={icon || null} />
          <div className="text-xs text-muted-foreground">
            {logo
              ? "Your logo, as it will appear."
              : icon
                ? "Your icon, as it will appear."
                : "No image is set. Customers see your initials."}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground/80">Brand color</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We use it for links and primary buttons on your customer-facing pages, and for the
            button in your billing emails. Leave it empty to use our neutral default.
          </p>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <div className="w-40">
            <Field name="brand_color" label="Hex">
              <Input
                name="brand_color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
                placeholder="#FF6700"
                className="font-mono uppercase"
                aria-describedby="brand-color-note"
              />
            </Field>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Select a color
            </div>
            {/* Buttons, not a native colour input: a styled primitive is the rule here,
                and a swatch row is also what a merchant actually wants. */}
            <div className="flex flex-wrap gap-1.5">
              {SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => setColor(hex)}
                  aria-label={`Use ${hex}`}
                  aria-pressed={color.toLowerCase() === hex.toLowerCase()}
                  style={{ background: hex }}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md border border-border/60 transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    color.toLowerCase() === hex.toLowerCase() &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-background",
                  )}
                >
                  {color.toLowerCase() === hex.toLowerCase() ? (
                    <Check className="size-3.5 text-white" aria-hidden />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p id="brand-color-note" className="text-xs text-muted-foreground">
          {color === "" ? (
            "No brand color. Your pages use our neutral palette."
          ) : !valid ? (
            "Enter a 6-digit hex color. For example: #FF6700."
          ) : willAdjust ? (
            <>
              Buttons use <span className="font-mono">{color.toUpperCase()}</span> exactly. We
              darken link text to <span className="font-mono">{corrected!.toUpperCase()}</span> so
              that it stays readable. This colour has only{" "}
              {contrastRatio(color, "#ffffff").toFixed(1)}:1 contrast against white, which is below
              the 4.5:1 minimum.
            </>
          ) : (
            <>
              Contrast against white is {contrastRatio(color, "#ffffff").toFixed(1)}:1. We use the
              colour as it is for links and buttons.
            </>
          )}
        </p>
      </section>

      <SubmitButton>Save brand styles</SubmitButton>
    </ActionForm>
  );
}
