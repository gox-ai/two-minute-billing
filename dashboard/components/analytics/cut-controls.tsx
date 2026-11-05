"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * One cut decision as a button that opens a menu of real destinations (each item
 * is a `Link`, so the URL stays the state — shareable, back-button-safe, and
 * fetched server-side). Shared by every screen that cuts a measure the same four
 * ways: range, grain, split-by, compare.
 */
export function CutMenu({
  label,
  current,
  options,
  active = false,
}: {
  label: string;
  current: string;
  /**
   * Each option carries its OWN href, already built. A server component cannot hand a
   * function across the client boundary — React refuses it — so the caller resolves the
   * URLs and this component only renders them.
   */
  options: Array<{ id: string; label: string; href: string }>;
  /** Highlighted when this cut is doing something beyond the default (e.g. split is on). */
  active?: boolean;
}) {
  const currentLabel = options.find((o) => o.id === current)?.label ?? current;
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom(label);
  // Controlled: preventing the Link's click also skips the menu's own close-on-select.
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={active ? "secondary" : "outline"}
          size="sm"
          className="gap-2"
          aria-label={`${label}: ${currentLabel}`}
        >
          {currentLabel}
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} asChild>
            <Link
              href={o.href}
              aria-current={o.id === current ? "true" : undefined}
              onClick={(e) => {
                // A modified click keeps the browser's own behaviour (new tab, new window).
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                setOpen(false);
                navigate(o.href, { source: label });
              }}
            >
              {o.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
