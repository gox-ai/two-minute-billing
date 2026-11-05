import "@/app/globals.css";
import type { ReactNode } from "react";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { listRetries } from "@/lib/api/retries";
import { Inter } from "next/font/google";
import {
  requireUser,
  currentUserOrganizations,
  currentUserInvites,
  can,
  allows,
  SessionUnavailableError,
  type SessionUser,
} from "@/lib/session";
import { type NavItem } from "@/components/SideNav";
import { AppNav, type BizRef } from "@/components/AppNav";
import {
  NavCollapseProvider,
  NavCollapseToggle,
  NAV_COLLAPSE_SCRIPT,
} from "@/components/nav-collapse";
import { MobileNavBar } from "@/components/mobile-nav";
import { listBusinesses } from "@/lib/api";
import { Providers } from "@/components/providers";
import { AppShellPalette, GoToRow } from "@/components/app-shell-extras";
import { ModeProvider } from "@/components/mode-provider";
import { ModeBanner } from "@/components/mode-banner";
import { AccountBanner } from "@/components/account-banner";
import { isCloud } from "@/lib/edition";
import { TwoFactorGraceBanner, twoFactorGrace } from "@/components/two-factor-grace-banner";
import { TwoFactorDueDialog } from "@/components/two-factor-due-dialog";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { OrgTzProvider } from "@/components/business-tz";
import { orgTz } from "@/lib/org-tz-server";
import { listReleaseNotes } from "@/lib/release-notes";
import { unreadNotes } from "@/lib/release-note-types";
import { WhatsNewDialog } from "@/components/whats-new-dialog";
import { ProductTour } from "@/components/product-tour";
import { ModeToggle } from "@/components/mode-toggle";
import { RailHeader } from "@/components/rail-header";
import { AccountMenu, WhatsNewRow } from "@/components/rail-footer";
import { ThemeSync } from "@/components/account/theme-sync";

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
 * The app's typeface. next/font downloads this at BUILD time and serves it from
 * our own origin — no runtime request to Google, no CDN dependency, and no
 * silent fallback to whatever the viewer's OS provides (which is what the app
 * did before, and why it rendered differently on every machine).
 */
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export default async function RootLayout({ children }: { children: ReactNode }) {
  // requireUser(), not currentUser(): every route under this group needs a session, and a
  // layout that renders a shell for a signed-out visitor is how eight pages came to have no
  // guard of their own (audit M8). Safe to require here only because the four public auth
  // pages now live in their own `(auth)` group — inside this one, this line would redirect
  // /login to /login forever. Each page keeps its own requirePermission(): this establishes
  // WHO, not WHAT they may do, and middleware.ts is the third layer beneath both.
  /**
   * A blip must not read as a logout — and this layout is where it bit.
   *
   * `requireUser()` now THROWS `SessionUnavailableError` when the engine could not be asked,
   * rather than treating that as "signed out" and redirecting to /login. A layout's throw has
   * no boundary above it (each route group owns its own `<html>`, so there is no root layout to
   * host one), so it is answered here with a shell of our own.
   *
   * Only that error is caught. Everything else is rethrown — `redirect()` works by throwing
   * `NEXT_REDIRECT`, so swallowing the rest would break the signed-out and MFA redirects
   * this guard exists for.
   */
  let user: SessionUser;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof SessionUnavailableError) return <ApiUnavailableShell detail={e.detail} />;
    throw e;
  }
  // For the account menu, which lists them only when there is more than one.
  const orgs = await currentUserOrganizations();
  // Pending invites to other organizations (0498): a menu row, shown only when there are some.
  const invites = await currentUserInvites();
  // The ORG display timezone (0216), for every client component under this shell that
  // renders a date OUTSIDE a business scope — /audit, /developer. Inside
  // /businesses/[biz] the business provider is nested below this one and wins
  // (`useDisplayTz`). Cached per request, and soft-failing to UTC, so the shell can
  // never be blanked by this lookup.
  const displayTz = await orgTz();
  // 2FA due: the dialog opens once per session, so it is keyed on a digest of the cookie.
  const grace = twoFactorGrace(user.organization_two_factor, displayTz);
  const sessionToken = grace ? (await cookies()).get(SESSION_COOKIE)?.value : undefined;
  const sessionDigest = sessionToken
    ? createHash("sha256").update(sessionToken).digest("hex").slice(0, 16)
    : null;
  // Read from the repo, compared against the highwater on the user row. The engine stores an
  // opaque count and holds no opinion about the notes — only this side can see them.
  const releaseNotes = listReleaseNotes();
  const unread = unreadNotes(releaseNotes, user.release_notes_seen_count);
  const navItems: NavItem[] = [
    { href: "/", label: "Overview", icon: "overview" },
    ...(allows(user, "reports:view", "ops")
      ? [{ href: "/metrics", label: "Metrics", icon: "metrics" as const }]
      : []),
    ...(allows(user, "api_keys:view", "developer") || allows(user, "webhooks:view", "developer")
      ? [{ href: "/developer", label: "Developers", icon: "developer" as const }]
      : []),
    ...(allows(user, "api_logs:view", "developer")
      ? [{ href: "/developer/logs", label: "Request logs", icon: "requests" as const }]
      : []),
    ...(allows(user, "audit_logs:view", "admin")
      ? [{ href: "/audit", label: "Audit Log", icon: "audit" as const }]
      : []),
    ...(allows(user, "members:view", "admin")
      ? [{ href: "/team", label: "Team", icon: "team" as const }]
      : []),
    ...(allows(user, "settings:manage", "admin")
      ? [{ href: "/settings", label: "Settings", icon: "settings" as const }]
      : []),
    // No `can()` gate: release notes are the same for everyone who can sign in, and the
    // page reads no tenant data. Last in the rail because it is product news, not work.
    { href: "/whats-new", label: "What's new", icon: "releases", badge: unread.length },
  ];
  // For the business-scoped sidebar header (names) and permission gating.
  let businesses: BizRef[] = [];
  try {
    const res = await listBusinesses();
    businesses = res.data.map((b) => ({
      id: b.id,
      name: b.name,
      livemode: b.livemode,
      liveBusinessId: b.live_business_id ?? null,
      testBusinessId: b.test_business_id ?? null,
      iconUrl: b.icon_url ?? null,
    }));
  } catch {
    businesses = [];
  }
  const perms = {
    manager: can(user.role, "manager"),
    ops: can(user.role, "ops"),
    admin: can(user.role, "admin"),
    // A custom role's nav shows by key.
    keys: user.role === "custom" ? (user.permissions ?? []) : null,
  };

  /**
   * Badge count for the viewed business's work surfaces.
   *
   * Retries is revenue actively at risk in dunning, and it used to be discoverable only by
   * opening a collapsed group called "Logs" — so the count belongs on the rail, where it is
   * visible from every page. The business id comes from the path header `proxy.ts` already
   * sets for `requireUser()`; a server component cannot otherwise see its own route.
   *
   * `total` is a real `count(*)`, taken from a `limit: 1` probe — never a page length. Soft
   * failed and only for roles that may read it: a missing count renders NO badge, because
   * "we could not count" must not display as zero, and one extra probe must not be able to
   * take down the shell on every page.
   */
  const viewedBiz = ((await headers()).get("x-tmb-path") ?? "").match(
    /^\/businesses\/([^/]+)/,
  )?.[1];
  let bizCounts: { retries?: number } | undefined;
  if (viewedBiz && (perms.keys ? perms.keys.includes("invoices:view") : perms.ops)) {
    try {
      // `activeOnly`: a badge is a call to action, so it counts retries still MOVING —
      // in-progress and parked, plus a failure dunning has not reached yet. Exhausted and
      // stopped rows stay on the SCREEN (they need a human) but must not sit in a number
      // nobody can drive to zero, which is how a badge stops being read.
      const retries = await listRetries(viewedBiz, { limit: 1, activeOnly: true });
      bizCounts = { retries: retries.total ?? undefined };
    } catch {
      bizCounts = undefined;
    }
  }
  return (
    // The shell below is a fixed-height frame that owns scrolling in <main>, so the
    // document must NOT scroll as well or the browser paints a SECOND scrollbar right
    // beside main's — measurable as `window.innerWidth - documentElement.clientWidth > 0`.
    // (html.scrollHeight stays larger than clientHeight either way, so it is not the metric
    // to check.) These used to be conditional on `user`, because the signed-out login page
    // rendered through this same layout and had to stay scrollable. It lives in `(auth)`
    // now and brings its own <html>, so this branch is unconditional.
    <html lang="en" className={`${inter.variable} h-full overflow-hidden`} suppressHydrationWarning>
      {/* Applies the stored rail width before first paint. Without it a reload
          paints the wide rail and snaps it shut — the same flash next-themes
          exists to avoid for the colour scheme. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: NAV_COLLAPSE_SCRIPT }} />
      </head>
      <body className="h-full overflow-hidden bg-background font-sans text-foreground antialiased">
        <Providers>
          <ThemeSync saved={user.theme} />
          {/* The signed-in shell is a fixed-height frame with exactly ONE scroll
              container (<main>). Previously it was `min-h-screen` plus a sticky
              banner plus an `h-screen` rail, so the document was always taller
              than the viewport by the banner's height — which produced a second,
              near-useless scrollbar on every page. */}
          <ModeProvider businesses={businesses}>
            <NavCollapseProvider>
              {/* `h-dvh`, not `h-screen`: on a phone 100vh is the height with the address bar
                  HIDDEN, so while it shows the frame overflows and the browser slides it — top
                  bar included — out of view. The dynamic unit follows what is visible. */}
              <div className="flex h-dvh flex-col overflow-hidden">
                <ModeBanner />
                {isCloud() ? (
                  <AccountBanner
                    access={user.organization_live_access}
                    status={user.organization_status}
                    reason={user.organization_restricted_reason}
                    overLimit={user.organization_over_limit}
                    canChoosePlan={allows(user, "settings:manage", "admin")}
                  />
                ) : null}
                <TwoFactorGraceBanner standing={user.organization_two_factor} tz={displayTz} />
                {grace && sessionDigest ? (
                  <TwoFactorDueDialog session={sessionDigest} {...grace} />
                ) : null}
                {/* Below 768px the rail is an off-canvas drawer, so something has to
                    open it. Above 768px this bar is display:none and the rail is
                    simply the rail. */}
                <MobileNavBar />
                <div className="flex min-h-0 flex-1">
                  {/* The rail now follows the theme, so it needs a hairline to read as
                    a separate zone — previously the dark navy fill did that job.
                    It used to carry `max-md:hidden`, which left the app with NO
                    navigation on a phone; the drawer behaviour is in globals.css so
                    this stays a server component. */}
                  <aside className="app-rail relative flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground">
                    {/* Where you are and the switch to anywhere else, then search. The wordmark
                      box, "Go to", the Live/Test pill, "All businesses" and the business card
                      used to stack here — ~210px before the first page. */}
                    {/* The disc on the rail edge that collapses it; positioned against the aside. */}
                    <NavCollapseToggle />
                    {/* The product. Collapsed, only the icon stays. */}
                    <div className="rail-tools mb-3 flex h-9 items-center gap-1 pl-1.5">
                      <Link
                        href="/"
                        title="Two Minute Billing"
                        className="nav-row flex items-center"
                      >
                        <Wordmark />
                      </Link>
                    </div>
                    <RailHeader
                      businesses={businesses}
                      orgName={orgs.find((o) => o.current)?.name ?? "Organization"}
                      orgIconUrl={orgs.find((o) => o.current)?.icon_url}
                    />
                    <div className="mt-2">
                      <GoToRow />
                    </div>
                    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-3">
                      <AppNav
                        orgItems={navItems.filter((i) => i.href !== "/whats-new")}
                        businesses={businesses}
                        perms={perms}
                        bizCounts={bizCounts}
                      />
                    </div>
                    <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border pt-3">
                      {/* The Live/Test SWITCH, at org level only — where it filters the list and the
                        totals. A business states its own mode on the header's pill. */}
                      <div data-collapse="hide">
                        <ModeToggle />
                      </div>
                      <WhatsNewRow unread={unread.length} />
                      <AccountMenu
                        email={user.email}
                        name={user.name ?? null}
                        avatarUrl={user.avatar_url ?? null}
                        role={user.role}
                        orgs={orgs}
                        pendingInvites={invites.length}
                      />
                    </div>
                  </aside>
                  <main className="min-w-0 flex-1 overflow-y-auto">
                    {/* Was max-w-6xl (1152px), which forced dense billing tables to
                      truncate — the subscriptions table overflowed its container by
                      308px while 255px of gutter sat empty. Wide enough now that
                      lists get the room; pages needing a reading measure constrain
                      themselves. */}
                    {/* Wraps the PAGE, not the chrome: only routed content renders dates,
                      and inside /businesses/[biz] a BusinessTzProvider nests below this
                      one and wins (`useDisplayTz` prefers the narrower scope). */}
                    <div className="mx-auto w-full max-w-[1600px] px-5 py-8 md:px-10 md:py-10">
                      <OrgTzProvider tz={displayTz}>{children}</OrgTzProvider>
                    </div>
                  </main>
                  <AppShellPalette navItems={navItems} businesses={businesses} />
                  {/* Announces unread notes once. It renders nothing when there is nothing
                      unread, and nothing on /whats-new — see the component. */}
                  <WhatsNewDialog unread={unread} total={releaseNotes.length} />
                  {/* Offered once, on a business home; replayable from the setup steps. */}
                  <ProductTour offer={user.product_tour_seen === false} />
                </div>
              </div>
            </NavCollapseProvider>
          </ModeProvider>
        </Providers>
      </body>
    </html>
  );
}

/**
 * What an operator sees when the engine cannot be reached — instead of the login screen.
 *
 * Renders its own `<html>` because this layout owns the document for the whole signed-in
 * group; there is no root layout to fall back to. Deliberately dependency-free: no
 * `Providers`, no nav, no session — the point is that it renders when nothing else can.
 * Scrollable (no `overflow-hidden`), because this branch has no `<main>` to own scrolling.
 *
 * The message says the session is intact, because the bug it replaces made people believe
 * they had been signed out and retype credentials mid-form.
 */
function ApiUnavailableShell({ detail }: { detail: string }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="bg-background font-sans text-foreground antialiased">
        <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-3 px-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            We could not connect to the tmbilling API
          </h1>
          <p className="text-sm text-muted-foreground">
            You are still signed in. The dashboard could not confirm your session. Reload the page
            when the API is available again. You do not need to sign in again.
          </p>
          <p className="font-mono text-xs text-muted-foreground">{detail}</p>
          {/* A plain anchor, not next/link: this branch renders when the app shell could not
              be built, so a full document request is the honest retry. */}
          <p>
            <a href="/" className="text-sm text-primary hover:underline">
              Reload
            </a>
          </p>
        </div>
      </body>
    </html>
  );
}
