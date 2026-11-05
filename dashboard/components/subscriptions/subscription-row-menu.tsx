"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, CreditCard, MoreHorizontal, Pencil, Receipt, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * Row menu for a subscription: a grouped list kebab.
 *
 * Navigation + copy only, deliberately. The lifecycle mutations (cancel / pause /
 * change term) are left out: those live in dialogs
 * that the detail page owns (`lifecycle-dialogs.tsx`) and need the subscription's
 * full state — plan, period, offered reason codes — which the list row does not
 * carry. Rendering them here would mean a control that either can't submit or
 * submits against half-known state, so `Change Subscription` routes to the real
 * change page instead. Every item below reaches a working destination.
 */
export function SubscriptionRowMenu({
  biz,
  id,
  customer,
  label,
}: {
  biz: string;
  id: string;
  customer?: string | null;
  label: string;
}) {
  const router = useRouter();
  const base = `/businesses/${biz}/subscriptions/${id}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Actions for ${label}`}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          References
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => router.push(`${base}#history`)}>
          <Receipt className="size-4" />
          View associated Invoices
        </DropdownMenuItem>
        {customer ? (
          <DropdownMenuItem
            onSelect={() => router.push(`/businesses/${biz}/customers/${customer}`)}
          >
            <User className="size-4" />
            View Customer
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Quick Actions
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => router.push(base)}>
          <CreditCard className="size-4" />
          View Subscription
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(`${base}/change`)}>
          <Pencil className="size-4" />
          Change Subscription
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(id).then(
              () => toast.success("Subscription ID copied"),
              () => toast.error("We could not copy the subscription ID."),
            );
          }}
        >
          <Copy className="size-4" />
          Copy Subscription ID
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
