export const providerIds = ["openai", "anthropic", "gemini", "groq", "grok", "deepseek", "nvidia_nim", "featherless"] as const;
export type ProviderId = (typeof providerIds)[number];

export const providerMeta: Readonly<Record<ProviderId, { short: string; model: string; protocol: string }>> = {
  openai: { short: "OpenAI", model: "gpt-4.1-mini", protocol: "Chat Completions" },
  anthropic: { short: "Anthropic Claude", model: "claude-sonnet-4-20250514", protocol: "Messages API" },
  gemini: { short: "Google Gemini", model: "gemini-2.5-flash", protocol: "Generate Content" },
  groq: { short: "Groq", model: "openai/gpt-oss-20b", protocol: "Chat Completions" },
  grok: { short: "xAI Grok", model: "grok-3-mini", protocol: "Chat Completions" },
  deepseek: { short: "DeepSeek", model: "deepseek-chat", protocol: "Chat Completions" },
  nvidia_nim: { short: "NVIDIA NIM", model: "meta/llama-3.1-8b-instruct", protocol: "Chat Completions" },
  featherless: { short: "Featherless", model: "mistralai/Mistral-Large-Instruct-2411", protocol: "Chat Completions" },
};
