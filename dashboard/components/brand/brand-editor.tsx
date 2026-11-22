"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import { BrandImageField } from "./brand-image-field";
import type { BrandImageSupport } from "@/lib/api/brand-images";
import { ActionForm } from "@/components/form/action-form";
import type { ActionResult } from "@/lib/action-result";
import { SettingRow, SettingsCard, SettingsColumns } from "@/components/settings/settings-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandMark } from "./brand-mark";
import { HEX_RE, buttonLabel, contrastRatio, readableOn, onColor } from "@/lib/brand";
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

/** Text colours for the brand button. The hex field takes any other value. */
const TEXT_SWATCHES = ["#ffffff", "#111111", "#000000"];

/** How the preview names a label colour; any other hex is shown as itself. */
const LABEL_NAME: Record<string, string> = {
  "#ffffff": "white",
  "#111111": "near-black",
  "#000000": "black",
};

export function BrandEditor({
  biz,
  brand,
  resourceVersion,
  upload,
  action,
  summary,
  previews,
}: {
  biz: string;
  brand: PreviewBrand;
  resourceVersion?: number | null;
  /** Whether uploads work here, and what each asset accepts. False ⇒ no picker drawn. */
  upload: BrandImageSupport;
  /** The server action, passed in so this stays a pure client component. */
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  /** The right-column "Your setup" card. */
  summary: React.ReactNode;
  /** The four read-only preview tabs, rendered by the server page. */
  previews: {
    email: React.ReactNode;
    invoice: React.ReactNode;
    checkout: React.ReactNode;
    portal: React.ReactNode;
  };
}) {
  // `useDefaultState`, not `useState`: a bare useState seeds once on mount, so after
  // ActionForm's router.refresh() these kept the pre-save values AND posted them back on
  // the next submit. Favicon was uncontrolled for that reason and is now state too,
  // because an upload has to be able to write into it.
  const [color, setColor] = useDefaultState(brand.brand_color ?? "");
  const [textColor, setTextColor] = useDefaultState(brand.button_text_color ?? "");
  const [logo, setLogo] = useDefaultState(brand.logo_url ?? "");
  const [icon, setIcon] = useDefaultState(brand.icon_url ?? "");
  const [favicon, setFavicon] = useDefaultState(brand.favicon_url ?? "");

  const valid = HEX_RE.test(color);
  // The same correction the hosted pages apply, surfaced BEFORE saving: a merchant who
  // pastes a pale brand should learn here that links will be darkened, not discover it
  // by looking at their portal.
  const corrected = valid ? readableOn(color, "#ffffff") : null;
  const willAdjust = corrected != null && corrected.toLowerCase() !== color.toLowerCase();
  // The label the hosted pages will render (`buttonLabel`, as `brandCss` uses it).
  const textValid = HEX_RE.test(textColor);
  const label = valid ? buttonLabel(color, textValid ? textColor : null) : null;
  const textKept = label != null && textValid && label === textColor.toLowerCase();

  const [tab, setTab] = React.useState("logo");
  // On a phone the strip scrolls sideways; keep the current tab in view.
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!list || !el) return;
    const end = el.offsetLeft + el.offsetWidth;
    if (el.offsetLeft < list.scrollLeft) list.scrollLeft = el.offsetLeft - 4;
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth + 4;
  }, [tab]);

  return (
    <ActionForm action={action} className="flex flex-col gap-5">
      <input type="hidden" name="biz" value={biz} />
      {resourceVersion != null ? (
        <input type="hidden" name="expected_version" value={resourceVersion} />
      ) : null}
      <SettingsColumns
        summary={summary}
        save={tab === "logo" ? { label: "Save brand styles" } : undefined}
      >
        {/* Only the first tab writes; the other four render what is SAVED. */}
        <SettingsCard title="Brand" meta="Edit, then preview each surface">
          <Tabs value={tab} onValueChange={setTab}>
            <div className="px-5 py-4">
              {/* One row that scrolls, as Home's strip: the pill measures in scroll space. */}
              <TabsList
                ref={listRef}
                className="scrollbar-none flex-nowrap justify-start [&::-webkit-scrollbar]:hidden"
              >
                <TabsTrigger value="logo">Logo &amp; color</TabsTrigger>
                <TabsTrigger value="email">Email</TabsTrigger>
                <TabsTrigger value="invoice">Invoice</TabsTrigger>
                <TabsTrigger value="checkout">Checkout</TabsTrigger>
                <TabsTrigger value="portal">Self-serve portal</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="logo" className="divide-y border-t">
              <div className="px-5 py-4">
                <h2 className="text-sm font-semibold">Brand elements</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These appear on your customer-facing emails, invoices, checkout pages and
                  self-serve portal. If a surface has no image, it shows your business initials.
                </p>
              </div>

              <SettingRow
                label="Logo"
                htmlFor="logo_url"
                placement="end"
                errorFor="logo_url"
                help={
                  upload.uploadEnabled
                    ? "A wide wordmark. It appears first on the portal, checkout and invoice header. Upload a PNG or JPEG, or paste a URL. Both formats print on the invoice."
                    : "A wide wordmark. It appears first on the portal, checkout and invoice header. Use a PNG or JPEG on a public URL."
                }
                control={
                  <BrandImageField
                    bare
                    biz={biz}
                    asset="logo"
                    name="logo_url"
                    label="Logo"
                    value={logo}
                    onValueChange={setLogo}
                    upload={upload}
                    placeholder="https://…/logo.png"
                  />
                }
              />
              <SettingRow
                label="Icon"
                htmlFor="icon_url"
                placement="end"
                errorFor="icon_url"
                help="A square mark. We use it where a wordmark does not fit, for example an email header on a phone."
                control={
                  <BrandImageField
                    bare
                    biz={biz}
                    asset="icon"
                    name="icon_url"
                    label="Icon"
                    value={icon}
                    onValueChange={setIcon}
                    upload={upload}
                    placeholder="https://…/icon.png"
                  />
                }
              />
              <SettingRow
                label="Favicon"
                htmlFor="favicon_url"
                placement="end"
                errorFor="favicon_url"
                help="It appears on the browser tab of your hosted portal and checkout."
                control={
                  <BrandImageField
                    bare
                    biz={biz}
                    asset="favicon"
                    name="favicon_url"
                    label="Favicon"
                    value={favicon}
                    onValueChange={setFavicon}
                    upload={upload}
                    placeholder="https://…/favicon.png"
                  />
                }
              />

              {/* Live, because a broken image URL is the likeliest mistake here. */}
              <div className="flex items-center gap-4 bg-muted/40 px-5 py-3">
                <BrandMark name={brand.name} logoUrl={logo || null} iconUrl={icon || null} />
                <div className="text-xs text-muted-foreground">
                  {logo
                    ? "Your logo, as it will appear."
                    : icon
                      ? "Your icon, as it will appear."
                      : "No image is set. Customers see your initials."}
                </div>
              </div>

              <div className="px-5 py-4">
                <h2 className="text-sm font-semibold">Brand color</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  We use it for links and primary buttons on your customer-facing pages, and for the
                  button in your billing emails. Leave it empty to use our neutral default.
                </p>
              </div>

              <SettingRow
                label="Hex value"
                htmlFor="brand_color"
                placement="end"
                errorFor="brand_color"
                control={
                  <Input
                    id="brand_color"
                    name="brand_color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    maxLength={7}
                    placeholder="#ff6700"
                    className="w-30 font-mono"
                    aria-describedby="brand-color-note"
                  />
                }
              />
              <SettingRow
                label="Select a color"
                placement="end"
                control={
                  /* Buttons, not a native colour input: a styled primitive is the rule here. */
                  <div className="flex w-72 max-w-full flex-wrap justify-end gap-1.5">
                    {SWATCHES.map((hex) => {
                      const on = color.toLowerCase() === hex.toLowerCase();
                      return (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => setColor(hex.toLowerCase())}
                          aria-label={`Use ${hex.toLowerCase()}`}
                          aria-pressed={on}
                          style={{ background: hex }}
                          className={cn(
                            "flex size-7 items-center justify-center rounded-md border border-border/60 transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                            on && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                          )}
                        >
                          {on ? <Check className="size-3.5 text-white" aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                }
              >
                <p id="brand-color-note" className="m-0 text-xs text-muted-foreground">
                  {color === "" ? (
                    "No brand color. Your pages use our neutral palette."
                  ) : !valid ? (
                    "Enter a 6-digit hex color. For example: #ff6700."
                  ) : willAdjust ? (
                    <>
                      Buttons use <span className="font-mono">{color.toLowerCase()}</span> exactly.
                      We darken link text to{" "}
                      <span className="font-mono">{corrected!.toLowerCase()}</span> so that it stays
                      readable. This color has only {contrastRatio(color, "#ffffff").toFixed(1)}
                      :1 contrast against white, which is below the 4.5:1 minimum.
                    </>
                  ) : (
                    <>
                      Contrast against white is {contrastRatio(color, "#ffffff").toFixed(1)}:1. We
                      use the color as it is for links and buttons.
                    </>
                  )}
                </p>
              </SettingRow>
              <SettingRow
                label="Button text color"
                htmlFor="button_text_color"
                placement="end"
                errorFor="button_text_color"
                help="The text on your brand-color buttons. Leave it empty and we select a readable color."
                control={
                  <>
                    {/* A disabled input posts nothing; this keeps the saved value. */}
                    {!valid ? (
                      <input type="hidden" name="button_text_color" value={textColor} />
                    ) : null}
                    <Input
                      id="button_text_color"
                      name={valid ? "button_text_color" : undefined}
                      value={textColor}
                      onChange={(e) => setTextColor(e.target.value)}
                      disabled={!valid}
                      maxLength={7}
                      placeholder="#ffffff"
                      className="w-30 font-mono"
                      aria-describedby="button-text-note"
                    />
                  </>
                }
              />
              <SettingRow
                label="Select a text color"
                placement="end"
                control={
                  <div className="flex w-72 max-w-full flex-wrap items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!valid}
                      onClick={() => setTextColor("")}
                      aria-pressed={textColor === ""}
                      className={cn(
                        textColor === "" && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                      )}
                    >
                      Automatic
                    </Button>
                    {TEXT_SWATCHES.map((hex) => {
                      const on = textColor.toLowerCase() === hex;
                      return (
                        <button
                          key={hex}
                          type="button"
                          disabled={!valid}
                          onClick={() => setTextColor(hex)}
                          aria-label={`Use ${LABEL_NAME[hex]} text (${hex})`}
                          aria-pressed={on}
                          style={{ background: hex, color: onColor(hex) }}
                          className={cn(
                            "flex size-7 items-center justify-center rounded-md border border-border transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
                            on && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                          )}
                        >
                          {on ? <Check className="size-3.5" aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                }
              >
                <p id="button-text-note" className="m-0 text-xs text-muted-foreground">
                  {!valid
                    ? "Set a brand color first. Without one, buttons use our neutral palette."
                    : textColor === ""
                      ? "Automatic: white, near-black or black, whichever is readable on your brand color."
                      : !textValid
                        ? "Enter a 6-digit hex color. For example: #ffffff."
                        : "The button preview below shows this color on your brand color."}
                </p>
              </SettingRow>
              {/* What the hosted pages render: `buttonLabel`, the same rule `brandCss` uses, so
                  the preview cannot disagree with them. A text color the merchant set is always
                  used; below 4.5:1 this only warns. */}
              {valid && label ? (
                <SettingRow
                  label="Button preview"
                  placement="end"
                  control={
                    <span
                      aria-hidden
                      className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
                      style={{ background: color, color: label }}
                    >
                      Pay now
                    </span>
                  }
                >
                  <p className="m-0 text-xs text-muted-foreground">
                    {textKept && contrastRatio(label, color) < 4.5 ? (
                      <span className="text-warning">
                        This text color has low contrast on your brand color (
                        {contrastRatio(label, color).toFixed(1)}:1). Some customers cannot read it.
                        We recommend 4.5:1 or more, or select Automatic.
                      </span>
                    ) : textKept ? (
                      <>
                        The button text is <LabelName hex={label} /> on this color (
                        {contrastRatio(label, color).toFixed(1)}:1).
                      </>
                    ) : (
                      <>
                        The button text is <LabelName hex={label} /> on this color (
                        {contrastRatio(label, color).toFixed(1)}:1). We use white text only when it
                        is readable, so all button text meets the 4.5:1 minimum.
                      </>
                    )}
                  </p>
                </SettingRow>
              ) : null}
            </TabsContent>
            <TabsContent value="email" className="border-t p-5">
              {previews.email}
            </TabsContent>
            <TabsContent value="invoice" className="border-t p-5">
              {previews.invoice}
            </TabsContent>
            <TabsContent value="checkout" className="border-t p-5">
              {previews.checkout}
            </TabsContent>
            <TabsContent value="portal" className="border-t p-5">
              {previews.portal}
            </TabsContent>
          </Tabs>
        </SettingsCard>
      </SettingsColumns>
    </ActionForm>
  );
}

/** "white" / "near-black" / "black", or the hex itself for any other color. */
function LabelName({ hex }: { hex: string }) {
  const name = LABEL_NAME[hex.toLowerCase()];
  return name ? <>{name}</> : <span className="font-mono">{hex.toLowerCase()}</span>;
}
