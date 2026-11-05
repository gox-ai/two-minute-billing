"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { searchCustomersAction, type PickerCustomer } from "@/app/actions";

/**
 * Pick a customer by SEARCHING THE SERVER, not by filtering a bulk read.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Both callers used to be handed `listCustomers(biz, { limit: 1000 })` and filter it
 * in the browser. Customer 1001 was simply unfindable, and the failure was silent:
 * no "showing 1000 of N", no hint — a search that confidently returned nothing, so
 * an operator concluded the customer did not exist. `?q=` is the list endpoint's own
 * free-text search over id/email/name/company/phone and runs in SQL, so the cap here
 * bounds the RESULT set, not the searchable set. When it bites, the footer says so.
 *
 * Callers own their trigger and their form field — this is the dialog only. The
 * subscription-create takeover opens it from a chip beside the header; the
 * manual-invoice dialog opens it from a field-shaped button. Sharing the trigger
 * too would have meant a render prop for no gain.
 *
 * `initial` is the first page the server component already fetched, shown before a
 * query is typed so the dialog is never empty on open. Every keystroke after that
 * comes from the server.
 */
export function CustomerPicker({
  biz,
  open,
  onOpenChange,
  onSelect,
  initial = [],
  title = "Select a customer",
  description,
}: {
  biz: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chosen row, whole — callers need `effective_currency`, not just the id. */
  onSelect: (customer: PickerCustomer) => void;
  initial?: PickerCustomer[];
  title?: string;
  description?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState<PickerCustomer[]>(initial);
  const [capped, setCapped] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset to the seeded page each time the dialog opens, so a stale query from a
  // previous open does not decide what the operator sees first.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setRows(initial);
    setCapped(false);
    setError(null);
    // `initial` is a fresh array literal on most renders; keying the reset on `open`
    // alone is deliberate, and depending on it too would re-reset mid-search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Debounced, and it does NOT skip the empty query: clearing the box must go back to
  // the first page rather than leave the last search's results on screen.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await searchCustomersAction(biz, query);
      if (cancelled) return;
      setBusy(false);
      if (res.ok) {
        setRows(res.customers);
        setCapped(res.capped);
        setError(null);
      } else {
        setRows([]);
        setCapped(false);
        setError(res.error);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [biz, query, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="gap-0 p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, company, phone or ID…"
              className="pl-8"
              aria-label="Search customers"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {busy ? "Searching…" : query ? "No matching customers." : "No customers yet."}
            </p>
          ) : (
            rows.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSelect(c);
                  onOpenChange(false);
                }}
                className="flex w-full flex-col items-start gap-0.5 border-b px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-accent"
              >
                <span className="text-sm font-medium">{c.label}</span>
                <span className="text-xs text-muted-foreground">{c.sub ?? c.id}</span>
              </button>
            ))
          )}
        </div>
        {/* A cap that says nothing reads as "that's all of them", which is the whole
            defect this component replaces. */}
        {capped ? (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            More customers match than the list shows. Type more text to narrow the list.
          </p>
        ) : null}
        <div className="border-t p-3 text-center">
          <a
            href={`/businesses/${biz}/customers`}
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <Plus className="size-4" /> Create customer
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
