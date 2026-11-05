/**
 * Turn an AI model response into usage events: one event per token type, keyed so that a
 * retried report counts once. No dependency on any AI SDK: the shapes below are the fields
 * this helper reads, matched structurally.
 *
 *   const res = await openai.chat.completions.create({ … })
 *   await reportAiUsage(tmb, "biz_…", res, { customer: workspace.id })
 *
 * Pair it with a meter that sums `tokens` from `ai_tokens` events, grouped by
 * `[model, token_type]`, and a price on that meter with a rate per model and token type.
 *
 * A response that reports its own cost (OpenRouter `usage.cost`, USD) puts the whole cost on the
 * first event and "0" on the others, so a "reported cost first" price bills that exact cost.
 */

export type AiTokenType = "input" | "output" | "cached_input" | "cache_write";

export interface AiUsageEvent {
  /** `<response id>:<token type>`, optionally prefixed: the per-event idempotency key. */
  key: string;
  customer: string;
  event_name: string;
  timestamp?: string;
  properties: {
    model: string;
    token_type: AiTokenType;
    provider: string;
    tokens: number;
  };
  /** The call's reported cost, major units, as a decimal string. Only when the response has one. */
  cost?: string;
  currency?: string;
}

export interface AiUsageOptions {
  /** A usage key of the customer, or the customer id (`cus_…`). */
  customer: string;
  /** Default `ai_tokens`. */
  eventName?: string;
  /** Prepended to every key, e.g. your request id when one response is reported twice on purpose. */
  keyPrefix?: string;
  /** Overrides the provider name that the helper detects. */
  provider?: string;
  /** RFC 3339 time of the call; default: the time we receive the event. */
  timestamp?: string;
}

/** OpenAI Chat Completions (`chat.completions.create`). */
interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
    /** OpenRouter: the whole call's cost in USD. */
    cost?: number | null;
  } | null;
}

/** OpenAI Responses (`responses.create`). */
interface OpenAIResponse {
  id: string;
  object: "response";
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

/** Anthropic Messages (`messages.create`). `input_tokens` excludes cache reads and writes. */
interface AnthropicMessage {
  id: string;
  type: "message";
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

/** Vercel AI SDK `generateText` result: v6 token details, or v5 `cachedInputTokens`. */
interface VercelAiResult {
  response: { id: string; modelId: string };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  providerMetadata?: Record<string, unknown>;
}

export type AiResponse = OpenAIChatCompletion | OpenAIResponse | AnthropicMessage | VercelAiResult;

interface Counted {
  id: string;
  model: string;
  provider: string;
  tokens: Partial<Record<AiTokenType, number>>;
  /** The call's reported cost and its currency, when the response carries one. */
  cost?: { amount: string; currency: string };
}

const n = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : 0);

/**
 * A cost as the API takes it: plain decimal text, at most 12 places, never an exponent
 * (`4.2e-6` → "0.0000042"). Null for a missing, negative or non-finite value.
 */
function decimalText(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v.toFixed(12).replace(/\.?0+$/, "") || "0";
}

function read(r: AiResponse): Counted {
  const any = r as unknown as Record<string, unknown>;
  if (any.object === "chat.completion") {
    const c = r as OpenAIChatCompletion;
    const cached = n(c.usage?.prompt_tokens_details?.cached_tokens);
    const cost = decimalText(c.usage?.cost);
    return {
      id: c.id,
      model: c.model,
      provider: "openai",
      tokens: {
        input: Math.max(n(c.usage?.prompt_tokens) - cached, 0),
        cached_input: cached,
        output: n(c.usage?.completion_tokens),
      },
      ...(cost ? { cost: { amount: cost, currency: "USD" } } : {}),
    };
  }
  if (any.object === "response") {
    const c = r as OpenAIResponse;
    const cached = n(c.usage?.input_tokens_details?.cached_tokens);
    return {
      id: c.id,
      model: c.model,
      provider: "openai",
      tokens: {
        input: Math.max(n(c.usage?.input_tokens) - cached, 0),
        cached_input: cached,
        output: n(c.usage?.output_tokens),
      },
    };
  }
  if (any.type === "message") {
    const c = r as AnthropicMessage;
    return {
      id: c.id,
      model: c.model,
      provider: "anthropic",
      tokens: {
        input: n(c.usage.input_tokens),
        cached_input: n(c.usage.cache_read_input_tokens),
        cache_write: n(c.usage.cache_creation_input_tokens),
        output: n(c.usage.output_tokens),
      },
    };
  }
  if (any.response && typeof any.usage === "object") {
    const c = r as VercelAiResult;
    const d = c.usage.inputTokenDetails;
    const read_ = n(d?.cacheReadTokens ?? c.usage.cachedInputTokens);
    const write = n(d?.cacheWriteTokens);
    const input =
      d?.noCacheTokens != null
        ? n(d.noCacheTokens)
        : Math.max(n(c.usage.inputTokens) - read_ - write, 0);
    return {
      id: c.response.id,
      model: c.response.modelId,
      provider: Object.keys(c.providerMetadata ?? {})[0] ?? "unknown",
      tokens: { input, cached_input: read_, cache_write: write, output: n(c.usage.outputTokens) },
    };
  }
  throw new TypeError(
    "usageEventsFromAiResponse: the response is not an OpenAI, Anthropic or Vercel AI SDK result.",
  );
}

const ORDER: AiTokenType[] = ["input", "output", "cached_input", "cache_write"];

/** One event per token type with a non-zero count. */
export function usageEventsFromAiResponse(
  response: AiResponse,
  opts: AiUsageOptions,
): AiUsageEvent[] {
  const c = read(response);
  const prefix = opts.keyPrefix ? `${opts.keyPrefix}:` : "";
  return ORDER.filter((t) => n(c.tokens[t]) > 0).map((t, i) => ({
    key: `${prefix}${c.id}:${t}`,
    customer: opts.customer,
    event_name: opts.eventName ?? "ai_tokens",
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    properties: {
      model: c.model,
      token_type: t,
      provider: opts.provider ?? c.provider,
      tokens: c.tokens[t]!,
    },
    // Every event of the call carries a cost, so none of its tokens falls back to the list.
    ...(c.cost ? { cost: i === 0 ? c.cost.amount : "0", currency: c.cost.currency } : {}),
  }));
}

/** What `reportAiUsage` needs from the client: `Tmbilling` satisfies it. */
export interface UsageEventSender {
  usageEvents: {
    sendBatch: (business: string, events: AiUsageEvent[]) => Promise<UsageEventBatchResult>;
  };
}

export interface UsageEventBatchResult {
  results: Array<{
    index: number;
    key: string;
    status: "created" | "duplicate" | "error";
    error?: { code: string; message: string };
  }>;
  created: number;
  duplicates: number;
  errors: number;
}

/** Send the events of one response in one batch. A retry with the same response counts once. */
export async function reportAiUsage(
  client: UsageEventSender,
  business: string,
  response: AiResponse,
  opts: AiUsageOptions,
): Promise<UsageEventBatchResult> {
  const events = usageEventsFromAiResponse(response, opts);
  if (!events.length) return { results: [], created: 0, duplicates: 0, errors: 0 };
  return client.usageEvents.sendBatch(business, events);
}
