const ALL_SYMBOLS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","DOGE-USDT",
  "ADA-USDT","AVAX-USDT","LINK-USDT","DOT-USDT","MATIC-USDT","NEAR-USDT",
  "APT-USDT","ARB-USDT","OP-USDT","SUI-USDT","TIA-USDT","SEI-USDT",
  "INJ-USDT","FET-USDT","RENDER-USDT","JUP-USDT","WIF-USDT","PEPE-USDT",
  "SHIB-USDT","FLOKI-USDT","BONK-USDT","LTC-USDT","BCH-USDT","ETC-USDT",
  "FIL-USDT","ATOM-USDT","UNI-USDT","AAVE-USDT","MKR-USDT","CRV-USDT",
  "LDO-USDT","RUNE-USDT","TRX-USDT","TON-USDT","ALGO-USDT","VET-USDT",
  "HBAR-USDT","ICP-USDT","FTM-USDT","IMX-USDT","SAND-USDT","MANA-USDT",
  "AXS-USDT","GALA-USDT","ENS-USDT","GRT-USDT","SNX-USDT","COMP-USDT",
  "SUSHI-USDT","1INCH-USDT","DYDX-USDT","GMX-USDT","STX-USDT","ORDI-USDT",
  "WLD-USDT","BLUR-USDT","PENDLE-USDT","PYTH-USDT","JTO-USDT","MEME-USDT",
  "TRB-USDT","CAKE-USDT","CFX-USDT","AGIX-USDT","OCEAN-USDT","RNDR-USDT",
  "AR-USDT","THETA-USDT","EGLD-USDT","FLOW-USDT","KAVA-USDT","ROSE-USDT",
  "ZIL-USDT","ONE-USDT","CELO-USDT","ANKR-USDT","CHZ-USDT","ENJ-USDT",
  "BAT-USDT","ZRX-USDT","SKL-USDT","STORJ-USDT","COTI-USDT","KNC-USDT",
  "BAND-USDT","RLC-USDT","POL-USDT","STRK-USDT","ZK-USDT","W-USDT",
  "ENA-USDT","ETHFI-USDT","BOME-USDT","MEW-USDT","NOT-USDT","IO-USDT",
  "ZRO-USDT","LISTA-USDT","TAO-USDT","NEIRO-USDT","EIGEN-USDT",
  "POPCAT-USDT","DOGS-USDT","CATI-USDT","HMSTR-USDT","SCR-USDT",
  "GOAT-USDT","ACT-USDT","PNUT-USDT","USUAL-USDT","MOVE-USDT","ORCA-USDT",
  "TRUMP-USDT","MELANIA-USDT","LAYER-USDT","KAITO-USDT","IP-USDT",
  "BERA-USDT","ANIME-USDT","TST-USDT","NIL-USDT","PARTI-USDT","GPS-USDT",
  "FORM-USDT","BABY-USDT","INIT-USDT",
];

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; }
interface BacktestResult { touches: number; reversals: number; winRate: number; avgBounce: number; reliability: number; }
interface ConfluenceMap { swingPoints: number[]; rejectionWicks: number[]; trappedTraderLevels: number[]; sessionAnchors: number[]; impulseMidpoints: number[]; momentumStalls: number[]; compressionEdges: number[]; failedBreakouts: number[]; }

