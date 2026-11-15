"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RowMenuItem {
  label: string;
  icon?: React.ReactNode;
  /** Navigate in the app. */
  href?: string;
  /** A file download or a page outside the router (a PDF route). */
  download?: string;
  onSelect?: () => void;
}

export interface RowMenuGroup {
  /** Sentence case. */
  label?: string;
  items: (RowMenuItem | null | false | undefined)[];
}

/**
 * The ⋯ menu at the end of a list row. Every item reaches a real destination; pass
 * `null` for an item the row cannot offer rather than a disabled one.
 */
export function RowMenu({ label, groups }: { label: string; groups: RowMenuGroup[] }) {
  const router = useRouter();
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((i): i is RowMenuItem => !!i) }))
    .filter((g) => g.items.length > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Actions for ${label}`}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {shown.map((g, gi) => (
          <React.Fragment key={g.label ?? gi}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            {g.label ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {g.label}
              </DropdownMenuLabel>
            ) : null}
            {g.items.map((i) =>
              i.download ? (
                <DropdownMenuItem key={i.label} asChild>
                  <a href={i.download}>
                    {i.icon}
                    {i.label}
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  key={i.label}
                  onSelect={() => (i.href ? router.push(i.href) : i.onSelect?.())}
                >
                  {i.icon}
                  {i.label}
                </DropdownMenuItem>
              ),
            )}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Copy <thing> ID": puts the id on the clipboard and confirms it. */
export function copyIdItem(thing: string, id: string): RowMenuItem {
  return {
    label: `Copy ${thing} ID`,
    icon: <Copy className="size-4" />,
    onSelect: () => {
      navigator.clipboard.writeText(id).then(
        () => toast.success(`${thing[0].toUpperCase()}${thing.slice(1)} ID copied.`),
        () => toast.error(`We could not copy the ${thing} ID.`),
      );
    },
  };
}
