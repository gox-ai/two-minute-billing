"use client";

import * as React from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Each type on its own semantic token pair, like `Alert` and the chips, instead of the
 * library's `richColors`. The `!` is needed: sonner styles `[data-sonner-toast][data-styled]`
 * at a higher specificity than one class.
 */
const TONE = {
  success: "bg-success-soft! text-success! border-success/25!",
  error: "bg-destructive-soft! text-destructive! border-destructive/25!",
  warning: "bg-warning-soft! text-warning! border-warning/25!",
  info: "bg-info-soft! text-info! border-info/25!",
};

/** The toast column starts under the shell's banners (test mode, account, 2FA): below `<main>`'s top edge. */
function useBannerOffset() {
  const [top, setTop] = React.useState(16);
  React.useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const measure = () => setTop(Math.round(main.getBoundingClientRect().top) + 16);
    measure();
    // A banner appearing shrinks <main> (the shell is a fixed-height frame), so this fires.
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return top;
}

const Toaster = ({ ...props }: ToasterProps) => {
  // A page that forces a theme (the light-only storefront) wins over the visitor's setting.
  const { forcedTheme, theme = "system" } = useTheme();
  const top = useBannerOffset();

  return (
    <Sonner
      theme={(forcedTheme ?? theme) as ToasterProps["theme"]}
      className="toaster group"
      offset={{ top }}
      mobileOffset={{ top }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "rounded-xl! border! shadow-lg!",
          title: "text-sm! font-medium!",
          description: "text-sm! text-current/80!",
          icon: "text-current!",
          ...TONE,
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--popover-border)",
          "--border-radius": "var(--radius-xl)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
