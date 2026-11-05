"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  // `w-fit` sizes the strip to its content and the triggers are `whitespace-nowrap`,
  // so a long tab list could not shrink: at 390px the brand settings strip measured
  // 465px and pushed the page 105px sideways (/whats-new, 452px, did the same).
  // `max-w-full` lets it be constrained and `overflow-x-auto` scrolls the excess
  // instead of shoving the layout.
  //
  // Setting overflow on one axis makes the OTHER compute to `auto` too, so this
  // does clip vertically — measured on the `line` variant, whose active underline
  // sits 5px below its trigger: the trigger's bottom is 13px above the list's, so
  // the underline lands 8px inside the box and still paints (opacity 1). Don't
  // give the triggers more height without re-checking that.
  //
  // `overflow-y-hidden`: the content is 1px taller than the list, and with `auto` on
  // that axis Chrome painted a 10px vertical scrollbar beside the last trigger.
  //
  // The default variant is the segmented control (`./segmented`): a bordered muted track,
  // the selected trigger a raised pill. The URL tab navs share those classes.
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-center overflow-x-auto overflow-y-hidden text-muted-foreground group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none group-data-[orientation=horizontal]/tabs:data-[variant=line]:h-9",
  {
    variants: {
      variant: {
        default:
          "gap-1 rounded-xl border bg-muted/60 p-1 group-data-[orientation=horizontal]/tabs:h-10",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-xs group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground hover:dark:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "group-data-[variant=default]/tabs-list:rounded-lg group-data-[variant=default]/tabs-list:px-3 data-[state=active]:bg-raised data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
