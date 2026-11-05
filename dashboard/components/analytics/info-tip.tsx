"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CardInfo } from "@/components/analytics/card-info";

function Formula({ formula }: { formula?: string | string[] }) {
  const lines = formula == null ? [] : [formula].flat();
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5 rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
      {lines.map((f) => (
        <span key={f}>{f}</span>
      ))}
    </div>
  );
}

/**
 * The (i) beside a card's title. Opens on hover for a mouse, on tap or Enter otherwise.
 * Safe inside a link — the click is swallowed.
 */
export function InfoTip({ label, info }: { label: string; info: CardInfo }) {
  const [open, setOpen] = React.useState(false);
  const mouse = React.useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="touch-target relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground normal-case hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onPointerEnter={(e) => {
            mouse.current = e.pointerType === "mouse";
            if (mouse.current) setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setOpen(false);
          }}
          onClick={(e) => {
            // preventDefault also skips Radix's own toggle, so hover-then-click stays open.
            e.preventDefault();
            e.stopPropagation();
            setOpen((o) => (mouse.current ? true : !o));
            mouse.current = false;
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="flex w-72 flex-col gap-1 text-sm"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <span className="font-semibold">{label}</span>
        <p className="text-muted-foreground">{info.text}</p>
        <Formula formula={info.formula} />
        {info.terms && info.terms.length > 0 ? (
          <dl className="mt-1.5 flex flex-col gap-1.5 border-t pt-2 text-xs">
            {info.terms.map((t) => (
              <div key={t.label}>
                <dt className="inline font-medium">{t.label}</dt>{" "}
                <dd className="inline text-muted-foreground">{t.text}</dd>
                <Formula formula={t.formula} />
              </div>
            ))}
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
