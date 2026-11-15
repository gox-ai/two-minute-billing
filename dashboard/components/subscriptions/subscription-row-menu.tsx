"use client";

import { CreditCard, Pencil, Receipt, User } from "lucide-react";
import { RowMenu, copyIdItem } from "@/components/patterns/row-menu";

/**
 * Row menu for a subscription: navigation and copy only, deliberately. The lifecycle
 * mutations (cancel, pause, change term) need the subscription's full state, which a list
 * row does not carry, so they stay in the detail page's dialogs; "Change subscription"
 * goes to the real change page.
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
  const base = `/businesses/${biz}/subscriptions/${id}`;
  return (
    <RowMenu
      label={label}
      groups={[
        {
          label: "References",
          items: [
            {
              label: "View invoices",
              icon: <Receipt className="size-4" />,
              href: `${base}#history`,
            },
            customer
              ? {
                  label: "View customer",
                  icon: <User className="size-4" />,
                  href: `/businesses/${biz}/customers/${customer}`,
                }
              : null,
          ],
        },
        {
          label: "Quick actions",
          items: [
            { label: "View subscription", icon: <CreditCard className="size-4" />, href: base },
            {
              label: "Change subscription",
              icon: <Pencil className="size-4" />,
              href: `${base}/change`,
            },
            copyIdItem("subscription", id),
          ],
        },
      ]}
    />
  );
}
