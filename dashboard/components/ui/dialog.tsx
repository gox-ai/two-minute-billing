"use client";

import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DIALOG_FROM_CLICK } from "@/lib/motion";
import { InModalContext } from "@/components/ui/in-modal";
import {
  installPressOrigin,
  lastPress,
  originPercent,
  pressPoint,
  settledBox,
} from "@/lib/press-origin";

// At module load, not on mount: the press that opens a dialog comes before it mounts.
if (DIALOG_FROM_CLICK) installPressOrigin();

const placed = new WeakSet<HTMLElement>();

/**
 * Point a mounting dialog's `transform-origin` at the press that opened it. A callback ref
 * runs in the commit, before the first frame, so the entrance starts from the right point.
 * Phone width (bottom sheet) and reduced motion skip it; no recent press keeps the centre.
 */
function setPressOrigin(el: HTMLElement) {
  // Once per mount: a re-attached ref must not move the origin to a press inside the dialog.
  if (placed.has(el)) return;
  placed.add(el);
  if (window.matchMedia("(width < 40rem), (prefers-reduced-motion: reduce)").matches) return;
  const point = pressPoint(lastPress(), performance.now());
  if (!point) return;
  const box = settledBox(el.getBoundingClientRect(), el.offsetWidth, el.offsetHeight);
  const o = originPercent(point, box);
  if (!o) return;
  el.style.setProperty("--origin-x", `${o.x}%`);
  el.style.setProperty("--origin-y", `${o.y}%`);
}

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-scrim-out data-[state=open]:animate-scrim-in",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The four widths a dialog may be. `md` is the historical default (`sm:max-w-lg`), so
 * every existing caller renders exactly as before.
 */
