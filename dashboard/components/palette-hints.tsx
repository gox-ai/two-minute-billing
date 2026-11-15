"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  dismissPaletteWelcome,
  openPalette,
  usePaletteKey,
  usePaletteUsed,
  usePaletteWelcomeDismissed,
} from "@/lib/palette-hints";

/** One card on the business home until the palette is opened or the card is closed. */
export function PaletteWelcome() {
  const keys = usePaletteKey();
  const used = usePaletteUsed();
  const dismissed = usePaletteWelcomeDismissed();
  if (used || dismissed || !keys) return null;
  return (
    <div className="anim-fade mb-6 flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-xl border border-brand-border bg-card bg-linear-to-r from-brand-soft to-card to-70% px-4 py-3.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-linear-to-b from-solid to-solid-bottom text-solid-foreground shadow-xs inset-shadow-[0_1px_0_rgb(255_255_255/0.35)]">
        <Search className="size-4.5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-0.5">
        <strong className="text-base font-medium">Find a record from any page</strong>
        <span className="text-sm text-muted-foreground">
          Press <Kbd mod>K</Kbd> or <Kbd>/</Kbd>. Then type a customer name, an email or an invoice
          number.
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