function seededRandom(seed: number): number {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function generateInitialCandles(currentPrice: number, numCandles: number): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let price = currentPrice;
  const CANDLE_INTERVAL_MS = 4 * 60 * 60 * 1000;

  const prices: number[] = [price];
  for (let i = 1; i < numCandles; i++) {
    const seed = 42 + i * 31 + Math.floor(currentPrice);
    const volatility = price * 0.008;
    const drift = (seededRandom(seed) - 0.48) * volatility;
    price = price - drift;
    prices.push(price);
  }
  prices.reverse();

  for (let i = 0; i < numCandles; i++) {
    const basePrice = prices[i]!;
    const seed = 42 + i * 17 + Math.floor(currentPrice);
    const bodySize = basePrice * 0.003 * (seededRandom(seed + 1) + 0.2);
    const isGreen = seededRandom(seed + 2) > 0.45;

    const open = isGreen ? basePrice - bodySize / 2 : basePrice + bodySize / 2;
    const close = isGreen ? basePrice + bodySize / 2 : basePrice - bodySize / 2;
    const wickUp = basePrice * 0.002 * (seededRandom(seed + 3) + 0.1);
    const wickDown = basePrice * 0.002 * (seededRandom(seed + 4) + 0.1);

    candles.push({
      timestamp: now - (numCandles - 1 - i) * CANDLE_INTERVAL_MS,
      open, high: Math.max(open, close) + wickUp, low: Math.min(open, close) - wickDown, close,
    });
  }
  return candles;
}

function backtestLevel(price: number, candles: Candle[], tolerance: number): BacktestResult {
  const totalCandles = candles.length;
  let touches = 0;
  let reversals = 0;
  let totalBounce = 0;
  const DECAY_LAMBDA = 3.0;
  let recencyWeightSum = 0;
  let recencyReversalSum = 0;

  for (let i = 0; i < totalCandles; i++) {
    const c = candles[i]!;
    const touchedFromBelow = Math.abs(c.low - price) < tolerance;
    const touchedFromAbove = Math.abs(c.high - price) < tolerance;
    const bodyLow = Math.min(c.open, c.close);
    const bodyHigh = Math.max(c.open, c.close);
    const touchedBody = price >= bodyLow - tolerance * 0.5 && price <= bodyHigh + tolerance * 0.5;

    if (!touchedFromBelow && !touchedFromAbove && !touchedBody) continue;
    touches++;

    const recencyFraction = i / Math.max(1, totalCandles - 1);
    const recencyWeight = Math.exp(DECAY_LAMBDA * (recencyFraction - 1));
    recencyWeightSum += recencyWeight;

    const lookAhead = Math.min(i + 3, totalCandles - 1);
    let maxBounce = 0;
    for (let j = i + 1; j <= lookAhead; j++) {
      const fc = candles[j]!;
      if (touchedFromBelow || (touchedBody && c.close > price)) {
        const bounceAway = (fc.high - price) / price;
        maxBounce = Math.max(maxBounce, bounceAway);
      }
      if (touchedFromAbove || (touchedBody && c.close <= price)) {
        const bounceAway = (price - fc.low) / price;
        maxBounce = Math.max(maxBounce, bounceAway);
      }
    }

    if (maxBounce >= 0.003) {
      reversals++;
      totalBounce += maxBounce;
      recencyReversalSum += recencyWeight;
    }
  }

  const winRate = touches > 0 ? reversals / touches : 0;
  const avgBounce = reversals > 0 ? totalBounce / reversals : 0;
  const recencyWeight = recencyWeightSum > 0 ? recencyReversalSum / recencyWeightSum : 0;
  const normalizedBounce = Math.min(1, avgBounce / 0.015);
  const reliability = touches >= 2 ? winRate * normalizedBounce * recencyWeight : 0;
  return { touches, reversals, winRate, avgBounce, reliability };
}

