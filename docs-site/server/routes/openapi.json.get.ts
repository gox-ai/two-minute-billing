import { agentDiscoveryOpenApi, getAgentSiteUrl } from "#agent-discovery";

// Replaces Docus's route of the same path. That one titles this document with the site name,
// so an agent that fetched it took the docs site for the billing API: same name, no billing
// routes. The paths stay the docs site's own; the title and description send agents to the API.
export default defineEventHandler((event) => {
  const discovery = agentDiscoveryOpenApi(event);
  const version = (useRuntimeConfig(event).public.docus as { version?: string } | undefined)
    ?.version;
  return {
    openapi: "3.1.0",
    info: {
      title: "Two Minute Billing documentation site",
      description:
        "The documentation website only: the markdown version of every page, the discovery " +
        "documents and the docs MCP endpoint. This is NOT the billing API. The billing API's " +
        "OpenAPI document is https://api.twominutebilling.com/openapi.json on Two Minute " +
        "Billing Cloud, or /openapi.json on your own API host when you self-host.",
      version: version || "0.0.0",
    },
    externalDocs: {
      description: "The billing API's OpenAPI document (Cloud)",
      url: "https://api.twominutebilling.com/openapi.json",
    },
    servers: [{ url: getAgentSiteUrl(event) }],
    tags: discovery.tags,
    paths: discovery.paths,
    components: discovery.components,
  };
});
