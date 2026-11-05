"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { RadioField } from "@/components/ui/radio-group";
import { setThemeAction } from "@/app/(dashboard)/account/actions";

const OPTIONS = [
  { value: "light", label: "Light", hint: "Always use the light theme" },
  { value: "system", label: "System", hint: "Follow your device setting" },
  { value: "dark", label: "Dark", hint: "Always use the dark theme" },
];

/**
 * Light / System / Dark. Applies at once in this browser (next-themes) and is saved on the
 * account, so `ThemeSync` applies it in the next browser this person signs in to.
 */
export function AppearanceField({ saved }: { saved: "light" | "dark" | "system" | null }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the theme is only known in the browser
  React.useEffect(() => setMounted(true), []);
  const value = mounted ? (theme ?? saved ?? "system") : (saved ?? "system");

  return (
    <RadioField
      name="theme"
      ariaLabel="Theme"
      value={value}
      onValueChange={async (v) => {
        setTheme(v);
        const r = await setThemeAction(v);
        if (!r.ok) toast.error(r.message ?? "We could not save your theme.");
      }}
      options={OPTIONS}
    />
  );
}
