"use client";

import * as React from "react";
import Link from "next/link";
import { useDefaultState } from "@/lib/use-default-state";
import { RadioField } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SettingError } from "@/components/settings/setting-error";

/** The street lines of a business address, in the order the documents print them. */
type Address = {
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
} | null;

/**
 * How the seller's address block is laid out on invoices and credit notes.
 *
 * The two non-custom options are previewed from the business's REAL address, so a
 * merchant picks a layout by seeing their own address in it rather than by reading a
 * description. `custom` reveals the template, seeded with the expanded form so nobody
 * starts from an empty box and accidentally saves a blank seller address.
 *
 * ⚠️ The preview mirrors `formatSellerAddress` in
 * `src/modules/invoicing/customization.ts`, which is the source of truth. The joining
 * rule is one line of logic; if it changes, change both.
 */
export function AddressFormatField({
  defaultFormat,
  defaultCustom,
  address,
  profileHref,
}: {
  defaultFormat: "expanded" | "single_line" | "custom";
  defaultCustom: string;
  address: Address;
  /** Where the business address is set; linked when there is none to preview. */
  profileHref?: string;
}) {
  const lines = React.useMemo(() => {
    const a = address ?? {};
    const cityLine = [a.city, a.state, a.postal_code].filter(Boolean).join(", ");
    return [a.line1, a.line2, a.line3, cityLine, a.country].filter(
      (l): l is string => !!l && !!l.trim(),
    );
  }, [address]);

  const [format, setFormat] = useDefaultState(defaultFormat);
  // Seeded with the expanded form so switching to `custom` starts from something real.
  // The engine also falls back to the expanded layout if the template is saved blank, so
  // an empty seller address is unreachable from either side.
  const [custom, setCustom] = useDefaultState(defaultCustom || lines.join("\n"));

  const hasAddress = lines.length > 0;
  const expanded = lines.join("\n");
  // Mirrors the engine's join, trailing punctuation and all: merchant address lines
  // often end in their own comma, and a naive join shows "Mogappair East,, Chennai".
  const single = hasAddress
    ? lines
        .map((l) =>
          l
            .trim()
            .replace(/[,;]+$/, "")
            .trim(),
        )
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <SettingsCard title="Seller address" meta="The layout of your address">
      <SettingRow
        label="Address layout"
        help={
          hasAddress ? (
            "The preview uses your business address."
          ) : (
            <>
              Add a business address on{" "}
              {profileHref ? (
                <Link href={profileHref} className="text-primary hover:underline">
                  Business profile
                </Link>
              ) : (
                "Business profile"
              )}{" "}
              to see the preview.
            </>
          )
        }
        control={
          <RadioField
            name="address_format"
            value={format}
            onValueChange={(v) => setFormat(v as typeof format)}
            ariaLabel="Seller address format"
            className="pt-1"
            options={[
              {
                value: "expanded",
                label: "Expanded",
                hint: hasAddress ? (
                  <span className="font-mono text-xs whitespace-pre-line">{expanded}</span>
                ) : (
                  "Each part of the address on its own line."
                ),
              },
              {
                value: "single_line",
                label: "Single line",
                hint: hasAddress ? (
                  <span className="font-mono text-xs wrap-anywhere">{single}</span>
                ) : (
                  "The full address on one line, with commas between the parts."
                ),
              },
              {
                value: "custom",
                label: "Custom",
                hint: "Type the address exactly as it should print.",
              },
            ]}
          />
        }
      >
        {/* Hidden, not unmounted, outside Custom: a save must not discard the template. */}
        <div className={cn("flex flex-col gap-2", format !== "custom" && "hidden")}>
          <label htmlFor="custom_address" className="text-sm font-medium">
            Address to print
          </label>
          <Textarea
            id="custom_address"
            name="custom_address"
            rows={5}
            maxLength={2000}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="font-mono text-xs"
          />
          <SettingError name="custom_address" />
          {/* The seller block draws the name and tax number as separate fields, so
              repeating them here prints them twice. */}
          <p className="m-0 text-xs text-muted-foreground">
            The business name and tax number print separately, above and below this block. Do not
            include them here, or they appear twice.
          </p>
        </div>
      </SettingRow>
    </SettingsCard>
  );
}
