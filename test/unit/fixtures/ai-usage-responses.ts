// One response per AI SDK shape that `usageEventsFromAiResponse` reads, reduced to the
// fields it uses plus their neighbours. Ids are same-shape fakes.

/** OpenAI Chat Completions: `prompt_tokens` includes the cached tokens. */
export const openaiChat = {
  id: "chatcmpl-XXXXXXXXXXXX01",
  object: "chat.completion" as const,
  created: 1_793_000_000,
  model: "gpt-4o-mini-2024-07-18",
  choices: [],
  usage: {
    prompt_tokens: 1_234_567,
    completion_tokens: 456_789,
    total_tokens: 1_691_356,
    prompt_tokens_details: { cached_tokens: 200_000, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
  },
};

/** OpenAI Responses: `input_tokens` includes the cached tokens. */
export const openaiResponse = {
  id: "resp_XXXXXXXXXXXX01",
  object: "response" as const,
  created_at: 1_793_000_000,
  model: "gpt-4.1-2025-04-14",
  output: [],
  usage: {
    input_tokens: 5_000,
    input_tokens_details: { cached_tokens: 1_000 },
    output_tokens: 700,
    output_tokens_details: { reasoning_tokens: 300 },
    total_tokens: 5_700,
  },
};

/** Anthropic Messages: `input_tokens` excludes cache reads and cache writes. */
export const anthropicMessage = {
  id: "msg_XXXXXXXXXXXX01",
  type: "message" as const,
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 2_000,
    output_tokens: 500,
    cache_creation_input_tokens: 3_000,
    cache_read_input_tokens: 10_000,
  },
};

/** Vercel AI SDK 6 `generateText`: token details split the input total. */
export const vercelV6 = {
  text: "",
  response: { id: "aitxt-XXXXXXXXXXXX01", modelId: "claude-sonnet-4-5", timestamp: new Date(0) },
  usage: {
    inputTokens: 15_000,
    inputTokenDetails: { noCacheTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 3_000 },
    outputTokens: 500,
    outputTokenDetails: { textTokens: 500, reasoningTokens: 0 },
    totalTokens: 15_500,
  },
  providerMetadata: { anthropic: {} },
};

/** Vercel AI SDK 5 `generateText`: only `cachedInputTokens`. */
export const vercelV5 = {
  text: "",
  response: { id: "aitxt-XXXXXXXXXXXX02", modelId: "gpt-4o-mini", timestamp: new Date(0) },
  usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000, cachedInputTokens: 400 },
  providerMetadata: { openai: {} },
};
