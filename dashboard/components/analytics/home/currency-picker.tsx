"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * Which currency the page reports in — `ALL` converts at the rates in Settings, a code
 * scopes every figure to money actually held in it. Drives `?currency=`, so the server
 * re-reads; no client data layer, and the choice is in the link.
 *
 * A business holding one currency gets a label and no menu: a picker with a single
 * option implies a choice that does not exist.
 */
export function CurrencyPicker({
  value,
  baseCurrency,
  available,
}: {
  /** `ALL` or a currency code. */
  value: string;
  /** What an `ALL` roll-up reports in — the business default. */
  baseCurrency: string;
  available: string[];
}) {
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("currency");
  const pathname = usePathname();
  const params = useSearchParams();

  const label = (v: string) => (v === "ALL" ? `Reported in ${baseCurrency}` : `Reported in ${v}`);

  if (available.length < 2) {
    return (
      <span className="inline-flex h-9 items-center rounded-lg bg-muted/70 px-3 text-sm text-foreground/80">
        {label(value)}
      </span>
    );
  }

  const go = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v === "ALL") next.delete("currency");
    else next.set("currency", v);
    const q = next.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { source: "currency" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm hover:bg-accent">
        {label(value)}
        {pending ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {["ALL", ...available].map((o) => (
          <DropdownMenuItem key={o} onClick={() => go(o)} className="justify-between">
            {o === "ALL" ? `All currencies (${baseCurrency})` : o}
            {o === value ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
