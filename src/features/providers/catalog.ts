export const providerIds = ["openai", "anthropic", "grok", "deepseek", "nim", "featherless"] as const;
export type ProviderId = (typeof providerIds)[number];

export const providerMeta: Readonly<Record<ProviderId, { short: string; model: string; mark: string }>> = {
  openai: { short: "OpenAI / Codex", model: "gpt-4.1-mini", mark: "O" },
  anthropic: { short: "Anthropic Claude", model: "claude-3-5-haiku-latest", mark: "A" },
  grok: { short: "xAI Grok", model: "grok-3-mini", mark: "X" },
  deepseek: { short: "DeepSeek", model: "deepseek-chat", mark: "D" },
  nim: { short: "NVIDIA NIM", model: "meta/llama-3.1-8b-instruct", mark: "N" },
  featherless: { short: "Featherless", model: "mistralai/Mistral-Large-Instruct-2411", mark: "F" },
};

export const providerProtocol: Readonly<Record<ProviderId, string>> = {
  openai: "Responses API",
  anthropic: "Messages API",
  grok: "Chat completions",
  deepseek: "Chat completions",
  nim: "Chat completions",
  featherless: "Chat completions",
};
