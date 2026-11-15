"use client";

import * as React from "react";
import { toast } from "sonner";
import { RadioField } from "@/components/ui/radio-group";
import { setThemeAction } from "@/app/(dashboard)/account/actions";
import { useThemeWipe, wipeOrigin } from "@/lib/theme-wipe";

const OPTIONS = [
  { value: "light", label: "Light", hint: "Always use the light theme" },
  { value: "dark", label: "Dark", hint: "Always use the dark theme" },
  { value: "system", label: "Auto", hint: "Follow your device setting" },
];

/**
 * Light / Dark / Auto (the value stays `system`). Applies at once in this browser (next-themes) and is saved on the
 * account, so `ThemeSync` applies it in the next browser this person signs in to.
 */
export function AppearanceField({ saved }: { saved: "light" | "dark" | "system" | null }) {
  const { theme, switchTheme } = useThemeWipe();
  const ref = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the theme is only known in the browser
  React.useEffect(() => setMounted(true), []);
  const value = mounted ? (theme ?? saved ?? "system") : (saved ?? "system");

  return (
    // `contents`: a hook to find the picked radio without a box of its own.
    <div ref={ref} className="contents">
      <RadioField
        name="theme"
        ariaLabel="Theme"
        value={value}
        onValueChange={async (v) => {
          // The wipe starts at the picked radio (pointer or keyboard alike).
          const radio = ref.current?.querySelector(`[role="radio"][value="${v}"]`);
          switchTheme(v, wipeOrigin(radio?.getBoundingClientRect() ?? null));
          const r = await setThemeAction(v);
          if (!r.ok) toast.error(r.message ?? "We could not save your theme.");
        }}
        options={OPTIONS}
      />
    </div>
  );
}