function buildConfluenceMap(candles: Candle[], markPrice: number): ConfluenceMap {
  const len = candles.length;
  const swingPoints: number[] = [];
  const rejectionWicks: number[] = [];
  const trappedTraderLevels: number[] = [];
  const sessionAnchors: number[] = [];
  const impulseMidpoints: number[] = [];
  const momentumStalls: number[] = [];
  const compressionEdges: number[] = [];
  const failedBreakouts: number[] = [];

  const typedSwings: { price: number; idx: number; type: "high" | "low" }[] = [];
  const SWING_LOOKBACK = 5;
  for (let i = SWING_LOOKBACK; i < len - SWING_LOOKBACK; i++) {
    const c = candles[i]!;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= SWING_LOOKBACK; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isSwingHigh = false;
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isSwingLow = false;
    }
    if (isSwingHigh) { swingPoints.push(c.high); typedSwings.push({ price: c.high, idx: i, type: "high" }); }
    if (isSwingLow) { swingPoints.push(c.low); typedSwings.push({ price: c.low, idx: i, type: "low" }); }
  }

  for (let i = 0; i < len; i++) {
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    const fullRange = c.high - c.low;
    if (fullRange < markPrice * 0.001) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (upperWick > body * 1.5 && upperWick > fullRange * 0.4) rejectionWicks.push(c.high);
    if (lowerWick > body * 1.5 && lowerWick > fullRange * 0.4) rejectionWicks.push(c.low);
  }

  for (let i = 0; i < len; i++) {
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    if (body > markPrice * 0.003) {
      const origin = c.close > c.open ? c.open : c.close;
      trappedTraderLevels.push(origin);
      impulseMidpoints.push((c.high + c.low) / 2);
    }
  }

  const SESSION_SIZE = 6;
  for (let i = 0; i < len; i += SESSION_SIZE) {
    const end = Math.min(i + SESSION_SIZE, len);
    let sHigh = -Infinity, sLow = Infinity;
    const sOpen = candles[i]!.open;
    const sClose = candles[end - 1]!.close;
    for (let j = i; j < end; j++) {
      if (candles[j]!.high > sHigh) sHigh = candles[j]!.high;
      if (candles[j]!.low < sLow) sLow = candles[j]!.low;
    }
    sessionAnchors.push(sHigh, sLow, sOpen, sClose);
  }

  let streak = 0;
  let lastDir = 0;
  for (let i = 1; i < len; i++) {
    const dir = candles[i]!.close >= candles[i]!.open ? 1 : -1;
    if (dir === lastDir) { streak++; }
    else {
      if (streak >= 3) { const prev = candles[i - 1]!; momentumStalls.push(lastDir > 0 ? prev.high : prev.low); }
      streak = 1; lastDir = dir;
    }
  }
  if (streak >= 3 && len > 0) {
    const last = candles[len - 1]!;
    momentumStalls.push(lastDir > 0 ? last.high : last.low);
  }

  const COMP_WINDOW = 8;
  for (let i = 0; i <= len - COMP_WINDOW; i++) {
    let wHigh = -Infinity, wLow = Infinity;
    for (let j = i; j < i + COMP_WINDOW; j++) {
      if (candles[j]!.high > wHigh) wHigh = candles[j]!.high;
      if (candles[j]!.low < wLow) wLow = candles[j]!.low;
    }
    const range = wHigh - wLow;
    if (range < markPrice * 0.012 && range > 0) { compressionEdges.push(wHigh, wLow); }
  }

  for (const sw of typedSwings) {
    let broken = false;
    for (let i = sw.idx + 1; i < len; i++) {
      const c = candles[i]!;
      if (!broken) {
        if (sw.type === "high" && c.close > sw.price * 1.002) broken = true;
        if (sw.type === "low" && c.close < sw.price * 0.998) broken = true;
      } else {
        if (sw.type === "high" && c.close < sw.price * 0.999) { failedBreakouts.push(sw.price); break; }
        if (sw.type === "low" && c.close > sw.price * 1.001) { failedBreakouts.push(sw.price); break; }
      }
    }
  }

  return { swingPoints, rejectionWicks, trappedTraderLevels, sessionAnchors, impulseMidpoints, momentumStalls, compressionEdges, failedBreakouts };
}

