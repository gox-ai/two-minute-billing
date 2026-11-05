"use client";

import * as React from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Avatar. The rail's user block hand-rolls this today (a rounded div with a
 * single uppercased character), so there is no shared fallback behaviour and no
 * image support at all.
 *
 * Deliberately neutral, not tinted per-user: a colour generated from a hash
 * reads as meaningful state to an operator scanning a billing screen, and it
 * isn't.
 */
function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

/**
 * `no-referrer` by default: Google's photo host can refuse a request that carries one. Radix
 * preloads with the same policy and shows the fallback if the image fails.
 */
function AvatarImage({
  className,
  referrerPolicy = "no-referrer",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      referrerPolicy={referrerPolicy}
      className={cn("aspect-square size-full object-cover", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        // `bg-card` + a hairline rather than `bg-muted`: a muted fill made the
        // circle vanish into the rail. It was `bg-background`, which worked only
        // while that was the same white as a card — R2 separates them, and the
        // rail is a card-coloured surface. This reads as a circle on any of them.
        "flex size-full items-center justify-center rounded-full border bg-card text-xs font-semibold text-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
