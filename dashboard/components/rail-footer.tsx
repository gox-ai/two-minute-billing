"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ChevronsUpDown, LogOut, MailOpen, Sparkles, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/components/patterns/record-page";
import { NavBadge } from "@/components/SideNav";
import { logoutAction, switchOrganizationAction } from "@/app/auth-actions";
import { setThemeAction } from "@/app/(dashboard)/account/actions";

/** Release notes, pinned above the person: product news, not a place you work. */
export function WhatsNewRow({ unread }: { unread: number }) {
  const path = usePathname();
  const active = path === "/whats-new";
  return (
    <Link
      href="/whats-new"
      title="What's new"
      aria-current={active ? "page" : undefined}
      className={cn(
        "nav-row relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Sparkles
        className={cn("size-4.5 shrink-0", active ? "text-sidebar-primary" : "opacity-80")}
      />
      <span className="nav-label">What&apos;s new</span>
      {unread ? <NavBadge count={unread} /> : null}
    </Link>
  );
}

export interface OrgOption {
  id: string;
  name: string;
  role: string;
  current: boolean;
}

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
] as const;

/**
 * The person, as one row: everything personal lives behind it — the account page, the
 * organizations they belong to, theme, sign out. It replaces an identity block, a theme icon
 * and a sign-out row that sat loose at the foot of the rail.
 */
export function AccountMenu({
  email,
  name,
  avatarUrl,
  role,
  orgs,
  pendingInvites = 0,
}: {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  orgs: OrgOption[];
  /** Invites to other organizations that wait for this person (0498). */
  pendingInvites?: number;
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  // The theme is only known in the browser; until then no segment claims to be current.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setMounted(true), []);
  const current = orgs.find((o) => o.current);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          title={email}
          className="nav-row flex h-12 w-full items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent"
        >
          <Avatar className="size-8">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
            <AvatarFallback>
              {name ? initials(name) : (email[0] ?? "u").toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span data-collapse="hide" className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold text-sidebar-foreground">
              {name || email}
            </span>
            <span className="block truncate text-xs text-sidebar-foreground/60 capitalize">
              {role}
              {current ? ` · ${current.name}` : ""}
            </span>
          </span>
          <ChevronsUpDown
            data-collapse="hide"
            className="size-4 shrink-0 text-sidebar-foreground/40"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel className="font-normal">
          {name ? <div className="truncate text-sm font-medium">{name}</div> : null}
          <div
            className={cn(
              "truncate",
              name ? "text-xs text-muted-foreground" : "text-sm font-medium",
            )}
          >
            {email}
          </div>
          <div className="text-xs text-muted-foreground capitalize">
            {role}
            {current ? ` in ${current.name}` : ""}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRound className="size-4" />
            Your account
          </Link>
        </DropdownMenuItem>
        {pendingInvites > 0 ? (
          <DropdownMenuItem asChild>
            <Link href="/invitations">
              <MailOpen className="size-4" />
              <span className="flex-1">Invites</span>
              <NavBadge count={pendingInvites} />
            </Link>
          </DropdownMenuItem>
        ) : null}
        {/* Only for someone in more than one organization: a switch with one choice does nothing.
            Each row posts the org's public id; the server re-checks membership before moving
            the session, so this list is convenience, not the control. */}
        {orgs.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {orgs.map((o) => (
              <form key={o.id} action={switchOrganizationAction}>
                <input type="hidden" name="organization" value={o.id} />
                <DropdownMenuItem asChild>
                  <button type="submit" className="w-full">
                    <span className="min-w-0 flex-1 truncate text-left">{o.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">{o.role}</span>
                    <Check className={cn("size-4", !o.current && "invisible")} />
                  </button>
                </DropdownMenuItem>
              </form>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
          Theme
          <div role="group" aria-label="Theme" className="flex rounded-md border p-0.5">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={mounted && theme === t.value}
                onClick={() => {
                  setTheme(t.value);
                  // Saved on the account too, or the next page load's ThemeSync would undo it.
                  void setThemeAction(t.value);
                }}
                className={cn(
                  "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                  mounted && theme === t.value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <DropdownMenuSeparator />
        <form action={logoutAction}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut className="size-4" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
