"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Chip } from "@/components/patterns/chip";
import { BizMark, type BizRef } from "@/components/AppNav";

/**
 * The top of the rail: where you are, and the switch to anywhere else.
 *
 * Inside a business: the business itself — its mark, name and Live/Test pill — which opens the
 * switcher; Organization home is its first item. This replaces four stacked pieces (the
 * Live/Test badge, "All businesses", the business card and its raw id). At org level the same
 * control shows the organization and still opens the switcher.
 *
 * Switching keeps you on the same kind of page (Subscriptions → Subscriptions) but never on a
 * record, which belongs to the business you left.
 */
export function RailHeader({
  businesses,
  orgName,
  orgIconUrl,
}: {
  businesses: BizRef[];
  orgName: string;
  /** The organization's own logo; without one the org level shows the product mark. */
  orgIconUrl?: string | null;
}) {
  const path = usePathname();
  const biz = path.match(/^\/businesses\/([^/]+)/)?.[1];
  const current = biz ? businesses.find((b) => b.id === biz) : undefined;
  const section = biz ? path.split("/")[3] : undefined;
  const target = (id: string) => `/businesses/${id}${section ? `/${section}` : ""}`;
  const sorted = [...businesses].sort((a, z) => a.name.localeCompare(z.name));
  // A test twin is the same business in its other mode — reached by the Mode switch, not
  // listed twice. Only standalone test businesses get their own group.
  const groups = [
    { label: "Businesses", rows: sorted.filter((b) => b.livemode === "live") },
    {
      label: "Standalone test businesses",
      rows: sorted.filter((b) => b.livemode === "test" && !b.liveBusinessId),
    },
  ].filter((g) => g.rows.length > 0);
  // In test mode, the business you are in is the live row it belongs to.
  const selected = current?.liveBusinessId ?? biz;

  const name = biz ? (current?.name ?? "Business") : orgName;
  // A business needs no second fact beside its mode; the org line says what it spans.
  const listed = groups.reduce((n, g) => n + g.rows.length, 0);
  const sub = biz ? null : `${listed} ${listed === 1 ? "business" : "businesses"}`;

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${biz ? "Business" : "Organization"}: ${name}. Switch business`}
            // The full name, for the one that still does not fit.
            title={name}
            className="nav-row flex h-13 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-sidebar-border bg-sidebar px-2.5 text-left transition-colors hover:bg-sidebar-accent/60 data-[state=open]:border-brand-border data-[state=open]:bg-brand-soft"
          >
            {biz ? (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent/60 text-sidebar-foreground/80">
                <BizMark iconUrl={current?.iconUrl} className="" large />
              </span>
            ) : orgIconUrl ? (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent/60">
                {/* eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host */}
                <img src={orgIconUrl} alt="" className="size-7 rounded-md object-contain" />
              </span>
            ) : (
              // The product's own icon.
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent/60">
                {/* eslint-disable-next-line @next/next/no-img-element -- a static public asset */}
                <img src="/favicon.svg" alt="" className="size-6" />
              </span>
            )}
            <span data-collapse="hide" className="min-w-0 flex-1 leading-tight">
              {/* The name gets the whole first line and the mode pill sits below it, so a long
                  name is not cut short to make room for "Test". */}
              <span className="block truncate text-sm font-semibold text-sidebar-foreground">
                {name}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                {current ? (
                  <Chip
                    tone={current.livemode === "test" ? "tan" : "green"}
                    title={
                      current.livemode === "test"
                        ? "A sandbox: nothing here bills a real customer"
                        : "Live: this business bills real customers"
                    }
                    className="px-1.5 py-0 leading-4"
                  >
                    {current.livemode === "test" ? "Test" : "Live"}
                  </Chip>
                ) : null}
                {sub ? (
                  <span className="truncate text-xs text-sidebar-foreground/60">{sub}</span>
                ) : null}
              </span>
            </span>
            <ChevronsUpDown
              aria-hidden
              data-collapse="hide"
              className="size-4 shrink-0 text-sidebar-foreground/40"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-72 overflow-y-auto">
          <DropdownMenuItem asChild>
            <Link href="/">
              {orgIconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host
                <img
                  src={orgIconUrl}
                  alt=""
                  className="size-4 shrink-0 rounded-sm object-contain"
                />
              ) : (
                <Building2 className="size-4" />
              )}
              <span className="flex-1">Organization home</span>
              {!biz ? <Check className="size-4" /> : null}
            </Link>
          </DropdownMenuItem>
          {groups.map((g) => (
            <React.Fragment key={g.label}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
              {g.rows.map((b) => (
                <DropdownMenuItem key={b.id} asChild>
                  <Link href={target(b.id)}>
                    <BizMark iconUrl={b.iconUrl} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <Check className={cn("size-4", b.id !== selected && "invisible")} />
                  </Link>
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
