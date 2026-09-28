/**
 * USD per million tokens: first-party API list prices (Anthropic cached 2026-06-24; Gemini API paid
 * tier, standard, cached 2026-09-27, with thinking tokens billed as output).
 */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** A price change the provider announced: it applies from `from` (a UTC date, `YYYY-MM-DD`). */
export interface PriceChange extends ModelPrice {
  from: string;
}

/** A model's price, or its current price followed by announced changes in date order. */
export type ModelPricing = ModelPrice | readonly [ModelPrice, ...PriceChange[]];

/** Gemini 3.6–3.8 Flash: Google's price through 2026-12-31, doubled from 2027-01-01. */
const GEMINI_3_6_TO_3_8_FLASH: ModelPricing = [
  { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 },
  { from: "2027-01-01", inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 },
];

export const MODEL_PRICES: Readonly<Record<string, ModelPricing>> = {
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
  "gemini-3.8-flash": GEMINI_3_6_TO_3_8_FLASH,
  "gemini-3.7-flash": GEMINI_3_6_TO_3_8_FLASH,
  "gemini-3.6-flash": GEMINI_3_6_TO_3_8_FLASH,
  "gemini-3.5-flash": { inputUsdPerMTok: 1.5, outputUsdPerMTok: 9 },
  "gemini-3.5-flash-lite": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  "gemini-3.1-flash-lite": { inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.5 },
  // Gemini Pro prices are for prompts up to 200k tokens (longer prompts cost more).
  "gemini-3.1-pro-preview": { inputUsdPerMTok: 2, outputUsdPerMTok: 12 },
  "gemini-2.5-pro": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  "gemini-2.5-flash": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
};

/**
 * Price for a model id on a date (default: now): an exact match, else the longest known id that
 * prefixes it at a `-`/`@` boundary (so dated snapshots such as `claude-sonnet-5-20260401` price as
 * `claude-sonnet-5`), at the latest announced change that has taken effect. Null when the model is
 * unknown.
 */
export function priceFor(model: string, at: Date = new Date()): ModelPrice | null {
  let pricing = MODEL_PRICES[model];
  if (!pricing) {
    let best: string | null = null;
    for (const id of Object.keys(MODEL_PRICES)) {
      const boundary = model[id.length];
      if (model.startsWith(id) && (boundary === "-" || boundary === "@") && (!best || id.length > best.length)) best = id;
    }
    pricing = best ? MODEL_PRICES[best] : undefined;
  }
  return pricing ? priceAt(pricing, at) : null;
}

function priceAt(pricing: ModelPricing, at: Date): ModelPrice {
  if (!isSchedule(pricing)) return pricing;
  const [current, ...changes] = pricing;
  let { inputUsdPerMTok, outputUsdPerMTok } = current;
  for (const change of changes) {
    if (at.getTime() >= Date.parse(change.from)) ({ inputUsdPerMTok, outputUsdPerMTok } = change);
  }
  return { inputUsdPerMTok, outputUsdPerMTok };
}

const isSchedule = (pricing: ModelPricing): pricing is readonly [ModelPrice, ...PriceChange[]] => Array.isArray(pricing);

/** Estimated cost of one call made on `at` (default: now), rounded to 1e-6 USD; null when the model has no known price. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, at: Date = new Date()): number | null {
  const price = priceFor(model, at);
  if (!price) return null;
  const usd = (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
