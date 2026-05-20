import { createHash } from "node:crypto";

interface Entry<T> {
  value: T;
  expiresAt: number;
  etag: string;
}

interface Pending<T> {
  promise: Promise<{ value: T; etag: string; expiresAt: number }>;
}

export interface CachedResult<T> {
  value: T;
  etag: string;
  expiresAt: number;
  hit: boolean;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inFlight = new Map<string, Pending<T>>();
  private staleGraceMs: number;

  // `staleGraceMs` controls stale-while-revalidate behavior: an entry that
  // expired up to `staleGraceMs` ago is still served immediately while a
  // background refresh runs (deduped via the in-flight map). Defaults to
  // `ttlMs` so every TtlCache benefits transparently — callers needing
  // strict freshness can opt out with `{ staleGraceMs: 0 }`.
  constructor(
    private ttlMs: number,
    private maxSize = 200,
    options: { staleGraceMs?: number } = {},
  ) {
    this.staleGraceMs = options.staleGraceMs ?? ttlMs;
  }

  async get(key: string, compute: () => Promise<T>): Promise<CachedResult<T>> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) {
      return { value: hit.value, etag: hit.etag, expiresAt: hit.expiresAt, hit: true };
    }

    // Stale-while-revalidate: if we have an entry that expired within the
    // grace window, serve it immediately and kick off a background refresh
    // (deduped against the in-flight map so concurrent callers piggy-back).
    if (hit && this.staleGraceMs > 0 && hit.expiresAt + this.staleGraceMs > now) {
      this.refreshInBackground(key, compute);
      return { value: hit.value, etag: hit.etag, expiresAt: hit.expiresAt, hit: true };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      const r = await pending.promise;
      return { value: r.value, etag: r.etag, expiresAt: r.expiresAt, hit: true };
    }

    const promise = this.startCompute(key, compute);
    try {
      const r = await promise;
      return { value: r.value, etag: r.etag, expiresAt: r.expiresAt, hit: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private startCompute(
    key: string,
    compute: () => Promise<T>,
  ): Promise<{ value: T; etag: string; expiresAt: number }> {
    const promise = (async () => {
      const value = await compute();
      const etag = etagFor(value);
      const expiresAt = Date.now() + this.ttlMs;
      this.store.set(key, { value, etag, expiresAt });
      if (this.store.size > this.maxSize) {
        const drop = this.store.size - this.maxSize;
        const keys = [...this.store.keys()].slice(0, drop);
        for (const k of keys) this.store.delete(k);
      }
      return { value, etag, expiresAt };
    })();
    this.inFlight.set(key, { promise });
    return promise;
  }

  private refreshInBackground(key: string, compute: () => Promise<T>): void {
    if (this.inFlight.has(key)) return;
    const promise = this.startCompute(key, compute);
    promise
      .catch(() => {
        // Swallow — the next foreground request will surface the error.
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
  }

  // Read-only synchronous probe. Returns the cached value when an entry
  // exists and is still fresh, otherwise null. Does NOT trigger a fetch
  // and does NOT block on in-flight computes — callers should treat
  // null as "not warm yet, try again later".
  peek(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  // ---- ADDITIVE, READ-ONLY (validation hardening pass) -----------------
  // Pure introspection getter for the validation suite mutation check.
  // Returns the current key inventory + per-key etag/expiration WITHOUT
  // triggering any compute, refresh, or eviction. Does not mutate any
  // internal map. Safe to call concurrently with normal traffic — this
  // is a snapshot of the live `Map.entries()` at call time.
  // No existing call site uses this; live behavior is unchanged.
  snapshot(): { keys: string[]; etags: Record<string, string>; expiresAt: Record<string, number> } {
    const keys: string[] = [];
    const etags: Record<string, string> = {};
    const expiresAt: Record<string, number> = {};
    for (const [k, v] of this.store) {
      keys.push(k);
      etags[k] = v.etag;
      expiresAt[k] = v.expiresAt;
    }
    return { keys, etags, expiresAt };
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  // Background warmer: re-run `compute` shortly before the entry expires so
  // foreground requests keep hitting warm cache. Returns a stop function.
  scheduleRefresh(
    key: string,
    compute: () => Promise<T>,
    intervalMs?: number,
  ): () => void {
    const period = intervalMs ?? Math.max(5_000, Math.floor(this.ttlMs * 0.8));
    const tick = async () => {
      try {
        const value = await compute();
        const etag = etagFor(value);
        this.store.set(key, { value, etag, expiresAt: Date.now() + this.ttlMs });
      } catch {
        // Swallow — next foreground request will surface the error.
      }
    };
    void tick();
    const handle = setInterval(tick, period);
    if (typeof handle.unref === "function") handle.unref();
    return () => clearInterval(handle);
  }
}

export function etagFor(value: unknown): string {
  const json = JSON.stringify(value, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
  return `"${createHash("sha1").update(json).digest("base64url").slice(0, 24)}"`;
}

export function sendCached<T>(
  res: import("express").Response,
  req: import("express").Request,
  result: CachedResult<T>,
  ttlSeconds: number,
): void {
  // Clamp to >=0 because SWR can return values whose expiresAt is already
  // in the past (served stale by design); a negative max-age confuses
  // intermediaries.
  const maxAge = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000));
  res.setHeader("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${ttlSeconds}`);
  res.setHeader("ETag", result.etag);
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch === result.etag) {
    res.status(304).end();
    return;
  }
  res.json(result.value);
}
