import { apiGet, apiWrite } from "@/lib/api";

/** The websites that may show this business's checkout, portal and usage widget in a frame. */
export interface EmbeddingSettings {
  object: "embedding_settings";
  origins: string[];
  /** Where a page loads `embed.js` from. Null when the API's public URL is not set. */
  script_url: string | null;
  script_integrity: string;
}

const b = (biz: string) => `/v1/businesses/${encodeURIComponent(biz)}/settings/embedding`;

export const getEmbeddingSettings = (biz: string) => apiGet<EmbeddingSettings>(b(biz));
export const saveEmbeddingOrigins = (biz: string, origins: string[]) =>
  apiWrite(b(biz), { origins }, "PUT");
