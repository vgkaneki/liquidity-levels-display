// Pure-JS mirror of src/lib/domAlignment.ts (same pattern as
// src/datafeed/__tests__/shadow.test.mjs). The TS source is the source
// of truth at runtime; this file mirrors the algorithm so the test
// runner stays a pure node:test without a TypeScript toolchain.
//
// What this pins:
//   - Tick size derivation: min non-zero gap, fallback to 10^-decimals
//   - Top-N wall selection: ranks by max(bid,ask), ties on total size
//   - Distance classification bands (tight / near / loose / none)
//   - Side agreement: bid wall + support = agree; ask + resistance = agree
//   - Confidence laddering (high/med/low/none)
//   - Summary metrics: dom coverage rate, registry support rate,
//     side agreement rate
//   - Range filter: only levels within ±rangePct of mark count toward
//     the registry-support denominator

import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_OPTS = {
  topN: 12,
  tightPct: 0.05,
  nearPct: 0.15,
  loosePct: 0.50,
  rangePct: 5.0,
};

function deriveTickSize(levels, priceDecimals) {
  const dec = Math.max(0, Math.min(12, priceDecimals));
  const fallback = Math.pow(10, -dec);
  if (!levels || levels.length < 2) return fallback;
  const prices = [];
  for (const lv of levels) {
    if (Number.isFinite(lv.price) && lv.price > 0) prices.push(lv.price);
  }
  if (prices.length < 2) return fallback;
  prices.sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const gap = prices[i] - prices[i - 1];
    if (gap > 1e-12 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap) || minGap <= 0) return fallback;
  return Math.max(minGap, fallback);
}

function selectTopDomWalls(levels, topN) {
  if (!levels || levels.length === 0 || topN <= 0) return [];
  const out = [];
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const bid = Number.isFinite(lv.bidSize) ? Math.max(0, lv.bidSize) : 0;
    const ask = Number.isFinite(lv.askSize) ? Math.max(0, lv.askSize) : 0;
    const size = Math.max(bid, ask);
    const totalSize = bid + ask;
    if (size <= 0 && totalSize <= 0) continue;
    out.push({
      price: lv.price,
      bidSize: bid,
      askSize: ask,
      size,
      totalSize,
      dominantSide: bid >= ask ? "bid" : "ask",
      sizeRank: 0,
    });
  }
  out.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.totalSize - a.totalSize;
  });
  const trimmed = out.slice(0, topN);
  for (let i = 0; i < trimmed.length; i++) trimmed[i].sizeRank = i + 1;
  return trimmed;
}

function findNearestLevel(price, registry) {
  if (!Number.isFinite(price) || !registry || registry.length === 0) return null;
  let best = null;
  let bestAbs = Infinity;
  for (const lv of registry) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const d = Math.abs(lv.price - price);
    if (d < bestAbs) {
      bestAbs = d;
      best = lv;
    }
  }
  return best;
}

function classifyDistance(distancePct, opts) {
  if (!Number.isFinite(distancePct)) return "none";
  if (distancePct <= opts.tightPct) return "tight";
  if (distancePct <= opts.nearPct) return "near";
  if (distancePct <= opts.loosePct) return "loose";
  return "none";
}

function classifySide(wall, level) {
  if (!level) return "n/a";
  const wallSide = wall.dominantSide === "bid" ? "support" : "resistance";
  return wallSide === level.side ? "agree" : "disagree";
}

function classifyConfidence(quality, sizeRank) {
  if (quality === "none") return "none";
  if (quality === "tight" && sizeRank <= 3) return "high";
  if (quality === "tight") return "med";
  if (quality === "near" && sizeRank <= 3) return "med";
  if (quality === "near") return "low";
  return "low";
}

function computeAlignment(depth, registry, markPrice, tickSize, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const walls = selectTopDomWalls(depth, opts.topN);
  if (walls.length === 0) return [];
  const out = [];
  for (const wall of walls) {
    const nearest = findNearestLevel(wall.price, registry);
    let distance = null;
    let quality = "none";
    if (nearest) {
      const priceDiff = Math.abs(nearest.price - wall.price);
      const ticks = tickSize > 0 ? priceDiff / tickSize : 0;
      const percent =
        markPrice && markPrice > 0 ? (priceDiff / markPrice) * 100 : Infinity;
      distance = { price: priceDiff, ticks, percent };
      quality = classifyDistance(percent, opts);
    }
    const sideAgreement = classifySide(wall, quality === "none" ? null : nearest);
    const confidence = classifyConfidence(quality, wall.sizeRank);
    out.push({
      wall,
      nearestLevel: nearest,
      distance,
      matchQuality: quality,
      sideAgreement,
      confidence,
    });
  }
  return out;
}

