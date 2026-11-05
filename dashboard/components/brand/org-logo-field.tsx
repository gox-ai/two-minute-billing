"use client";

import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import type { BrandImageSupport } from "@/lib/api/brand-images";
import { BrandImageField } from "./brand-image-field";

/**
 * The organization's sidebar logo: the business icon field with no business, a preview in
 * the sidebar's own `size-7` tile, and Remove. Posts `icon_url` to `updateOrgAction`.
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
    <div className="flex w-full flex-col gap-2 sm:items-end">
      <div className="flex w-full items-end gap-2 sm:justify-end">
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
          className="w-full sm:w-96"
        />
      </div>
      <div className="flex gap-2 sm:justify-end">
        {iconUrl ? (
          <Button type="submit" variant="outline" name="icon_url_remove" value="1">
            Remove
          </Button>
        ) : null}
        <Button type="submit">Save</Button>
      </div>
    </div>
  );
}
