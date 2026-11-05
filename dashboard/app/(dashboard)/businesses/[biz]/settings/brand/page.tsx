import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { brandImageSupport } from "@/lib/api/brand-images";
import { previewEmailTemplate, type EmailPreview as EmailPreviewPayload } from "@/lib/api/emails";
import { ErrorState } from "@/components/states";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandEditor } from "@/components/brand/brand-editor";
import {
  CheckoutPreview,
  EmailPreview,
  InvoicePreview,
  PortalPreview,
} from "@/components/brand/brand-previews";
import { saveBrandAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Settings → Brand styles. One brand, previewed on every surface that shows it: a
 * logo and a colour cannot be judged from a form field.
 *
 * The editor is the only tab that writes. The other four render what is SAVED, so a
 * preview is never a preview of unsaved intent.
 */
export default async function BrandStylesSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const brand = {
    name: b.name,
    logo_url: b.logo_url ?? null,
    icon_url: b.icon_url ?? null,
    favicon_url: b.favicon_url ?? null,
    brand_color: b.brand_color ?? null,
  };

  // The REAL email, rendered by the engine's own template preview — the same branded
  // shell the outbox sends. Nothing to reimplement, so nothing to drift. An empty
  // draft previews what is currently in effect (built-in, or this business's override).
  // Best-effort: a business with email misconfigured still gets the other four tabs.
  // `apiWrite` resolves to an ENVELOPE ({ ok, status, data }) rather than throwing or
  // returning the payload — reading `.html` off it silently yields undefined, which is
  // how this first rendered "preview could not be rendered" against a working engine.
  // Whether to draw a file picker at all. Object storage is optional deployment config,
  // so on a deployment without a bucket the editor offers the URL fields alone rather
  // than an upload button that would 503 (CLAUDE.md rule 0).
  const upload = await brandImageSupport();

  const res = await previewEmailTemplate(biz, "invoice_issued", {}).catch(() => null);
  const email = res?.ok ? (res.data as EmailPreviewPayload) : null;
  const emailHtml = email?.html ?? null;
  const emailSubject = email?.subject;

  const set = (url: string | null, missing: string) => (url ? "Set" : missing);

  return (
    <SettingsPage
      title="Brand styles"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Brand styles" },
      ]}
      description="Your logo, icon, favicon and brand color. Customers see them on the self-serve portal, hosted checkout, invoices and billing email."
    >
      <SettingsColumns
        summary={
          <SettingsSummary
            items={[
              { label: "Logo", value: set(brand.logo_url, "Not set. Your initials show instead.") },
              { label: "Icon", value: set(brand.icon_url, "Not set") },
              { label: "Favicon", value: set(brand.favicon_url, "Not set") },
              {
                label: "Brand color",
                value: brand.brand_color ? (
                  <span className="inline-flex items-center gap-2 font-mono uppercase">
                    <span
                      aria-hidden
                      className="size-3.5 rounded-sm border"
                      style={{ background: brand.brand_color }}
                    />
                    {brand.brand_color}
                  </span>
                ) : (
                  "Not set. We use the neutral palette."
                ),
              },
            ]}
          />
        }
      >
        {/* The editor is the only tab that writes; the other four render what is SAVED. */}
        <SettingsCard title="Brand" meta="Edit, then preview each surface" padded>
          <Tabs defaultValue="logo">
            <TabsList className="flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
              <TabsTrigger value="logo">Logo &amp; color</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
              <TabsTrigger value="invoice">Invoice</TabsTrigger>
              <TabsTrigger value="checkout">Checkout</TabsTrigger>
              <TabsTrigger value="portal">Self-serve portal</TabsTrigger>
            </TabsList>

            <TabsContent value="logo" className="pt-6">
              <BrandEditor
                biz={biz}
                brand={brand}
                resourceVersion={b.resource_version}
                upload={upload}
                action={saveBrandAction}
              />
            </TabsContent>
            <TabsContent value="email" className="pt-6">
              <EmailPreview html={emailHtml} subject={emailSubject} />
            </TabsContent>
            <TabsContent value="invoice" className="pt-6">
              <InvoicePreview brand={brand} />
            </TabsContent>
            <TabsContent value="checkout" className="pt-6">
              <CheckoutPreview brand={brand} />
            </TabsContent>
            <TabsContent value="portal" className="pt-6">
              <PortalPreview brand={brand} />
            </TabsContent>
          </Tabs>
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}
