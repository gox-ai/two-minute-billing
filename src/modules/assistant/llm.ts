/**
 * Which model answers, and on whose key.
 *
 * Order: the organization's own key (set in Settings → Assistant), else the platform key from
 * `ASSISTANT_*`, else none — the assistant is off. An own key that fails is an error the owner
 * sees; it never falls back to the platform key silently.
 *
 * The only place a model SDK is imported. OpenAI goes through the Responses API: newer models
 * refuse tool calls on Chat Completions. An `ASSISTANT_BASE_URL` (a local OpenAI-compatible
 * server) uses Chat Completions, which is what those servers implement.
 */
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config } from "@/platform/config";

export type Provider = "openai" | "anthropic" | "google";

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-6-luna",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
};

export interface ResolvedLlm {
  model: LanguageModel;
  provider: Provider;
  modelId: string;
  billedTo: "platform" | "organization";
}

export interface OwnKey {
  provider: Provider;
  model: string | null;
  apiKey: string;
}

/** Replaced in tests with a mock model. */
let override: ((billedTo: "platform" | "organization") => ResolvedLlm | null) | null = null;
export function setLlmForTests(f: typeof override): void {
  override = f;
}

export function buildModel(
  provider: Provider,
  modelId: string,
  apiKey: string,
  baseURL?: string,
): LanguageModel {
  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return baseURL ? openai.chat(modelId) : openai.responses(modelId);
    }
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
  }
}

export function platformConfigured(): boolean {
  if (override) return true;
  return !!config.ASSISTANT_PROVIDER && (!!config.ASSISTANT_API_KEY || !!config.ASSISTANT_BASE_URL);
}

export function resolveLlm(own: OwnKey | null): ResolvedLlm | null {
  if (override) return override(own ? "organization" : "platform");
  if (own) {
    const modelId = own.model || DEFAULT_MODELS[own.provider];
    return {
      model: buildModel(own.provider, modelId, own.apiKey),
      provider: own.provider,
      modelId,
      billedTo: "organization",
    };
  }
  if (!platformConfigured()) return null;
  const provider = config.ASSISTANT_PROVIDER!;
  const modelId = config.ASSISTANT_MODEL || DEFAULT_MODELS[provider];
  return {
    model: buildModel(
      provider,
      modelId,
      config.ASSISTANT_API_KEY ?? "local",
      config.ASSISTANT_BASE_URL || undefined,
    ),
    provider,
    modelId,
    billedTo: "platform",
  };
}

/**
 * OpenAI: keep nothing on their side between calls. The platform model reasons at low effort
 * (measured: same answers, about a third faster); an own key's model keeps its default.
 */
export function providerOptions(
  provider: Provider,
  conversationId: string,
  billedTo: "platform" | "organization" = "platform",
) {
  const effort =
    billedTo === "platform" && !config.ASSISTANT_BASE_URL
      ? (config.ASSISTANT_REASONING_EFFORT ?? "low")
      : undefined;
  return provider === "openai"
    ? {
        openai: {
          store: false,
          promptCacheKey: conversationId,
          ...(effort ? { reasoningEffort: effort } : {}),
        },
      }
    : undefined;
}
