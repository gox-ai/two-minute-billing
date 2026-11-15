"use client";

import { CreditCard, Pencil, Plus, Receipt, User } from "lucide-react";
import { RowMenu, copyIdItem } from "@/components/patterns/row-menu";

/**
 * Row menu for a customer: references (the customer's subscriptions and invoices), then
 * quick actions (view, edit on a full page, start a subscription, copy the id).
 */
export function CustomerRowMenu({ biz, id, label }: { biz: string; id: string; label: string }) {
  const base = `/businesses/${biz}/customers/${id}`;
  return (
    <RowMenu
      label={label}
      groups={[
        {
          label: "References",
          items: [
            {
              label: "View subscriptions",
              icon: <CreditCard className="size-4" />,
              href: `${base}#subscriptions`,
            },
            {
              label: "View invoices",
              icon: <Receipt className="size-4" />,
              href: `${base}#history`,
            },
          ],
        },
        {
          label: "Quick actions",
          items: [
            { label: "View customer", icon: <User className="size-4" />, href: base },
            { label: "Edit", icon: <Pencil className="size-4" />, href: `${base}/edit` },
            {
              label: "Create subscription",
              icon: <Plus className="size-4" />,
              href: `/businesses/${biz}/subscriptions/new?customer=${id}`,
            },
            copyIdItem("customer", id),
          ],
        },
      ]}
    />
  );
}