function summarize(records, registry, markPrice, tickSize, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const matchedRecs = records.filter(
    (r) => r.matchQuality === "tight" || r.matchQuality === "near",
  );
  const matchedDomWalls = matchedRecs.length;
  const inRange = [];
  if (markPrice && markPrice > 0) {
    const halfBand = (markPrice * opts.rangePct) / 100;
    for (const lv of registry) {
      if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
      if (Math.abs(lv.price - markPrice) <= halfBand) inRange.push(lv);
    }
  }
  let registryWithDomSupport = 0;
  if (inRange.length > 0 && records.length > 0) {
    const nearTol = markPrice ? (markPrice * opts.nearPct) / 100 : 0;
    for (const lv of inRange) {
      let supported = false;
      for (const r of records) {
        if (Math.abs(r.wall.price - lv.price) <= nearTol) {
          supported = true;
          break;
        }
      }
      if (supported) registryWithDomSupport++;
    }
  }
  let sideAgreeCount = 0;
  let sideAgreeTotal = 0;
  for (const r of matchedRecs) {
    if (r.sideAgreement === "agree") {
      sideAgreeCount++;
      sideAgreeTotal++;
    } else if (r.sideAgreement === "disagree") {
      sideAgreeTotal++;
    }
  }
  return {
    domWallCount: records.length,
    matchedDomWalls,
    domCoverageRate: records.length > 0 ? matchedDomWalls / records.length : 0,
    registryLevelsInRange: inRange.length,
    registryWithDomSupport,
    registrySupportRate:
      inRange.length > 0 ? registryWithDomSupport / inRange.length : 0,
    sideAgreeCount,
    sideAgreeTotal,
    sideAgreeRate: sideAgreeTotal > 0 ? sideAgreeCount / sideAgreeTotal : 0,
    tickSize,
    markPrice,
  };
}

// ---------- helpers used by the cases ----------
function lvl(side, price, opts = {}) {
  return {
    id: opts.id ?? `${side}:${price}`,
    symbol: "BTC-USDT",
    side,
    tier: opts.tier ?? 2,
    price,
    strength: opts.strength ?? 0.5,
    reliability: opts.reliability ?? 0.5,
    firstSeenAt: 0,
    lastConfirmedAt: 0,
    touches: opts.touches ?? 0,
    methods: opts.methods ?? [],
  };
}

// ---------- deriveTickSize ----------
test("deriveTickSize: returns smallest non-zero gap", () => {
  const ts = deriveTickSize(
    [
      { price: 100, bidSize: 1, askSize: 0 },
      { price: 100.1, bidSize: 1, askSize: 0 },
      { price: 100.5, bidSize: 1, askSize: 0 },
    ],
    2,
  );
  // Smallest gap is 0.1.
  assert.ok(Math.abs(ts - 0.1) < 1e-9, `expected 0.1, got ${ts}`);
});

test("deriveTickSize: falls back to 10^-decimals on sparse depth", () => {
  assert.equal(deriveTickSize([], 2), 0.01);
  assert.equal(deriveTickSize([{ price: 100, bidSize: 1, askSize: 0 }], 2), 0.01);
});

test("deriveTickSize: ignores invalid prices", () => {
  const ts = deriveTickSize(
    [
      { price: NaN, bidSize: 0, askSize: 0 },
      { price: 0, bidSize: 0, askSize: 0 },
      { price: 100, bidSize: 1, askSize: 0 },
      { price: 100.1, bidSize: 1, askSize: 0 },
    ],
    2,
  );
  assert.ok(Math.abs(ts - 0.1) < 1e-9);
});

// ---------- selectTopDomWalls ----------
test("selectTopDomWalls: ranks by max(bid,ask) and assigns 1-based rank", () => {
  const walls = selectTopDomWalls(
    [
      { price: 100, bidSize: 5, askSize: 0 },
      { price: 200, bidSize: 0, askSize: 50 },
      { price: 300, bidSize: 10, askSize: 10 },
    ],
    3,
  );
  assert.equal(walls.length, 3);
  // 200 has size=50 → rank 1
  assert.equal(walls[0].price, 200);
  assert.equal(walls[0].sizeRank, 1);
  assert.equal(walls[0].dominantSide, "ask");
  // 300 has size=10 (max bid==ask, dominantSide bid via tie) → rank 2
  assert.equal(walls[1].price, 300);
  assert.equal(walls[1].sizeRank, 2);
  assert.equal(walls[1].dominantSide, "bid");
  assert.equal(walls[2].sizeRank, 3);
});

