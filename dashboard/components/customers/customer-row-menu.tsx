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
 * Row menu for a customer, a grouped list kebab:
 * References (jump to the customer's subscriptions / invoices) + Quick Actions
 * (edit on a full page, start a subscription, copy the id).
 */
export function CustomerRowMenu({ biz, id, label }: { biz: string; id: string; label: string }) {
  const router = useRouter();
  const base = `/businesses/${biz}/customers/${id}`;

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
        <DropdownMenuItem onSelect={() => router.push(`${base}#subscriptions`)}>
          <CreditCard className="size-4" />
          View associated Subscriptions
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(`${base}#history`)}>
          <Receipt className="size-4" />
          View associated Invoices
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Quick Actions
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => router.push(base)}>
          <User className="size-4" />
          View Customer
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(`${base}/edit`)}>
          <Pencil className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => router.push(`/businesses/${biz}/subscriptions/new?customer=${id}`)}
        >
          <CreditCard className="size-4" />
          Create Subscription
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(id).then(
              () => toast.success("Customer ID copied"),
              () => toast.error("We could not copy the customer ID."),
            );
          }}
        >
          <Copy className="size-4" />
          Copy Customer ID
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
