// In-memory level registry with EMA-blended strength, time decay, and
// eviction. Persisted to Postgres via `./persistence` on a debounce so
// discovered levels survive an API-server restart.
//
// The registry is keyed by `${symbol}:${side}:${quantizedPrice}`. When the
// structural-levels orchestrator emits a fresh batch of zones for a
// symbol, `recordZones` reconciles them against the existing rows:
//   - levels in the new batch are confirmed (lastConfirmedAt = now,
//     touches += 1) and have their strength EMA-blended toward the
//     incoming score
//   - levels NOT in the new batch are decayed exponentially toward zero
//     (half-life = DECAY_HALF_LIFE_MS)
//   - levels whose strength falls below MIN_STRENGTH or whose
//     lastConfirmedAt is older than EVICT_AFTER_MS are dropped
//
// All mutations mark the symbol "dirty" so the persistence layer knows to
// snapshot it on the next debounce tick.

import { logger } from "../../lib/logger";
// StructuralZone is the canonical zone shape produced by the standalone
// horizontal-levels engine. midPrice is computed by the registry below
// from priceLow/priceHigh because the engine's zone shape does not emit
// it directly.
export interface StructuralZone {
  priceLow: number;
  priceHigh: number;
  midPrice?: number;
  score: number;
  kind: "support" | "resistance" | "neutral";
  methods: string[];
  posteriorBounceRate?: number | null;
}

export interface RegistryLevel {
  id: string;
  symbol: string;
  side: "support" | "resistance" | "neutral";
  tier: number; // 0..3 (3 = elite)
  price: number;
  strength: number; // EMA-blended 0..1
  reliability: number; // posterior bounce-rate
  firstSeenAt: number;
  lastConfirmedAt: number;
  touches: number;
  methods: string[];
  // Bookkeeping for incremental decay. Not persisted directly: we
  // initialize it to lastConfirmedAt on load, then update it every time
  // the level is touched by recordZones (whether confirmed or decayed).
  // This is what stops the per-cycle decay from compounding incorrectly.
  lastDecayedAt?: number;
}

const EMA_ALPHA = 0.3;
const DECAY_HALF_LIFE_MS = 6 * 60 * 60_000; // 6h
const EVICT_AFTER_MS = 24 * 60 * 60_000; // 24h
const MIN_STRENGTH = 0.05;

function quantizePrice(price: number): string {
  // 5 significant digits keeps very-small-cap (sub-cent) and BTC-class
  // prices both addressable with a stable key.
  if (!Number.isFinite(price) || price <= 0) return "0";
  const mag = Math.pow(10, 4 - Math.floor(Math.log10(price)));
  return String(Math.round(price * mag) / mag);
}

function tierFromScore(score: number): number {
  if (score >= 0.85) return 3;
  if (score >= 0.65) return 2;
  if (score >= 0.4) return 1;
  return 0;
}

class LevelRegistry {
  private bySymbol = new Map<string, Map<string, RegistryLevel>>();
  private dirty = new Set<string>();
  private listeners = new Set<(symbol: string, levels: RegistryLevel[]) => void>();

  loadSnapshot(rows: RegistryLevel[]): void {
    for (const r of rows) {
      let bucket = this.bySymbol.get(r.symbol);
      if (!bucket) {
        bucket = new Map();
        this.bySymbol.set(r.symbol, bucket);
      }
      bucket.set(r.id, r);
    }
    logger.info({ count: rows.length }, "level-registry: snapshot loaded");
  }

  getLevels(symbol: string): RegistryLevel[] {
    const bucket = this.bySymbol.get(symbol);
    if (!bucket) return [];
    const now = Date.now();
    const out: RegistryLevel[] = [];
    let evicted = false;
    // We delete in-place so symbols whose orchestrator has stopped
    // running don't retain a stale set forever. (Without this, a symbol
    // dropped from the warmup list grows in memory until restart.)
    for (const [id, lev] of bucket) {
      const age = now - lev.lastConfirmedAt;
      if (age > EVICT_AFTER_MS) {
        bucket.delete(id);
        evicted = true;
        continue;
      }
      out.push(lev);
    }
    if (evicted) this.dirty.add(symbol);
    return out.sort((a, b) => b.strength - a.strength);
  }

