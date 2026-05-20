// Anti-lookahead determinism check.
// For each (symbol, interval), pick a few bar indices t. Run discovery at
// t with bars[0..t]. Then run discovery at t with bars[0..t+50]. Assert
// that the level set picked by detection-as-of-t is IDENTICAL between
// the two calls. If future bars can change the historical decision,
// fail.
//
// VALIDATION-ONLY.

import { discoverLevelsAt } from "./engineAdapter";
import type { OhlcvBar } from "../engines/levels";

export interface AntiLookaheadCase {
  symbol: string;
  interval: string;
  t: number;
  ok: boolean;
  baselineCount: number;
  withFutureCount: number;
  diffSummary: string;
}

export interface AntiLookaheadReport {
  cases: AntiLookaheadCase[];
  passed: boolean;
  notes?: string[];
}

function fingerprint(levels: ReturnType<typeof discoverLevelsAt>): string {
  return levels
    .map((l) => `${l.tier}:${l.price.toFixed(6)}:${l.posteriorBounceRate.toFixed(6)}:${l.touches}`)
    .sort()
    .join("|");
}

export function runAntiLookahead(
  series: { coin: string; interval: string; bars: OhlcvBar[] }[],
  samplesPerSeries = 4,
): AntiLookaheadReport {
  const cases: AntiLookaheadCase[] = [];
  for (const s of series) {
    if (s.bars.length < 200) continue;
    const minT = 100;
    const maxT = s.bars.length - 60;
    if (maxT <= minT) continue;
    for (let i = 0; i < samplesPerSeries; i++) {
      const t = Math.floor(minT + ((maxT - minT) * (i + 1)) / (samplesPerSeries + 1));
      // Real anti-lookahead test: hand the adapter bars THROUGH t+50 but
      // tell it the detection cutoff is still t. The adapter's first act
      // is to truncate to detectionIndex (see engineAdapter.ts), so its
      // output MUST be byte-identical to the baseline call that only
      // ever saw bars[0..t]. If it differs, future bars leaked into a
      // historical decision — a hard failure.
      const baseline = discoverLevelsAt({ bars: s.bars.slice(0, t), detectionIndex: t });
      const withFuture = discoverLevelsAt({ bars: s.bars.slice(0, t + 50), detectionIndex: t });
      const fpA = fingerprint(baseline);
      const fpB = fingerprint(withFuture);
      const ok = fpA === fpB;
      cases.push({
        symbol: s.coin,
        interval: s.interval,
        t,
        ok,
        baselineCount: baseline.length,
        withFutureCount: withFuture.length,
        diffSummary: ok ? "identical" : `mismatch:\n  baseline=${fpA}\n  with-future=${fpB}`,
      });
    }
  }
  return { cases, passed: cases.every((c) => c.ok) };
}