function computeConfluence(price: number, cmap: ConfluenceMap, tolerance: number): number {
  let score = 0;
  const W_SWING = 0.22, W_TRAPPED = 0.20, W_SESSION = 0.15, W_REJECTION = 0.12;
  const W_FAILED_BO = 0.11, W_IMPULSE_MID = 0.08, W_MOMENTUM = 0.07, W_COMPRESSION = 0.05;

  const near = (arr: number[], tol: number) => {
    let best = 0;
    for (const p of arr) { const dist = Math.abs(p - price); if (dist < tol) best = Math.max(best, 1 - dist / tol); }
    return best;
  };
  const count = (arr: number[], tol: number) => {
    let n = 0;
    for (const p of arr) { if (Math.abs(p - price) < tol) n++; }
    return n;
  };

  const swingHit = near(cmap.swingPoints, tolerance * 1.5);
  const swingCount = Math.min(3, count(cmap.swingPoints, tolerance * 1.5));
  score += W_SWING * swingHit * (0.5 + 0.5 * swingCount / 3);
  score += W_TRAPPED * near(cmap.trappedTraderLevels, tolerance * 2);
  const sessionHit = near(cmap.sessionAnchors, tolerance * 1.2);
  const sessionCount = Math.min(4, count(cmap.sessionAnchors, tolerance * 1.2));
  score += W_SESSION * sessionHit * (0.4 + 0.6 * sessionCount / 4);
  score += W_REJECTION * near(cmap.rejectionWicks, tolerance * 1.3);
  score += W_FAILED_BO * near(cmap.failedBreakouts, tolerance * 1.5);
  score += W_IMPULSE_MID * near(cmap.impulseMidpoints, tolerance * 2);
  score += W_MOMENTUM * near(cmap.momentumStalls, tolerance * 1.5);
  const compHit = near(cmap.compressionEdges, tolerance * 1.2);
  const compCount = Math.min(3, count(cmap.compressionEdges, tolerance * 1.2));
  score += W_COMPRESSION * compHit * (0.3 + 0.7 * compCount / 3);
  return Math.min(1, score);
}

interface HeatLevel {
  price: number;
  compositeScore: number;
  heatScore: number;
}

interface TickerResult {
  symbol: string;
  markPrice: number;
  candleCount: number;
  candlePriceRange: string;
  levelCount: number;
  eliteLevels: number;
  strongLevels: number;
  avgWinRate: number;
  avgReliability: number;
  maxReliability: number;
  confluenceDetected: { swingPoints: number; rejectionWicks: number; trappedTrader: number; sessionAnchors: number; impulseMidpoints: number; momentumStalls: number; compressionEdges: number; failedBreakouts: number; };
  avgConfluence: number;
  maxConfluence: number;
  topLevel: { price: number; winRate: number; touches: number; confluence: number; strength: number } | null;
  errors: string[];
}

const API_BASE = `http://localhost:${process.env.PORT || 3001}`;

