// Merge nearby raw levels into confluence zones; score each by method count + validation.

export interface RawLevel {
  price: number;
  method: string;
  kind: "support" | "resistance" | "neutral";
  strength: number;
  validated: boolean;
  bounceRate: number | null;
  pValue: number | null;
  touches: number | null;
}

export interface RawZone {
  priceLow: number;
  priceHigh: number;
  score: number;
  kind: "support" | "resistance" | "neutral";
  methods: string[];
  bounceRate: number | null;
  pValue: number | null;
}

// Per-method weight table. Higher = more trustworthy single source.
// These determine how much each contributing method bumps the zone score.
const METHOD_WEIGHTS: Record<string, number> = {
  "kde-pivot-cluster": 1.0,
  "market-profile-poc": 1.2,
  "value-area-high": 0.7,
  "value-area-low": 0.7,
  "swing-pivot": 0.6,
  "quantile-band": 0.8,
};

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function weightFor(method: string): number {
  return METHOD_WEIGHTS[method] ?? 0.5;
}

function cleanLevel(level: RawLevel): RawLevel | null {
  if (!finite(level.price)) return null;
  return {
    ...level,
    method: typeof level.method === "string" && level.method.length > 0 ? level.method : "unknown",
    kind: level.kind === "support" || level.kind === "resistance" || level.kind === "neutral" ? level.kind : "neutral",
    strength: finite(level.strength) ? Math.max(0, level.strength) : 0,
    validated: level.validated === true,
    bounceRate: finite(level.bounceRate) ? Math.min(1, Math.max(0, level.bounceRate)) : null,
    pValue: finite(level.pValue) ? Math.min(1, Math.max(0, level.pValue)) : null,
    touches: finite(level.touches) ? Math.max(0, Math.floor(level.touches)) : null,
  };
}

export function mergeIntoZones(levels: RawLevel[], proximityPct = 0.0015): RawZone[] {
  const prox = finite(proximityPct) ? Math.max(0, proximityPct) : 0.0015;
  const sorted = levels.map(cleanLevel).filter((x): x is RawLevel => x !== null).sort((a, b) => a.price - b.price);
  if (sorted.length === 0) return [];

  const groups: RawLevel[][] = [];
  let cur: RawLevel[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const lvl = sorted[i]!;
    // Compare against the FIRST element of the current group (zone anchor),
    // not the last. Chain-comparison (last→next) allows zones to span
    // arbitrarily wide ranges when prices are monotonically close — e.g.
    // A-B=0.14%, B-C=0.14% but A-C=0.28% which exceeds proximityPct.
    const ref = cur[0]!.price;
    const denom = Math.max(Math.abs(ref), 1e-12);
    if (Math.abs(lvl.price - ref) / denom <= prox) cur.push(lvl);
    else { groups.push(cur); cur = [lvl]; }
  }
  groups.push(cur);

  return groups.map((g) => {
    const prices = g.map((l) => l.price);
    const supports = g.filter((l) => l.kind === "support").length;
    const resistances = g.filter((l) => l.kind === "resistance").length;
    const kind: "support" | "resistance" | "neutral" =
      supports > resistances ? "support" : resistances > supports ? "resistance" : "neutral";
    const methods = Array.from(new Set(g.map((l) => l.method)));
    // Weighted confluence score: each method contributes its base strength
    // multiplied by its trust weight; validated levels add a bonus of half
    // their own weight. Rewards multi-method agreement and historical
    // reliability rather than a flat sum.
    const rawScore =
      g.reduce((s, l) => s + l.strength * weightFor(l.method), 0) +
      g
        .filter((l) => l.validated)
        .reduce((s, l) => s + weightFor(l.method) * 0.5, 0);
    const score = finite(rawScore) ? rawScore : 0;
    const validatedLevels = g.filter((l) => l.validated && l.bounceRate !== null);
    const avgBounce = validatedLevels.length
      ? validatedLevels.reduce((s, l) => s + (l.bounceRate ?? 0), 0) / validatedLevels.length
      : null;
    const validP = validatedLevels.map((l) => l.pValue).filter((p): p is number => finite(p));
    const minP = validP.length ? Math.min(...validP) : null;
    return {
      priceLow: Math.min(...prices),
      priceHigh: Math.max(...prices),
      score,
      kind,
      methods,
      bounceRate: avgBounce,
      pValue: minP,
    };
  });
}
