// No imports on purpose: pure, so the root unit suite can pin it.

/** The price list's provider ids, as people write the names. An id not here is title-cased. */
const NAMES: Record<string, string> = {
  ai21: "AI21 Labs",
  aiml: "AI/ML API",
  anthropic: "Anthropic",
  anyscale: "Anyscale",
  assemblyai: "AssemblyAI",
  aws_polly: "Amazon Polly",
  azure: "Azure OpenAI",
  azure_ai: "Azure AI",
  bedrock: "Amazon Bedrock",
  black_forest_labs: "Black Forest Labs",
  cerebras: "Cerebras",
  cloudflare: "Cloudflare",
  cohere: "Cohere",
  dashscope: "Alibaba DashScope",
  databricks: "Databricks",
  deepgram: "Deepgram",
  deepinfra: "DeepInfra",
  deepseek: "DeepSeek",
  elevenlabs: "ElevenLabs",
  fireworks_ai: "Fireworks AI",
  gemini: "Google Gemini",
  google: "Google",
  groq: "Groq",
  huggingface: "Hugging Face",
  mistral: "Mistral AI",
  nvidia_nim: "NVIDIA NIM",
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  replicate: "Replicate",
  sagemaker: "Amazon SageMaker",
  sambanova: "SambaNova",
  together_ai: "Together AI",
  vertex_ai: "Google Vertex AI",
  voyage: "Voyage AI",
  watsonx: "IBM watsonx",
  xai: "xAI",
};

/** Short words that stay upper-case in a title-cased id. */
const UPPER = new Set(["ai", "aws", "api", "ml", "nim", "gpt", "llm"]);

/** A provider's name for a label. The id itself stays the stored and posted value. */
export function providerName(id: string | null | undefined): string {
  const key = (id ?? "").trim();
  if (!key) return "";
  const known = NAMES[key.toLowerCase()];
  if (known) return known;
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) =>
      UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}