  recordZones(symbol: string, zones: StructuralZone[]): void {
    const now = Date.now();
    let bucket = this.bySymbol.get(symbol);
    if (!bucket) {
      bucket = new Map();
      this.bySymbol.set(symbol, bucket);
    }

    const seen = new Set<string>();
    for (const zone of zones) {
      const side: RegistryLevel["side"] = zone.kind;
      const price = zone.midPrice ?? (zone.priceLow + zone.priceHigh) / 2;
      const id = `${symbol}:${side}:${quantizePrice(price)}`;
      seen.add(id);

      const existing = bucket.get(id);
      const score = Math.max(0, Math.min(1, zone.score));
      if (existing) {
        existing.strength =
          existing.strength * (1 - EMA_ALPHA) + score * EMA_ALPHA;
        existing.reliability = zone.posteriorBounceRate ?? existing.reliability;
        existing.lastConfirmedAt = now;
        existing.lastDecayedAt = now;
        existing.touches += 1;
        existing.tier = tierFromScore(existing.strength);
        existing.price = price;
        existing.methods = zone.methods.slice(0, 8);
      } else {
        bucket.set(id, {
          id,
          symbol,
          side,
          tier: tierFromScore(score),
          price,
          strength: score,
          reliability: zone.posteriorBounceRate ?? 0,
          firstSeenAt: now,
          lastConfirmedAt: now,
          lastDecayedAt: now,
          touches: 1,
          methods: zone.methods.slice(0, 8),
        });
      }
    }

    // Decay anything not seen this batch; evict if it falls below floor.
    // Use the *incremental* dt since we last decayed this level, not
    // (now − lastConfirmedAt). Otherwise every cycle re-applies the full
    // decay window from the original confirmation, over-decaying.
    for (const [id, lev] of bucket) {
      if (seen.has(id)) continue;
      const ageSinceConfirm = now - lev.lastConfirmedAt;
      const lastDecayed = lev.lastDecayedAt ?? lev.lastConfirmedAt;
      const dt = Math.max(0, now - lastDecayed);
      const decay = Math.pow(0.5, dt / DECAY_HALF_LIFE_MS);
      lev.strength = lev.strength * decay;
      lev.lastDecayedAt = now;
      if (lev.strength < MIN_STRENGTH || ageSinceConfirm > EVICT_AFTER_MS) {
        bucket.delete(id);
      } else {
        lev.tier = tierFromScore(lev.strength);
      }
    }

    this.dirty.add(symbol);
    this.notify(symbol);
  }

  // Re-mark a symbol dirty after a persistence failure so the next tick
  // retries the write instead of silently dropping it.
  markDirty(symbol: string): void {
    this.dirty.add(symbol);
  }

  // Internal: surface symbols that have changed since the last drain.
  drainDirty(): string[] {
    const out = Array.from(this.dirty);
    this.dirty.clear();
    return out;
  }

  // Used by persistence to fetch the rows it needs to write.
  rawForSymbol(symbol: string): RegistryLevel[] {
    const bucket = this.bySymbol.get(symbol);
    if (!bucket) return [];
    return Array.from(bucket.values());
  }

  onUpdate(fn: (symbol: string, levels: RegistryLevel[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(symbol: string): void {
    if (this.listeners.size === 0) return;
    const levels = this.getLevels(symbol);
    for (const fn of this.listeners) {
      try {
        fn(symbol, levels);
      } catch (e) {
        logger.warn({ err: e }, "level-registry listener threw");
      }
    }
  }

  stats(): { symbols: number; total: number } {
    let total = 0;
    for (const b of this.bySymbol.values()) total += b.size;
    return { symbols: this.bySymbol.size, total };
  }
}

export const levelRegistry = new LevelRegistry();
