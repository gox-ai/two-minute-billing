"use client";

import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import type { BrandImageSupport } from "@/lib/api/brand-images";
import { BrandImageField } from "@/components/brand/brand-image-field";

/**
 * The organization logo control for a settings row that supplies its own label: preview in
 * the sidebar's `size-7` tile, the URL/upload field (`bare`), and Remove, which empties it.
 * Posts `icon_url` with the page's Save; empty clears the logo.
 */
export function OrgLogoField({
  iconUrl,
  upload,
}: {
  iconUrl: string | null;
  upload: BrandImageSupport;
}) {
  const [value, setValue] = useDefaultState(iconUrl ?? "");
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
      {value ? (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host */}
          <img src={value} alt="" className="size-7 rounded-md object-contain" />
        </span>
      ) : null}
      <BrandImageField
        bare
        biz={null}
        asset="icon"
        name="icon_url"
        label="Logo"
        value={value}
        onValueChange={setValue}
        upload={upload}
        placeholder="https://…/logo.png"
      />
      {value ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setValue("")}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}
