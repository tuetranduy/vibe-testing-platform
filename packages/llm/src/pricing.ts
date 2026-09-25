/** USD per million tokens (Anthropic first-party API list prices, cached 2026-06-24). */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  "claude-fable-5": { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  "claude-opus-5-5": { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
  "claude-opus-5": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-opus-4-8": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-opus-4-7": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-opus-4-6": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-sonnet-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
};

/** Estimated cost of one call. Unknown models (including fakes) cost 0. Rounded to 1e-6 USD. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  const usd = (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
