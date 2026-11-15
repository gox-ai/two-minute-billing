"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import type { BizRef } from "@/components/AppNav";
import { BizMark } from "@/components/business-mark";
import { useRailMenu } from "@/components/rail-footer";

/** From this many businesses the menu gets a search box; below it the list reads at a glance. */
const SEARCH_FROM = 8;

/**
 * The top of the rail: where you are, and the switch to anywhere else.
 *
 * Inside a business: its mark, name and Live/Test pill, which open the switcher; Organization
 * home is its first item. At org level the same control shows the organization. A long name
 * wraps to a second line rather than being cut, and a Test business puts a dot on its mark, so
 * the mode still shows on the collapsed rail.
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
  // Switching keeps the mode: from a test business, a live row opens its test twin (when it
  // has one), so a person testing stays in test mode.
  const inTest = current?.livemode === "test";
  const opens = (b: BizRef) =>
    inTest && b.livemode === "live" && b.testBusinessId ? b.testBusinessId : b.id;
  /** The mode a row lands in: a live row with no test twin takes you out of Test. */
  const lands = (b: BizRef) => (opens(b) === b.id ? b.livemode : "test");
  const byId = new Map(businesses.map((b) => [b.id, b]));
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

  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? groups
        .map((g) => ({ ...g, rows: g.rows.filter((b) => b.name.toLowerCase().includes(q)) }))
        .filter((g) => g.rows.length > 0)
    : groups;

  const { triggerRef, onOpenChange, content } = useRailMenu("bottom", "start");
  const mode = current ? (current.livemode === "test" ? "Test" : "Live") : null;

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu
        onOpenChange={(open) => {
          onOpenChange(open);
          if (!open) setQuery("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${biz ? "Business" : "Organization"}: ${name}${mode ? `, ${mode.toLowerCase()} mode` : ""}. Switch business`}
            className="nav-row flex min-h-13 min-w-0 flex-1 items-center gap-2 rounded-xl border border-sidebar-border bg-sidebar px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60 in-data-[nav=collapsed]:min-h-0 data-[state=open]:border-brand-border data-[state=open]:bg-brand-soft"
          >
            <span className="relative shrink-0">
              {biz ? (
                <BizMark
                  name={name}
                  iconUrl={current?.iconUrl}
                  brandColor={current?.brandColor}
                  size="7"
                />
              ) : (
                <span className="flex size-7 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent/60">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a tenant URL, or our own icon */}
                  <img
                    src={orgIconUrl ?? "/favicon.svg"}
                    alt=""
                    className="size-5 rounded-md object-contain"
                  />
                </span>
              )}
              {inTest ? (
                <span
                  aria-hidden
                  className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-warning ring-2 ring-sidebar"
                />
              ) : null}
            </span>
            <span data-collapse="hide" className="min-w-0 flex-1 leading-tight">
              <span className="line-clamp-2 text-sm/tight font-semibold wrap-anywhere text-sidebar-foreground">
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
                  >
                    {mode}
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
              className="size-3.5 shrink-0 text-sidebar-foreground/40"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          {...content}
          // At least 288px: business names are the whole point of this menu, and the rail is
          // narrower than most of them.
          className={cn("max-h-[70vh] overflow-y-auto", content.className, "min-w-72")}
        >
          {listed >= SEARCH_FROM ? <SwitcherSearch value={query} onChange={setQuery} /> : null}
          <DropdownMenuItem asChild>
            <Link href="/">
              {orgIconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host
                <img src={orgIconUrl} alt="" className="size-6 shrink-0 object-contain" />
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                  <Building2 className="size-3.5" />
                </span>
              )}
              <span className="min-w-0 flex-1">Organization home</span>
              <Check className={cn("size-4", biz && "invisible")} />
            </Link>
          </DropdownMenuItem>
          {shown.map((g) => (
            <React.Fragment key={g.label}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-baseline justify-between gap-2 text-xs font-normal text-muted-foreground">
                <span>{g.label}</span>
                {inTest && g.rows.some((b) => b.livemode === "live" && lands(b) === "test") ? (
                  <span>Opens in Test</span>
                ) : null}
              </DropdownMenuLabel>
              {g.rows.map((b) => {
                const isCurrent = b.id === selected;
                return (
                  <DropdownMenuItem
                    key={b.id}
                    asChild
                    className={cn(isCurrent && "bg-brand-soft font-medium")}
                  >
                    <Link
                      href={target(opens(b))}
                      data-biz-row=""
                      aria-current={isCurrent ? "true" : undefined}
                    >
                      {/* The mark of the business it opens, so in Test it matches the trigger. */}
                      <BizMark
                        name={b.name}
                        iconUrl={(byId.get(opens(b)) ?? b).iconUrl}
                        brandColor={(byId.get(opens(b)) ?? b).brandColor}
                      />
                      <span className="line-clamp-2 min-w-0 flex-1 wrap-anywhere">{b.name}</span>
                      {/* The exception to "Opens in Test": no test twin, so this opens Live. */}
                      {inTest && lands(b) === "live" ? <Chip tone="green">Live</Chip> : null}
                      <Check className={cn("size-4", !isCurrent && "invisible")} />
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </React.Fragment>
          ))}
          {q && shown.length === 0 ? (
            <>
              <DropdownMenuSeparator />
              <p className="px-2.5 py-2 text-sm text-muted-foreground">
                No business matches your search.
              </p>
              <DropdownMenuItem
                onSelect={(e) => {
                  // Keep the menu open: the person is still looking.
                  e.preventDefault();
                  setQuery("");
                }}
              >
                Clear search
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Filters the rows as you type. The menu's own keys would otherwise take the letters (its
 * typeahead jumps to a row), so only Escape, Tab and ArrowDown leave the box: ArrowDown moves
 * into the rows, Enter opens the first match.
 */
function SwitcherSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  // The menu focuses itself on open; take the focus after it.
  React.useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const rows = () =>
    ref.current?.closest('[role="menu"]')?.querySelectorAll<HTMLElement>("[data-biz-row]");
  return (
    <div className="relative mb-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={ref}
        type="text"
        enterKeyHint="go"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Tab") return;
          e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            rows()?.[0]?.focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            rows()?.[0]?.click();
          }
        }}
        aria-label="Search businesses"
        placeholder="Search businesses"
        className="pr-2.5 pl-8"
      />
    </div>
  );
}