async function fetchHeatmap(symbol: string): Promise<{ markPrice: number; levels: HeatLevel[] } | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/liquidity/heatmap?symbol=${encodeURIComponent(symbol)}&levels=150`);
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return { markPrice: data.markPrice, levels: data.levels };
  } catch {
    return null;
  }
}

async function testTicker(symbol: string): Promise<TickerResult> {
  const errors: string[] = [];

  const apiData = await fetchHeatmap(symbol);
  if (!apiData) {
    return {
      symbol, markPrice: 0, candleCount: 0, candlePriceRange: "N/A",
      levelCount: 0, eliteLevels: 0, strongLevels: 0,
      avgWinRate: 0, avgReliability: 0, maxReliability: 0,
      confluenceDetected: { swingPoints: 0, rejectionWicks: 0, trappedTrader: 0, sessionAnchors: 0, impulseMidpoints: 0, momentumStalls: 0, compressionEdges: 0, failedBreakouts: 0 },
      avgConfluence: 0, maxConfluence: 0, topLevel: null,
      errors: ["API_FETCH_FAILED"],
    };
  }

  const { markPrice, levels } = apiData;

  if (markPrice <= 0) errors.push("INVALID_MARK_PRICE");
  if (!levels || levels.length === 0) errors.push("NO_LEVELS_RETURNED");

  const candles = generateInitialCandles(markPrice, 200);

  if (candles.length !== 200) errors.push(`CANDLE_COUNT_WRONG: ${candles.length}`);

  let minP = Infinity, maxP = -Infinity;
  for (const c of candles) {
    if (c.high < c.low) errors.push(`CANDLE_INVERSION at ${c.timestamp}`);
    if (c.open <= 0 || c.close <= 0 || c.high <= 0 || c.low <= 0) errors.push(`NEGATIVE_PRICE at ${c.timestamp}`);
    if (c.high < Math.max(c.open, c.close)) errors.push(`HIGH_BELOW_BODY at ${c.timestamp}`);
    if (c.low > Math.min(c.open, c.close)) errors.push(`LOW_ABOVE_BODY at ${c.timestamp}`);
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  }

  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.timestamp <= candles[i-1]!.timestamp) errors.push(`TIMESTAMP_NOT_ASCENDING at index ${i}`);
  }

  const tolerance = markPrice * 0.002;
  const cmap = buildConfluenceMap(candles, markPrice);

  if (cmap.swingPoints.length === 0) errors.push("NO_SWING_POINTS_DETECTED");
  if (cmap.rejectionWicks.length === 0) errors.push("NO_REJECTION_WICKS_DETECTED");
  if (cmap.trappedTraderLevels.length === 0) errors.push("NO_TRAPPED_TRADERS_DETECTED");
  if (cmap.sessionAnchors.length === 0) errors.push("NO_SESSION_ANCHORS");
  if (cmap.impulseMidpoints.length === 0) errors.push("NO_IMPULSE_MIDPOINTS_DETECTED");
  if (cmap.momentumStalls.length === 0) errors.push("NO_MOMENTUM_STALLS_DETECTED");
  if (cmap.compressionEdges.length === 0) errors.push("NO_COMPRESSION_EDGES_DETECTED");
  if (cmap.failedBreakouts.length === 0) errors.push("NO_FAILED_BREAKOUTS_DETECTED");

  for (const sp of cmap.swingPoints) {
    if (sp <= 0 || !isFinite(sp)) errors.push(`INVALID_SWING_POINT: ${sp}`);
  }
  for (const rw of cmap.rejectionWicks) {
    if (rw <= 0 || !isFinite(rw)) errors.push(`INVALID_REJECTION_WICK: ${rw}`);
  }

  const visible = (levels || []).filter((l: HeatLevel) => l.price >= minP && l.price <= maxP);
  const scored = visible.map((l: HeatLevel) => ({ level: l, score: l.compositeScore > 0 ? l.compositeScore : l.heatScore }));
  const maxScore = scored.length > 0 ? Math.max(...scored.map((s: any) => s.score)) : 0;

  const qualifiedLevels = scored.filter((s: any) => s.score > maxScore * 0.05);

  const lineResults: { price: number; strength: number; tier: string; touches: number; winRate: number; reliability: number; confluence: number }[] = [];

  for (const s of qualifiedLevels) {
    const bt = backtestLevel(s.level.price, candles, tolerance);
    const confluence = computeConfluence(s.level.price, cmap, tolerance);
    const strength = s.score / maxScore;

    if (bt.winRate < 0 || bt.winRate > 1) errors.push(`WIN_RATE_OUT_OF_RANGE: ${bt.winRate} at ${s.level.price}`);
    if (bt.reliability < 0 || bt.reliability > 1) errors.push(`RELIABILITY_OUT_OF_RANGE: ${bt.reliability} at ${s.level.price}`);
    if (confluence < 0 || confluence > 1) errors.push(`CONFLUENCE_OUT_OF_RANGE: ${confluence} at ${s.level.price}`);
    if (bt.touches > 0 && bt.reversals > bt.touches) errors.push(`REVERSALS_EXCEED_TOUCHES at ${s.level.price}`);
    if (!isFinite(bt.avgBounce)) errors.push(`NON_FINITE_AVG_BOUNCE at ${s.level.price}`);

    const finalStrength = Math.min(1, strength * 0.55 + bt.reliability * 0.25 + confluence * 0.20);
    if (finalStrength < 0 || finalStrength > 1) errors.push(`FINAL_STRENGTH_OUT_OF_RANGE: ${finalStrength}`);

    lineResults.push({
      price: s.level.price, strength: finalStrength, tier: "normal",
      touches: bt.touches, winRate: bt.winRate, reliability: bt.reliability, confluence,
    });
  }

  lineResults.sort((a, b) => {
    const aRank = a.strength + a.reliability * 0.25;
    const bRank = b.strength + b.reliability * 0.25;
    return bRank - aRank;
  });

  let eliteCount = 0, strongCount = 0;
  for (let i = 0; i < lineResults.length; i++) {
    if (i < 3) { lineResults[i]!.tier = "elite"; eliteCount++; }
    else if (i < 7) { lineResults[i]!.tier = "strong"; strongCount++; }
  }

  if (lineResults.length > 0 && eliteCount === 0) errors.push("NO_ELITE_LEVELS");
  if (lineResults.length >= 7 && strongCount === 0) errors.push("NO_STRONG_LEVELS");

  const avgWinRate = lineResults.length > 0 ? lineResults.reduce((s, l) => s + l.winRate, 0) / lineResults.length : 0;
  const avgReliability = lineResults.length > 0 ? lineResults.reduce((s, l) => s + l.reliability, 0) / lineResults.length : 0;
  const maxReliability = lineResults.length > 0 ? Math.max(...lineResults.map(l => l.reliability)) : 0;
  const avgConfluence = lineResults.length > 0 ? lineResults.reduce((s, l) => s + l.confluence, 0) / lineResults.length : 0;
  const maxConfluence = lineResults.length > 0 ? Math.max(...lineResults.map(l => l.confluence)) : 0;

  const topLevel = lineResults.length > 0 ? {
    price: lineResults[0]!.price,
    winRate: lineResults[0]!.winRate,
    touches: lineResults[0]!.touches,
    confluence: lineResults[0]!.confluence,
    strength: lineResults[0]!.strength,
  } : null;

  return {
    symbol, markPrice, candleCount: candles.length,
    candlePriceRange: `${minP.toPrecision(6)} - ${maxP.toPrecision(6)}`,
    levelCount: lineResults.length, eliteLevels: eliteCount, strongLevels: strongCount,
    avgWinRate, avgReliability, maxReliability,
    confluenceDetected: {
      swingPoints: cmap.swingPoints.length,
      rejectionWicks: cmap.rejectionWicks.length,
      trappedTrader: cmap.trappedTraderLevels.length,
      sessionAnchors: cmap.sessionAnchors.length,
      impulseMidpoints: cmap.impulseMidpoints.length,
      momentumStalls: cmap.momentumStalls.length,
      compressionEdges: cmap.compressionEdges.length,
      failedBreakouts: cmap.failedBreakouts.length,
    },
    avgConfluence, maxConfluence, topLevel, errors,
  };
}

async function main() {
  console.log("=" .repeat(100));
  console.log("BACKTEST VALIDATION — ALL TICKERS");
  console.log(`Running across ${ALL_SYMBOLS.length} symbols`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log("=" .repeat(100));
  console.log();

  const results: TickerResult[] = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  const BATCH_SIZE = 10;
  for (let batch = 0; batch < ALL_SYMBOLS.length; batch += BATCH_SIZE) {
    const batchSymbols = ALL_SYMBOLS.slice(batch, batch + BATCH_SIZE);
    const batchResults = await Promise.all(batchSymbols.map(s => testTicker(s)));

    for (const r of batchResults) {
      results.push(r);
      const status = r.errors.length === 0 ? "PASS" : "FAIL";
      if (status === "PASS") passed++;
      else failed++;

      const statusIcon = status === "PASS" ? "✓" : "✗";
      const topInfo = r.topLevel
        ? `top: ${r.topLevel.price.toPrecision(6)} (${(r.topLevel.winRate*100).toFixed(0)}% WR, ${r.topLevel.touches}T, ${(r.topLevel.confluence*100).toFixed(0)}% conf)`
        : "no levels";

      console.log(`${statusIcon} ${r.symbol.padEnd(16)} | ${r.levelCount.toString().padStart(3)} levels | ${r.eliteLevels}E ${r.strongLevels}S | avgWR ${(r.avgWinRate*100).toFixed(1)}% | maxRel ${(r.maxReliability*100).toFixed(1)}% | ${topInfo}`);

      if (r.errors.length > 0) {
        for (const err of r.errors.slice(0, 5)) {
          console.log(`    ⚠ ${err}`);
          warnings++;
        }
        if (r.errors.length > 5) console.log(`    ... and ${r.errors.length - 5} more errors`);
      }
    }
  }

  console.log();
  console.log("=" .repeat(100));
  console.log("CONFLUENCE DETECTOR COVERAGE");
  console.log("=" .repeat(100));

  const detectorNames = ["swingPoints", "rejectionWicks", "trappedTrader", "sessionAnchors", "impulseMidpoints", "momentumStalls", "compressionEdges", "failedBreakouts"] as const;
  for (const det of detectorNames) {
    const counts = results.map(r => r.confluenceDetected[det]);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const zeroCount = counts.filter(c => c === 0).length;
    console.log(`  ${det.padEnd(22)} | min: ${min.toString().padStart(4)} | max: ${max.toString().padStart(4)} | avg: ${avg.toFixed(1).padStart(6)} | zero: ${zeroCount}/${results.length}`);
  }

  console.log();
  console.log("=" .repeat(100));
  console.log("AGGREGATE STATISTICS");
  console.log("=" .repeat(100));

  const validResults = results.filter(r => r.levelCount > 0);
  const allWinRates = validResults.map(r => r.avgWinRate);
  const allReliabilities = validResults.map(r => r.maxReliability);
  const allConfluences = validResults.map(r => r.maxConfluence);
  const allLevelCounts = validResults.map(r => r.levelCount);

  console.log(`  Total tickers tested:    ${results.length}`);
  console.log(`  Passed:                  ${passed}`);
  console.log(`  Failed:                  ${failed}`);
  console.log(`  Total warnings:          ${warnings}`);
  console.log();
  console.log(`  Tickers with levels:     ${validResults.length}/${results.length}`);
  console.log(`  Avg levels per ticker:   ${(allLevelCounts.reduce((a,b) => a+b, 0) / allLevelCounts.length).toFixed(1)}`);
  console.log(`  Avg win rate:            ${(allWinRates.reduce((a,b) => a+b, 0) / allWinRates.length * 100).toFixed(1)}%`);
  console.log(`  Avg max reliability:     ${(allReliabilities.reduce((a,b) => a+b, 0) / allReliabilities.length * 100).toFixed(1)}%`);
  console.log(`  Avg max confluence:      ${(allConfluences.reduce((a,b) => a+b, 0) / allConfluences.length * 100).toFixed(1)}%`);

  const lowWinRate = validResults.filter(r => r.avgWinRate < 0.3);
  const zeroReliability = validResults.filter(r => r.maxReliability === 0);
  const zeroConfluence = validResults.filter(r => r.maxConfluence === 0);

  if (lowWinRate.length > 0) {
    console.log();
    console.log(`  ⚠ Tickers with avg win rate < 30%: ${lowWinRate.map(r => r.symbol).join(", ")}`);
  }
  if (zeroReliability.length > 0) {
    console.log(`  ⚠ Tickers with zero reliability: ${zeroReliability.map(r => r.symbol).join(", ")}`);
  }
  if (zeroConfluence.length > 0) {
    console.log(`  ⚠ Tickers with zero confluence: ${zeroConfluence.map(r => r.symbol).join(", ")}`);
  }

  console.log();
  console.log("=" .repeat(100));
  const verdict = failed === 0 ? "ALL TESTS PASSED" : `${failed} TICKERS HAVE ISSUES`;
  console.log(`VERDICT: ${verdict}`);
  console.log("=" .repeat(100));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("Fatal error:", err); process.exit(1); });
