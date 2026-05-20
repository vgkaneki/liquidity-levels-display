// Per-symbol rolling order-flow buffer. Each tick we sample {obi, vpin} and
// keep the last `windowMs` of samples so the orchestrator can require
// SUSTAINED imbalance (not a one-shot snapshot) before letting order flow
// move a zone score. Falls back to a single snapshot when no history exists.

interface Sample {
  t: number;
  obi: number;
  vpin: number;
}

const WINDOW_MS = 60_000;

const buffers = new Map<string, Sample[]>();

export function recordOrderFlow(symbol: string, obi: number, vpin: number): void {
  const arr = buffers.get(symbol) ?? [];
  const now = Date.now();
  arr.push({ t: now, obi, vpin });
  const cutoff = now - WINDOW_MS;
  while (arr.length > 0 && (arr[0]?.t ?? 0) < cutoff) arr.shift();
  buffers.set(symbol, arr);
}

export function sustainedOrderFlow(symbol: string): {
  meanObi: number;
  meanVpin: number;
  fracObiBidHeavy: number;
  fracObiAskHeavy: number;
  samples: number;
} {
  const arr = buffers.get(symbol) ?? [];
  if (arr.length === 0) {
    return { meanObi: 0, meanVpin: 0, fracObiBidHeavy: 0, fracObiAskHeavy: 0, samples: 0 };
  }
  let sumObi = 0,
    sumVpin = 0,
    bidHeavy = 0,
    askHeavy = 0;
  for (const s of arr) {
    sumObi += s.obi;
    sumVpin += s.vpin;
    if (s.obi > 0.15) bidHeavy++;
    if (s.obi < -0.15) askHeavy++;
  }
  return {
    meanObi: sumObi / arr.length,
    meanVpin: sumVpin / arr.length,
    fracObiBidHeavy: bidHeavy / arr.length,
    fracObiAskHeavy: askHeavy / arr.length,
    samples: arr.length,
  };
}