const DIALOG_SIZE = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-[1100px]",
} as const;

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "md",
  dismissOnOutsideClick = false,
  motion = "dialog",
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  /** `pop` for a launcher (the ⌘K palette): quicker, menu-like. */
  motion?: "dialog" | "pop";
  /**
   * Let a click outside close this dialog. OFF for everything but the ⌘K palette.
   *
   * A named flag rather than a caller passing `onPointerDownOutside={undefined}`
   * through the spread: both work, but only one says why at the call site, and the
   * opt-out is a design decision worth being able to grep for.
   */
  dismissOnOutsideClick?: boolean;
  /**
   * How wide the dialog may get. USE THIS RATHER THAN A `max-w-*` CLASS.
   *
   * The base width is `sm:max-w-lg`, and a bare `max-w-[900px]` in `className` does not
   * override it — a media-query utility outranks an unprefixed one whatever
   * `tailwind-merge` does, since the two are different keys to it. Every caller asking
   * for something wider was silently rendering at 32rem, which is how the shadow event
   * inspector ended up wrapping `subscription` onto two lines.
   */
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const fromClick = DIALOG_FROM_CLICK && motion === "dialog";
  const contentRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el && fromClick) setPressOrigin(el);
      if (typeof ref === "function") return ref(el);
      if (ref) ref.current = el;
    },
    [ref, fromClick],
  );
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        ref={contentRef}
        /**
         * A CLICK OUTSIDE DOES NOT CLOSE A DIALOG HERE.
         *
         * Radix closes on outside press by default, which is right for a menu and
         * wrong for these: every dialog in this app either carries a form or asks
         * for a decision, and a stray click on the page behind one threw the
         * answer away with no undo. The storefront's payment dialog had already
         * opted out on its own for exactly that reason — this makes it the rule
         * rather than the one careful caller.
         *
         * Escape still closes, and so does the × and any Dismiss/Cancel button: a
         * dialog you cannot leave by keyboard is a trap, and the objection was to
         * losing work by accident, not to having an exit.
         *
         * Both handlers, deliberately: `onPointerDownOutside` covers the press and
         * `onInteractOutside` also covers focus leaving the dialog. Declared BEFORE
         * `{...props}` so a caller with a reason can still override either.
         */
        onPointerDownOutside={dismissOnOutsideClick ? undefined : (e) => e.preventDefault()}
        onInteractOutside={dismissOnOutsideClick ? undefined : (e) => e.preventDefault()}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-popover-border bg-popover p-6 shadow-lg outline-none",
          // A dialog springs up from .96 (or from the press: app/motion/dialog-origin.css);
          // the palette is a menu, so it pops like one.
          motion === "pop"
            ? "data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
            : fromClick
              ? "dialog-from-click"
              : "[--m-scale-out:0.98] [--m-scale:0.96] data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in",
          // Below 640px a dialog is a bottom sheet: pinned to the foot, slides up.
          motion === "dialog" &&
            "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-sm:[--m-y:100%] max-sm:data-[state=closed]:animate-sheet-out max-sm:data-[state=open]:animate-sheet-in",
          DIALOG_SIZE[size],
          className,
        )}
        {...props}
      >
        <InModalContext.Provider value={true}>{children}</InModalContext.Provider>
        {motion === "dialog" && showCloseButton ? <SheetGrabber closeRef={closeRef} /> : null}
        {showCloseButton && (
          <DialogPrimitive.Close
            ref={closeRef}
            data-slot="dialog-close"
            /**
             * A real hit target, pinned to the dialog's own top-right corner.
             *
             * ⚠️ A DIALOG MUST NOT SCROLL ON THIS ELEMENT. Put `overflow-y-auto` on
             * DialogContent and it becomes both the containing block AND the scroll
             * container, so its content box scrolls and takes this button with it —
             * measured on the cancel dialog at a 420px viewport: top went 15px →
             * -39px, off screen. That is why one caller had turned the × off instead
             * of fixing it, and `position: fixed` does NOT rescue it (also measured:
             * a transformed ancestor is the containing block, and that box is the one
             * scrolling).
             *
             * The shape that works is `edit-drawer.tsx`'s: `flex flex-col` + a height
             * cap here, and `flex-1 overflow-y-auto` on an INNER body. The × then sits
             * outside the scroller and stays put.
             *
             * `z-10` and a background because a caller may put controls along the top
             * edge: the change-summary dialog's Dismiss/Proceed sat directly under it.
             * Those callers reserve room with `pr-12`; this makes the collision
             * legible rather than invisible if one forgets.
             */
            className="touch-target absolute top-3.5 right-3.5 z-10 grid size-7 place-items-center rounded-md bg-popover/80 text-muted-foreground opacity-80 backdrop-blur-sm transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * The bottom sheet's grabber (phone width only). Drag it down: past 80px the sheet closes
 * through the ×, so it leaves exactly as a click would; short of that it springs back.
 * Pointer-only, so `aria-hidden` — the × and Escape are the accessible exits.
 */
function SheetGrabber({ closeRef }: { closeRef: React.RefObject<HTMLButtonElement | null> }) {
  const drag = React.useRef<{ y: number; dy: number } | null>(null);
  const sheet = (el: HTMLElement) => el.closest<HTMLElement>('[data-slot="dialog-content"]');
  return (
    <div
      aria-hidden
      data-sheet-grabber
      className="absolute top-0 left-1/2 flex h-6 w-24 -translate-x-1/2 cursor-grab touch-none justify-center pt-2 sm:hidden"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, dy: 0 };
        const s = sheet(e.currentTarget);
        if (s) s.style.transition = "none";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const s = sheet(e.currentTarget);
        if (!d || !s) return;
        d.dy = Math.max(0, e.clientY - d.y);
        s.style.transform = `translateY(${d.dy}px)`;
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        const s = sheet(e.currentTarget);
        drag.current = null;
        if (!d || !s) return;
        if (d.dy > 80) {
          s.style.transition = "";
          closeRef.current?.click();
          return;
        }
        s.style.transition = "transform var(--dur) var(--ease-spring)";
        s.style.transform = "";
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        const s = sheet(e.currentTarget);
        if (s) s.style.transform = "";
      }}
    >
      <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
    </div>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
