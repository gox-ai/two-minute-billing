import { apiGet, apiWrite } from "../api";

/** Which brand image an upload is for. Mirrors the engine's `BrandAsset`. */
export type BrandAsset = "logo" | "icon" | "favicon" | "signature";

export interface BrandImageCapability {
  object: string;
  upload_enabled: boolean;
  /** Content types per asset — `logo`/`signature` are narrower (the invoice PDF). */
  accepts?: Partial<Record<BrandAsset, string[]>>;
}

/** What the brand editor needs to draw a picker: whether to, and what it may choose. */
export interface BrandImageSupport {
  uploadEnabled: boolean;
  accepts: Record<BrandAsset, string[]>;
}

/** Used only if the engine answers without `accepts` — never a wider set than it allows. */
const FALLBACK_ACCEPTS: Record<BrandAsset, string[]> = {
  logo: ["image/png", "image/jpeg"],
  signature: ["image/png", "image/jpeg"],
  icon: ["image/png", "image/jpeg"],
  favicon: ["image/png", "image/jpeg"],
};

export interface BrandImage {
  object: string;
  asset: BrandAsset;
  url: string;
  content_type: string;
  bytes: number;
}

/**
 * Whether this deployment can store uploads, and what each asset may be.
 *
 * Best-effort by design: it decides whether to RENDER a file picker, so an engine that
 * cannot answer means "no picker", not a broken settings page. The URL field beside it
 * works either way.
 */
export async function brandImageSupport(): Promise<BrandImageSupport> {
  try {
    const cap = await apiGet<BrandImageCapability>("/v1/brand_images/capability");
    return {
      uploadEnabled: cap.upload_enabled === true,
      // The engine is the authority on what each asset takes; the fallback is deliberately
      // the NARROWEST set, so a picker never offers a format the upload would then refuse.
      accepts: {
        logo: cap.accepts?.logo ?? FALLBACK_ACCEPTS.logo,
        icon: cap.accepts?.icon ?? FALLBACK_ACCEPTS.icon,
        favicon: cap.accepts?.favicon ?? FALLBACK_ACCEPTS.favicon,
        signature: cap.accepts?.signature ?? FALLBACK_ACCEPTS.signature,
      },
    };
  } catch {
    return { uploadEnabled: false, accepts: FALLBACK_ACCEPTS };
  }
}

/** Store the organization's sidebar logo; only `icon` exists at that level. */
export const uploadOrganizationBrandImage = (body: {
  asset: "icon";
  data: string;
  content_type?: string;
}) => apiWrite("/v1/organization/brand_images", body);

/** Store one image and get back the URL to save on the business. */
export const uploadBrandImage = (
  biz: string,
  body: { asset: BrandAsset; data: string; content_type?: string },
) => apiWrite(`/v1/businesses/${biz}/brand_images`, body);