test("selectTopDomWalls: drops zero-size and invalid prices", () => {
  const walls = selectTopDomWalls(
    [
      { price: 100, bidSize: 0, askSize: 0 }, // dropped
      { price: -5, bidSize: 1, askSize: 1 },  // dropped
      { price: NaN, bidSize: 1, askSize: 1 }, // dropped
      { price: 200, bidSize: 1, askSize: 0 }, // kept
    ],
    10,
  );
  assert.equal(walls.length, 1);
  assert.equal(walls[0].price, 200);
});

test("selectTopDomWalls: respects topN cap", () => {
  const levels = Array.from({ length: 50 }, (_, i) => ({
    price: 100 + i,
    bidSize: 50 - i,
    askSize: 0,
  }));
  const walls = selectTopDomWalls(levels, 5);
  assert.equal(walls.length, 5);
  // Top 5 should be the largest sizes (50,49,48,47,46) at prices 100..104
  assert.deepEqual(walls.map((w) => w.price), [100, 101, 102, 103, 104]);
});

// ---------- findNearestLevel ----------
test("findNearestLevel: returns closest by abs price diff", () => {
  const reg = [lvl("support", 100), lvl("resistance", 110), lvl("support", 95)];
  assert.equal(findNearestLevel(96, reg).price, 95); // |96-95|=1 < |96-100|=4
  assert.equal(findNearestLevel(99, reg).price, 100); // |99-100|=1 < |99-95|=4
  assert.equal(findNearestLevel(120, reg).price, 110); // 110 closest to 120
});

test("findNearestLevel: returns null on empty registry", () => {
  assert.equal(findNearestLevel(100, []), null);
});

// ---------- classifyDistance ----------
test("classifyDistance: tight/near/loose/none bands", () => {
  const o = DEFAULT_OPTS;
  assert.equal(classifyDistance(0, o), "tight");
  assert.equal(classifyDistance(0.05, o), "tight");
  assert.equal(classifyDistance(0.06, o), "near");
  assert.equal(classifyDistance(0.15, o), "near");
  assert.equal(classifyDistance(0.16, o), "loose");
  assert.equal(classifyDistance(0.50, o), "loose");
  assert.equal(classifyDistance(0.51, o), "none");
  assert.equal(classifyDistance(Infinity, o), "none");
});

// ---------- classifySide ----------
test("classifySide: bid wall + support = agree", () => {
  const wall = { dominantSide: "bid" };
  assert.equal(classifySide(wall, lvl("support", 100)), "agree");
  assert.equal(classifySide(wall, lvl("resistance", 100)), "disagree");
});

test("classifySide: ask wall + resistance = agree", () => {
  const wall = { dominantSide: "ask" };
  assert.equal(classifySide(wall, lvl("resistance", 100)), "agree");
  assert.equal(classifySide(wall, lvl("support", 100)), "disagree");
});

test("classifySide: null level = n/a", () => {
  assert.equal(classifySide({ dominantSide: "bid" }, null), "n/a");
});

// ---------- classifyConfidence ----------
test("classifyConfidence: ladder is correct", () => {
  assert.equal(classifyConfidence("none", 1), "none");
  assert.equal(classifyConfidence("tight", 1), "high");
  assert.equal(classifyConfidence("tight", 3), "high");
  assert.equal(classifyConfidence("tight", 4), "med");
  assert.equal(classifyConfidence("near", 1), "med");
  assert.equal(classifyConfidence("near", 4), "low");
  assert.equal(classifyConfidence("loose", 1), "low");
  assert.equal(classifyConfidence("loose", 99), "low");
});

// ---------- end-to-end computeAlignment + summarize ----------
test("computeAlignment: tight match produces high-confidence record", () => {
  const depth = [{ price: 77000, bidSize: 100, askSize: 0 }];
  const registry = [lvl("support", 77001)];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.matchQuality, "tight"); // 1/77000 ≈ 0.0013% < 0.05%
  assert.equal(r.sideAgreement, "agree"); // bid + support
  assert.equal(r.confidence, "high");
  assert.ok(Math.abs(r.distance.price - 1) < 1e-6);
  assert.ok(Math.abs(r.distance.ticks - 10) < 1e-6); // 1 / 0.1 = 10 ticks
  assert.ok(r.distance.percent > 0 && r.distance.percent < 0.01);
});

