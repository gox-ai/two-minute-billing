import "@/app/globals.css";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";

export const metadata = {
  title: "Billing",
  description: "Manage your billing",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/** Same self-hosted typeface as the operator dashboard — this tree owns its own
 *  <html>, so it must apply the font itself. */
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

/**
 * Storefront root layout — the customer-facing surface (portal + checkout).
 *
 * This is a SEPARATE root layout from the operator dashboard (app/(dashboard)).
 * Buyers must never see the back-office chrome (sidebar/nav/team/settings), so
 * the storefront deliberately does NOT render — or even import — any of it, and
 * carries no operator session lookup. Nothing under this tree may import
 * `@/lib/api` (org API key) or `@/lib/session`; auth is the customer-scoped
 * token in the URL (see lib/portal-api.ts). Because it owns its own <html>/<body>,
 * an operator who happens to be logged into the dashboard still gets this plain
 * chrome here — isolation is structural, not a runtime check.
 */
export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      {/* A RECESSED ground, so the cards on top of it read as lifted sheets rather
          than as outlines on the same white.
          This used `--sidebar`, which was right only while that token happened to be
          a soft grey — R2 made the dashboard rail white and took the buyer's page
          with it. `--storefront` is the buyer ground and nothing else reads it, so a
          dashboard palette decision cannot reach a merchant's checkout again. */}
      <body className="bg-storefront font-sans text-foreground antialiased">
        {/*
          LIGHT ONLY, and this is a product decision rather than a styling one.

          These pages carry a MERCHANT's brand, and a merchant supplies ONE logo. A
          wordmark is drawn for one background: a logo with white
          text, so it reads on a dark surface and is nearly invisible on a light one —
          and the reverse is true of every logo with black text. The storefront used to
          run `defaultTheme="system"` with no toggle for the buyer, so which of those
          two a customer got was decided by their phone's OS setting. That is not a
          coin we get to flip with someone else's brand.

          So the hosted pages pin `light`, the way Stripe Checkout does. One background,
          one asset, and the brand-colour contrast correction has one surface to clear
          instead of two.

          Scoped to THIS tree on purpose: the operator dashboard keeps its dark mode.
        */}
        <Providers forcedTheme="light">
          <main className="flex min-h-screen justify-center px-4 py-8 sm:py-12">
            {/* The measure is 48rem for every buyer surface EXCEPT the portal's two-column
                layout, which widens itself from `globals.css` — see `.storefront-measure`
                there. Checkout deliberately does NOT widen: a 1200px-wide card form is a
                worse form, not a better one. */}
            <div className="storefront-measure w-full max-w-3xl">{children}</div>
          </main>
        </Providers>
      </body>
    </html>
  );
}
