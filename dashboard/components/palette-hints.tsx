"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dismissPaletteWelcome,
  openPalette,
  usePaletteKey,
  usePaletteUsed,
  usePaletteWelcomeDismissed,
} from "@/lib/palette-hints";

function Keys({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border bg-card px-1.5 py-0.5 font-sans text-xs font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * Beside a list's search box: the palette searches customers, subscriptions and invoices
 * together, so only those three lists carry it. Gone once the palette has been opened.
 */
export function PaletteSearchHint() {
  const keys = usePaletteKey();
  const used = usePaletteUsed();
  if (used || !keys) return null;
  return (
    <button
      type="button"
      onClick={openPalette}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Keys>{keys}</Keys> or <Keys>/</Keys> Search all records
    </button>
  );
}

/** One card on the business home until the palette is opened or the card is closed. */
export function PaletteWelcome() {
  const keys = usePaletteKey();
  const used = usePaletteUsed();
  const dismissed = usePaletteWelcomeDismissed();
  if (used || dismissed || !keys) return null;
  return (
    <div className="anim-fade mb-6 flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-xl border border-brand-border bg-card bg-linear-to-r from-brand-soft to-card to-70% px-4 py-3.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-linear-to-b from-solid to-solid-bottom text-solid-foreground shadow-xs inset-shadow-[0_1px_0_rgb(255_255_255/0.35)]">
        <Search className="size-4.5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-0.5">
        <strong className="text-base font-medium">Find a record from any page</strong>
        <span className="text-sm text-muted-foreground">
          Press <Keys>{keys}</Keys> or <Keys>/</Keys>. Then type a customer name, an email or an
          invoice number.
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" className="bg-card" onClick={openPalette}>
          Open search
        </Button>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={dismissPaletteWelcome}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
