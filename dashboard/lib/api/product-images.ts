import { apiDelete, apiGet, apiWrite } from "../api";

/** Whether this deployment stores uploads, and what a product image may be. */
export interface ProductImageSupport {
  uploadEnabled: boolean;
  accepts: string[];
}

/**
 * Best effort, like `brandImageSupport`: it decides whether to RENDER the picker, so an
 * engine that cannot answer means "no picker", never a broken form.
 */
export async function productImageSupport(): Promise<ProductImageSupport> {
  try {
    const cap = await apiGet<{ upload_enabled?: boolean; accepts?: { product?: string[] } }>(
      "/v1/brand_images/capability",
    );
    return {
      uploadEnabled: cap.upload_enabled === true,
      // The narrowest safe set if the engine predates `product`.
      accepts: cap.accepts?.product ?? ["image/png", "image/jpeg"],
    };
  } catch {
    return { uploadEnabled: false, accepts: [] };
  }
}

/** Store the image and set it on the product, in one engine call. */
export const uploadProductImage = (
  biz: string,
  prod: string,
  body: { data: string; content_type?: string },
) => apiWrite(`/v1/businesses/${biz}/products/${encodeURIComponent(prod)}/image`, body);

/** Clear the product's image; the engine deletes the stored file. */
export const deleteProductImage = (biz: string, prod: string) =>
  apiDelete(`/v1/businesses/${biz}/products/${encodeURIComponent(prod)}/image`);
