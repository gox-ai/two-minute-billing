import type { MetadataRoute } from "next";

/**
 * The installable operator dashboard's manifest (/manifest.webmanifest).
 *
 * A plain route handler, not the `app/manifest.ts` convention: Next links that file from EVERY
 * root layout, the storefront's included, and a buyer's checkout must not offer to install
 * our app. The (dashboard) and (auth) layouts link this one through `metadata.manifest`.
 *
 * The theme colour here is the splash/title-bar fallback; the layouts' `viewport` sets one per
 * colour scheme, which the browser prefers.
 */
export const dynamic = "force-static";

const icon = [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }];

const manifest: MetadataRoute.Manifest = {
  id: "/",
  name: "Two Minute Billing",
  short_name: "Billing",
  description: "Subscription billing",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f2f6fb",
  theme_color: "#4e4eda",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  // /go/<section> opens the last business used on this device (app/(dashboard)/go).
  shortcuts: [
    { name: "Home", url: "/go/home", icons: icon },
    { name: "Customers", url: "/go/customers", icons: icon },
    { name: "Invoices", url: "/go/invoices", icons: icon },
    { name: "Notifications", url: "/account/notifications", icons: icon },
  ],
};

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
