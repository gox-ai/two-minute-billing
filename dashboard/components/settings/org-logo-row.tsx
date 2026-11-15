"use client";

import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import type { BrandImageSupport } from "@/lib/api/brand-images";
import { BrandImageField } from "@/components/brand/brand-image-field";

/**
 * The organization's sidebar logo inside the org settings form: a preview in the
 * sidebar's own `size-7` tile, the URL/upload field, and Remove, which clears the field.
 * Nothing saves here; the page's one Save posts `icon_url` (empty clears it).
 */
export function OrgLogoRow({
  iconUrl,
  upload,
}: {
  iconUrl: string | null;
  upload: BrandImageSupport;
}) {
  const [value, setValue] = useDefaultState(iconUrl ?? "");
  return (
    <div className="flex w-full items-end gap-2 sm:w-auto sm:justify-end">
      {value ? (
        <span className="mb-1 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host */}
          <img src={value} alt="" className="size-7 rounded-md object-contain" />
        </span>
      ) : null}
      <BrandImageField
        biz={null}
        asset="icon"
        name="icon_url"
        label="Organization logo"
        value={value}
        onValueChange={setValue}
        upload={upload}
        placeholder="https://…/logo.png"
        className="w-full sm:w-72"
      />
      {value ? (
        <Button type="button" variant="outline" onClick={() => setValue("")}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}
