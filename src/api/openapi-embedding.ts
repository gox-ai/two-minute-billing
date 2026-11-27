/**
 * OpenAPI for the business's allowed websites: who may embed its checkout, portal and usage
 * widget. Spread into `openapi.ts`.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const biz = {
  name: "biz",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The business's id (biz_…).",
};

export const EMBEDDING_PATHS = {
  "/v1/businesses/{biz}/settings/embedding": {
    get: {
      tags: ["Businesses"],
      summary: "Get the allowed websites",
      description:
        "The websites that may show this business's checkout, customer portal and usage widget " +
        "inside their own pages. The usage widget settings read the same list.",
      parameters: [biz],
      responses: { "200": json("EmbeddingSettings", "The allowed websites.") },
    },
    put: {
      tags: ["Businesses"],
      summary: "Set the allowed websites",
      description:
        "Replaces the list of websites, as origins (scheme, host and port, for example " +
        "`https://app.example.com`). https only; plain http is accepted only from a loopback " +
        "origin, and a session may name a loopback origin in a test business only. A checkout or " +
        "portal session names one of these in `embed_origin`. Removing a website stops its " +
        "embeds on the next page load. At most 20.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("EmbeddingSettingsUpdate") } },
      },
      responses: {
        "200": json("EmbeddingSettings", "The saved list."),
        "400": json("Error", "A website is not a valid origin. `param` names it."),
      },
    },
  },
};

export const EMBEDDING_SCHEMAS = {
  EmbeddingSettings: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["embedding_settings"] },
      origins: {
        type: "array",
        items: { type: "string", example: "https://app.example.com" },
      },
      script_url: {
        type: "string",
        nullable: true,
        description:
          "Where the page loads `embed.js` from: this API's public URL (ADVERTISED_API_URL). Null when it is not set.",
      },
      script_integrity: {
        type: "string",
        description: "The Subresource Integrity hash for the script tag's `integrity` attribute.",
      },
    },
  },
  EmbeddingSettingsUpdate: {
    type: "object",
    required: ["origins"],
    properties: { origins: { type: "array", maxItems: 20, items: { type: "string" } } },
  },
};
