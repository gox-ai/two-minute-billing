import * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

/**
 * ⚠️ This is a GRID, and `flex-row` does not make it a flex row.
 *
 * Seven headers on the customer detail page passed
 * `className="flex-row items-center justify-between"` to put an action opposite
 * the title. `flex-row` is a FLEX-DIRECTION utility, so tailwind-merge keeps it
 * in a different group from `display` and leaves this `grid` in place: the
 * direction applied to a grid container, which does nothing, and every one of
 * those actions stacked under its title instead. Measured on Custom Fields —
 * "Edit" sat on its own line, indented, on a 653px card.
 *
 * Two things work. `className="flex …"` replaces `grid` (same tailwind-merge
 * group) — that is what those seven now use. Or wrap the action in
 * `<CardAction>`, whose `data-slot` flips this to `grid-cols-[1fr_auto]`, which
 * is the right choice when a description also has to share the row.
 */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
