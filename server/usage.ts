export interface UsageTotals {
  /** Name of the model that consumed the most tokens. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = {
  model: "unknown",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

type TokenPrice = {
  model: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

// Keep in sync with https://developers.openai.com/api/docs/pricing.
const OPENAI_STANDARD_TOKEN_PRICES: TokenPrice[] = [
  { model: "gpt-5.5", inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  { model: "gpt-5.4-mini", inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  { model: "gpt-5.4", inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
  { model: "gpt-5.3-codex", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.2-codex", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.2", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.1-codex-max", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5.1-codex", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5-codex", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5-mini", inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  { model: "gpt-5", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
];

function priceForOpenAIModel(model: string): TokenPrice | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const exact = OPENAI_STANDARD_TOKEN_PRICES.find((price) => price.model === normalized);
  if (exact) return exact;
  return (
    [...OPENAI_STANDARD_TOKEN_PRICES]
      .sort((a, b) => b.model.length - a.model.length)
      .find((price) => normalized.startsWith(`${price.model}-`) || normalized.startsWith(price.model)) ??
    null
  );
}

export function estimateOpenAiCostUsd(usage: Omit<UsageTotals, "costUsd">): number {
  const price = priceForOpenAIModel(usage.model);
  if (!price) return 0;

  // OpenAI reports cached input as a subset of total input tokens.
  const cachedInputTokens = Math.max(0, usage.cacheReadTokens);
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - cachedInputTokens + usage.cacheCreationTokens,
  );

  return (
    (uncachedInputTokens * price.inputPerMillion +
      cachedInputTokens * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
