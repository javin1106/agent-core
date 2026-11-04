import type { Usage } from "../ai/types.js";

// Prices in US dollars per 1 million tokens, the way providers publish them.
// Input and output are priced separately; output usually costs more.
export interface Prices {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Reads PRICE_INPUT_PER_M and PRICE_OUTPUT_PER_M from the environment (.env).
// Returns undefined when neither is set (e.g. free local or credit-based models).
// Throws if only one is set or a value isn't a number, so a typo in .env
// doesn't silently produce wrong costs.
export function loadPrices(env: NodeJS.ProcessEnv = process.env): Prices | undefined {
  const input = env.PRICE_INPUT_PER_M?.trim();
  const output = env.PRICE_OUTPUT_PER_M?.trim();
  if (!input && !output) return undefined;
  if (!input || !output) {
    throw new Error("Set both PRICE_INPUT_PER_M and PRICE_OUTPUT_PER_M in .env, or neither.");
  }

  return {
    inputPerMillion: parsePrice("PRICE_INPUT_PER_M", input),
    outputPerMillion: parsePrice("PRICE_OUTPUT_PER_M", output),
  };
}

function parsePrice(name: string, text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} in .env must be a number like 2.5, not "${text}"`);
  }
  return value;
}

// Dollars spent for the given tokens.
export function costOf(usage: Usage, prices: Prices): number {
  return (
    (usage.inputTokens / 1_000_000) * prices.inputPerMillion +
    (usage.outputTokens / 1_000_000) * prices.outputPerMillion
  );
}

// Small amounts need more decimals to be meaningful: $0.0034, not $0.00.
export function formatCost(dollars: number): string {
  return dollars < 1 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}
