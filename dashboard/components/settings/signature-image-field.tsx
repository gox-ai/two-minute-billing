"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { BrandImageField } from "@/components/brand/brand-image-field";
import type { BrandImageSupport } from "@/lib/api/brand-images";

/**
 * The invoice/credit-note signature image, with the same upload path as the brand images.
 *
 * A thin client wrapper because the Documents settings page is a server component and
 * `BrandImageField` is controlled — `useDefaultState` rather than `useState` so a save
 * re-seeds it (see lib/use-default-state.ts).
 */
export function SignatureImageField({
  biz,
  defaultValue,
  upload,
}: {
  biz: string;
  defaultValue: string;
  upload: BrandImageSupport;
}) {
  const [value, setValue] = useDefaultState(defaultValue);
  return (
    <BrandImageField
      biz={biz}
      asset="signature"
      name="signature_image_url"
      label="Signature image"
      // https matters here beyond the usual reason: the HTML invoice view is served under
      // a CSP that blocks http images, while the PDF would still embed them — so an http
      // URL renders in one and not the other. An upload always produces https.
      help={
        upload.uploadEnabled
          ? "Upload a PNG or JPEG, or paste an https link. It prints above the signatory name."
          : "Paste an https link to a PNG or JPEG. As with your logo, you cannot upload a file here."
      }
      value={value}
      onValueChange={setValue}
      upload={upload}
      placeholder="https://…/signature.png"
    />
  );
}
