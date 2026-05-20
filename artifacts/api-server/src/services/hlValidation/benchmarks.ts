// 8 benchmark level generators used to compare the engine against
// naive/baseline approaches on the SAME bars / folds.
// VALIDATION-ONLY.

import type { OhlcvBar } from "../engines/levels";
import { findPivots } from "../engines/levels";
import type { BenchmarkKind, Side } from "./types";

export interface BenchmarkLevel {
  kind: BenchmarkKind;
  price: number;
  side: Side;             // long-bias = support, short-bias = resistance
}

function randInt(seed: number): () => number {
  // Simple LCG so the "random" benchmark is reproducible per (symbol,
  // interval, fold) — required by spec ("matched by symbol/timeframe/count").
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function generateBenchmarks(
  bars: OhlcvBar[],
  detectionIndex: number,
  intervalLabel: string,
  countToMatch: number,
  seedKey: string,
): BenchmarkLevel[] {
  const detectionBars = bars.slice(0, detectionIndex);
  if (detectionBars.length < 20) return [];

  const out: BenchmarkLevel[] = [];
  const lo = Math.min(...detectionBars.map((b) => b.low));
  const hi = Math.max(...detectionBars.map((b) => b.high));
  const span = hi - lo;
  if (!(span > 0)) return [];

  // 1) Random horizontal levels — count matched
  const seed = Array.from(seedKey).reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 17);
  const rnd = randInt(seed);
  const target = Math.max(1, Math.min(20, countToMatch || 6));
  for (let i = 0; i < target; i++) {
    const price = lo + rnd() * span;
    out.push({ kind: "random", price, side: rnd() < 0.5 ? "long" : "short" });
  }

  // 2) Basic swing highs/lows — pivots
  const piv = findPivots(detectionBars, 3);
  for (const h of piv.highs.slice(-6)) out.push({ kind: "swing-pivot", price: h.high, side: "short" });
  for (const l of piv.lows.slice(-6)) out.push({ kind: "swing-pivot", price: l.low, side: "long" });

  // 3) Previous day high/low and 4) Previous week high/low
  const dailyMs = 86_400 * 1000;
  const lastT = detectionBars[detectionBars.length - 1]!.time * 1000;
  const dayCutoff = lastT - dailyMs;
  const weekCutoff = lastT - 7 * dailyMs;
  const dayBars = detectionBars.filter((b) => b.time * 1000 >= dayCutoff - dailyMs && b.time * 1000 < dayCutoff);
  const weekBars = detectionBars.filter((b) => b.time * 1000 >= weekCutoff - 7 * dailyMs && b.time * 1000 < weekCutoff);
  if (dayBars.length) {
    out.push({ kind: "prev-day-hl", price: Math.max(...dayBars.map((b) => b.high)), side: "short" });
    out.push({ kind: "prev-day-hl", price: Math.min(...dayBars.map((b) => b.low)), side: "long" });
  }
  if (weekBars.length) {
    out.push({ kind: "prev-week-hl", price: Math.max(...weekBars.map((b) => b.high)), side: "short" });
    out.push({ kind: "prev-week-hl", price: Math.min(...weekBars.map((b) => b.low)), side: "long" });
  }

  // 5/6) Market profile POC and Value Area (simple TPO: bin volume by price)
  const bins = 80;
  const step = span / bins;
  const vol = new Array<number>(bins).fill(0);
  for (const b of detectionBars) {
    const mid = (b.high + b.low) / 2;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((mid - lo) / step)));
    vol[idx]! += b.volume;
  }
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (vol[i]! > vol[pocIdx]!) pocIdx = i;
  const pocPrice = lo + (pocIdx + 0.5) * step;
  out.push({ kind: "market-profile-poc", price: pocPrice, side: "long" });
  out.push({ kind: "market-profile-poc", price: pocPrice, side: "short" });

  // Value area = 70% of volume around POC
  const totalVol = vol.reduce((s, v) => s + v, 0);
  const target70 = totalVol * 0.7;
  let lo_i = pocIdx, hi_i = pocIdx, acc = vol[pocIdx]!;
  while (acc < target70 && (lo_i > 0 || hi_i < bins - 1)) {
    const left = lo_i > 0 ? vol[lo_i - 1]! : -1;
    const right = hi_i < bins - 1 ? vol[hi_i + 1]! : -1;
    if (right >= left) { hi_i++; acc += vol[hi_i]!; }
    else { lo_i--; acc += vol[lo_i]!; }
  }
  out.push({ kind: "value-area", price: lo + (lo_i + 0.5) * step, side: "long" });   // VAL
  out.push({ kind: "value-area", price: lo + (hi_i + 0.5) * step, side: "short" });  // VAH

  // 7) VWAP bands (rolling, last 100 bars)
  const win = detectionBars.slice(-Math.min(100, detectionBars.length));
  let pv = 0, vv = 0;
  for (const b of win) { const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; vv += b.volume; }
  if (vv > 0) {
    const vwap = pv / vv;
    const sd = Math.sqrt(win.reduce((s, b) => {
      const tp = (b.high + b.low + b.close) / 3;
      return s + Math.pow(tp - vwap, 2) * b.volume;
    }, 0) / vv);
    out.push({ kind: "vwap-band", price: vwap, side: "long" });
    out.push({ kind: "vwap-band", price: vwap + sd, side: "short" });
    out.push({ kind: "vwap-band", price: vwap - sd, side: "long" });
  }

  // 8) Equal highs / equal lows — cluster pivot prices within 0.1% bands
  const eqTol = (hi - lo) * 0.002;
  const buckets = new Map<number, { price: number; count: number; side: Side }>();
  for (const h of piv.highs) {
    const k = Math.round(h.high / eqTol);
    const cur = buckets.get(k) ?? { price: h.high, count: 0, side: "short" };
    cur.count++; buckets.set(k, cur);
  }
  for (const l of piv.lows) {
    const k = Math.round(l.low / eqTol) + 1_000_000;
    const cur = buckets.get(k) ?? { price: l.low, count: 0, side: "long" };
    cur.count++; buckets.set(k, cur);
  }
  for (const b of buckets.values()) if (b.count >= 2) out.push({ kind: "equal-highs-lows", price: b.price, side: b.side });

  // Lightly cap to keep eval bounded.
  return out.slice(0, 80);
  void intervalLabel;
}
