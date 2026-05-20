import { apiUrl } from "@/lib/api";

export type LevelSourceId =
  | "kde"
  | "market_profile"
  | "quantile"
  | "pivots"
  | "liquidations";

export type LevelConfidence = "any" | "medium" | "high";
export type UniverseMode = "warm" | "warm_plus_top";

export type ScanMode = "best_per_symbol" | "buckets";
export type ComboType = "structural" | "liquidity" | "both";

export interface LevelTouchRequest {
  interval: string;
  // Number = static % tolerance (0.05–2.0). "auto" = ATR(14)-sized
  // tolerance per symbol. "auto" only takes effect on the 1m timeframe.
  tolerancePct: number | "auto";
  minConfidence: LevelConfidence;
  sources: LevelSourceId[];
  universeMode: UniverseMode;
  limit: number;
  // "best_per_symbol" (default) keeps the legacy flat output. "buckets"
  // splits results into structural / liquidity / both rows per symbol.
  mode?: ScanMode;
}

export interface LevelRef {
  priceLow: number;
  priceHigh: number;
  midPrice: number;
  kind: "support" | "resistance" | "neutral";
  confidence: "high" | "medium" | "low";
  score: number;
  methods: string[];
  source: LevelSourceId;
  leverage?: number;
}

export interface LevelTouchRow {
  symbol: string;
  lastPrice: number;
  side: "above" | "below" | "inside";
  distancePct: number;
  touchScore: number;
  timeframe: string;
  comboType?: ComboType;
  // For comboType="both", `companion` holds the matching liquidity
  // level; `level` holds the matching structural zone. For pure-
  // structural and pure-liquidity rows `companion` is absent.
  companion?: LevelRef;
  level: LevelRef;
}

export interface LevelTouchResponse {
  ok: boolean;
  interval: string;
  tolerancePct: number;
  toleranceMode?: "fixed" | "auto";
  mode?: ScanMode;
  minConfidence: LevelConfidence;
  sources: LevelSourceId[];
  universeMode: UniverseMode;
  universeSize: number;
  warmCount?: number;
  newlyWarmed?: number;
  scanned: number;
  matched: number;
  warming?: number;
  coldLevels?: number;
  candleOverlapHits?: number;
  bothBucketCount?: number;
  skipped: number;
  rows: LevelTouchRow[];
  errors?: { symbol: string; error: string }[];
}

export async function postLevelTouchScan(
  req: LevelTouchRequest,
): Promise<LevelTouchResponse> {
  const r = await fetch(apiUrl(`/api/liquidity/level-touch-scan`), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const d = (await r.json().catch(() => ({}))) as
    | LevelTouchResponse
    | { error?: string };
  if (!r.ok) {
    const msg = (d as { error?: string }).error ?? `scan failed: ${r.status}`;
    throw new Error(msg);
  }
  return d as LevelTouchResponse;
}
