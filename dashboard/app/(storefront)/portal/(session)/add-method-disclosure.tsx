"use client";

import * as React from "react";
import { ChevronDown, CirclePlus } from "lucide-react";

/**
 * "Add a payment method", as a disclosure rather than a permanently-open form.
 *
 * The add flow is a provider chooser plus a method chooser plus a submit — measured at
 * 722px in one column and 743px in the portal's right-hand column, roughly HALF the
 * Payment methods card. It was rendered open to every buyer, including one with five
 * saved instruments who is not adding a sixth. That is what made the card grow far
 * taller than everything beside it.
 *
 * Two rules decide the initial state, and both are about what the buyer came to do:
 *   - No saved method → open. Adding one is the only thing this section is for, and a
 *     closed form in front of an empty list is an obstacle, not tidiness.
 *   - Coming back from a provider redirect → open, so whatever the add flow has to say
 *     about that attempt is on screen rather than behind a click.
 *
 * The children stay MOUNTED when collapsed, hidden with the `hidden` attribute rather
 * than unmounted. `AddCard` runs effects that reconcile a half-finished vault setup
 * (`lib/pending-vault-setup.ts`), and unmounting it would silently stop them — a
 * collapsed panel must not change what the page does, only what it shows.
 */
export function AddMethodDisclosure({
  defaultOpen,
  children,
}: {
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
      >
        <CirclePlus className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          {/* The heading stays at the section's own size — a sub-block cannot outrank
              "Payment methods" above it — and the accent mark carries the weight. */}
          <span className="block text-sm font-semibold tracking-tight">Add a payment method</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Select how to pay future invoices.
          </span>
        </span>
        <ChevronDown
          className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>
      <div id={panelId} hidden={!open} className="mt-4">
        {children}
      </div>
    </>
  );
}
