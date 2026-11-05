"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SettingRow } from "@/components/settings/settings-layout";

/** `email_config.linkTarget` + `merchantUrl`: where the links and the button in emails go. */
export function LinkTargetRow({
  target,
  url,
}: {
  target: "portal" | "merchant_url";
  url: string | null;
}) {
  const [mode, setMode] = useDefaultState<string>(target);
  const [text, setText] = useDefaultState(url ?? "");
  return (
    <SettingRow
      label="Links in emails"
      help="Where the button and the billing portal link in each email go. This includes Pay now and Change payment method."
      errorFor="merchant_url"
      control={
        <div className="flex flex-col gap-3">
          <RadioField
            name="link_target"
            ariaLabel="Links in emails"
            value={mode}
            onValueChange={setMode}
            className="grid-cols-1 sm:grid-cols-2"
            options={[
              { value: "portal", label: "Hosted billing portal" },
              { value: "merchant_url", label: "Your URL" },
            ]}
          />
          {/* Kept in the form while hidden, so the URL survives a change back to the portal. */}
          <Input
            id="merchant_url"
            name="merchant_url"
            inputMode="url"
            aria-label="Your URL for email links"
            placeholder="https://"
            required={mode === "merchant_url"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={mode === "merchant_url" ? "max-w-md" : "hidden"}
          />
        </div>
      }
      consequence={
        mode === "merchant_url"
          ? "The links go to your URL as you enter it. The customer is not signed in to the billing portal."
          : "The button opens the billing portal, signed in as the customer. The link works for five days."
      }
    />
  );
}
