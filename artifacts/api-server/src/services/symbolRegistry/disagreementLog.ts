import { logger } from "../../lib/logger";

// Per-process dedup so a hot-path mismatch doesn't flood logs. Keyed on
// (context, symbol, registry, legacy) so a NEW disagreement always logs
// even after we've seen others. Capped to bound memory.
const seen = new Set<string>();
const MAX = 5_000;

export function logDisagreement(
  context: string,
  symbol: string,
  registryAnswer: unknown,
  legacyAnswer: unknown,
): void {
  const key = `${context}|${symbol}|${JSON.stringify(registryAnswer)}|${JSON.stringify(legacyAnswer)}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > MAX) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  logger.warn(
    {
      tag: "symbol-registry-mismatch",
      context,
      symbol,
      registryAnswer,
      legacyAnswer,
    },
    "[symbol-registry-mismatch]",
  );
}
