import "@/app/globals.css";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";

/**
 * Root layout for the four PUBLIC operator pages — sign in, forgot password, reset
 * password, accept invite — and their `/s/<token>` exchange routes.
 *
 * ── WHY THIS GROUP EXISTS (audit H4/M8, 2026-08-28) ─────────────────────────────
 * These pages used to sit inside `(dashboard)`, whose layout called `currentUser()` and
 * then branched: signed-in got the shell, signed-out got a centred card. That branch is
 * why `(dashboard)/layout.tsx` could not simply require a session — `requireUser()` there
 * redirects to `/login`, which rendered through that same layout, which redirected to
 * `/login`. An infinite loop that locks every user out, including the ones already signed
 * in. Both audit documents proposed exactly that one-line change; splitting the groups
 * first is what makes it safe.
 *
 * Next has no `app/layout.tsx`, so each top-level group owns its own `<html>`. That is
 * already the established shape here — `(storefront)` has owned one all along.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────
 * No `h-full overflow-hidden` on `<html>`/`<body>`. The signed-in shell sets those because
 * it is a fixed-height frame that owns scrolling in `<main>`, and without them the browser
 * paints a second scrollbar beside main's. A sign-in screen is an ordinary centred page and
 * must stay scrollable — which is precisely why that class was scoped to the signed-in
 * branch before this split, and why it does not follow the pages here.
 *
 * No `ModeProvider` and no nav: live/test mode and every navigation target are properties
 * of a session that does not exist yet.
 */
export const metadata = {
  title: "Two Minute Billing",
  description: "Subscription billing — manager · ops · developer",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/**
 * Same instance as the signed-in layout: next/font downloads at BUILD time and serves from
 * our own origin, so sign-in renders in the product's typeface rather than a system
 * fallback that differs per machine.
 */
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="bg-background font-sans text-foreground antialiased">
        {/* Theme + tooltips + the toaster these pages report errors through. NOT
            `forcedTheme` — unlike the storefront, this is our own surface and an operator's
            light/dark choice should survive being signed out. */}
        <Providers>
          <main className="flex min-h-screen items-center justify-center px-4 py-10">
            <div className="w-full max-w-md">{children}</div>
          </main>
        </Providers>
      </body>
    </html>
  );
}