test("computeAlignment: ask wall + resistance level agreement", () => {
  const depth = [{ price: 77500, bidSize: 0, askSize: 80 }];
  const registry = [lvl("resistance", 77500)];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  assert.equal(recs[0].matchQuality, "tight");
  assert.equal(recs[0].sideAgreement, "agree");
});

test("computeAlignment: side disagreement is reported", () => {
  // Bid wall sitting on a resistance level — engine and book disagree.
  const depth = [{ price: 77000, bidSize: 50, askSize: 0 }];
  const registry = [lvl("resistance", 77000)];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  assert.equal(recs[0].sideAgreement, "disagree");
});

test("computeAlignment: out-of-band match is none + n/a", () => {
  // Wall at 77000, level at 80000 → 3.9% away → > loosePct
  const depth = [{ price: 77000, bidSize: 50, askSize: 0 }];
  const registry = [lvl("support", 80000)];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  assert.equal(recs[0].matchQuality, "none");
  assert.equal(recs[0].sideAgreement, "n/a");
  assert.equal(recs[0].confidence, "none");
});

test("computeAlignment: empty registry yields no nearest", () => {
  const recs = computeAlignment(
    [{ price: 77000, bidSize: 50, askSize: 0 }],
    [],
    77000,
    0.1,
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].nearestLevel, null);
  assert.equal(recs[0].matchQuality, "none");
});

test("summarize: domCoverageRate counts only tight+near", () => {
  // 4 walls: 2 match tight, 1 loose, 1 none.
  const depth = [
    { price: 77000, bidSize: 100, askSize: 0 },
    { price: 78000, bidSize: 50, askSize: 0 },
    { price: 76800, bidSize: 30, askSize: 0 },
    { price: 79000, bidSize: 20, askSize: 0 },
  ];
  const registry = [
    lvl("support", 77001),  // tight to wall 1
    lvl("support", 78001),  // tight to wall 2
    lvl("support", 76900),  // 100 off → 0.13% → near (tight=0.05, near=0.15)
    lvl("support", 81000),  // far from wall 4
  ];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  const sum = summarize(recs, registry, 77000, 0.1);
  // walls 1,2 tight; wall 3 near (closest is 76900, 100/77000=0.13%); wall 4 far (closest is 78001, 1000/77000=1.3% > loose)
  assert.equal(sum.domWallCount, 4);
  assert.equal(sum.matchedDomWalls, 3);
  assert.ok(Math.abs(sum.domCoverageRate - 0.75) < 1e-9);
});

test("summarize: registrySupportRate ignores levels outside ±rangePct", () => {
  const depth = [{ price: 77000, bidSize: 100, askSize: 0 }];
  const registry = [
    lvl("support", 77000),  // matched
    lvl("support", 90000),  // out of ±5% range → not counted
  ];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  const sum = summarize(recs, registry, 77000, 0.1);
  assert.equal(sum.registryLevelsInRange, 1);
  assert.equal(sum.registryWithDomSupport, 1);
  assert.equal(sum.registrySupportRate, 1);
});

test("summarize: sideAgreeRate computed only over matched (excludes loose/none)", () => {
  const depth = [
    { price: 77000, bidSize: 100, askSize: 0 }, // bid wall — matched tight
    { price: 78000, bidSize: 0, askSize: 80 },  // ask wall — matched tight
    { price: 80000, bidSize: 5, askSize: 0 },   // bid wall — nearest level is 2.6% away → none
  ];
  // Registry has only the two levels near walls 1+2; wall 3 has no nearby level.
  const registry = [
    lvl("support", 77000), // bid + support → agree
    lvl("support", 78000), // ask + support → DISAGREE
  ];
  const recs = computeAlignment(depth, registry, 77000, 0.1);
  const sum = summarize(recs, registry, 77000, 0.1);
  assert.equal(sum.sideAgreeTotal, 2); // walls 1,2 only — wall 3 is matchQuality=none, n/a
  assert.equal(sum.sideAgreeCount, 1); // wall 1 only
  assert.equal(sum.sideAgreeRate, 0.5);
});

test("summarize: zero-data state returns clean zeros, no NaN", () => {
  const sum = summarize([], [], null, 0.1);
  assert.equal(sum.domWallCount, 0);
  assert.equal(sum.domCoverageRate, 0);
  assert.equal(sum.registrySupportRate, 0);
  assert.equal(sum.sideAgreeRate, 0);
  assert.ok(!Number.isNaN(sum.domCoverageRate));
});
