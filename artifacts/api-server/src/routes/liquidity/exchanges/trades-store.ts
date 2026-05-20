// Per-symbol rolling buffer of recent trade prints. Fed by the OKX and HL
// trade WebSocket channels and consumed by the structural-levels engine
// (VPIN, absorption, VWOE, tape-VWAP, delta-exhaustion).
//
// We keep the last `WINDOW_MS` of trades capped at `MAX_TRADES` per symbol so
// memory stays bounded even on very fast markets. Eviction happens on every
// write; readers never block on housekeeping.

export interface TradeLite {
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
}

const WINDOW_MS = 60_000;
const MAX_TRADES = 5_000;

const buffers = new Map<string, TradeLite[]>();

type TradeListener = (symbol: string, trades: TradeLite[]) => void;
const tradeListeners = new Set<TradeListener>();
export function subscribeTradeUpdates(fn: TradeListener): () => void {
  tradeListeners.add(fn);
  return () => tradeListeners.delete(fn);
}
function emitTrades(symbol: string, trades: TradeLite[]): void {
  if (trades.length === 0 || tradeListeners.size === 0) return;
  for (const fn of tradeListeners) {
    try { fn(symbol, trades); } catch { /* swallow */ }
  }
}

function trimBuffer(arr: TradeLite[], now: number): void {
  const cutoff = now - WINDOW_MS;
  while (arr.length > 0 && (arr[0]?.time ?? 0) < cutoff) arr.shift();
  if (arr.length > MAX_TRADES) arr.splice(0, arr.length - MAX_TRADES);
}

export function addTrade(symbol: string, trade: TradeLite): void {
  let arr = buffers.get(symbol);
  if (!arr) {
    arr = [];
    buffers.set(symbol, arr);
  }
  arr.push(trade);
  trimBuffer(arr, Date.now());
  emitTrades(symbol, [trade]);
}

export function addTrades(symbol: string, trades: TradeLite[]): void {
  if (trades.length === 0) return;
  let arr = buffers.get(symbol);
  if (!arr) {
    arr = [];
    buffers.set(symbol, arr);
  }
  for (const t of trades) arr.push(t);
  arr.sort((a, b) => a.time - b.time);
  trimBuffer(arr, Date.now());
  emitTrades(symbol, trades);
}

// Returns trades within the last `windowMs` (default = full buffer window).
// Always returns a fresh array so callers can mutate without affecting the
// buffer.
export function getRecentTrades(
  symbol: string,
  windowMs: number = WINDOW_MS,
): TradeLite[] {
  const arr = buffers.get(symbol);
  if (!arr || arr.length === 0) return [];
  const cutoff = Date.now() - windowMs;
  const out: TradeLite[] = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i]!;
    if (t.time >= cutoff) out.push(t);
  }
  return out;
}

export function forgetTrades(symbol: string): void {
  buffers.delete(symbol);
}

export function tradesStoreStats(): {
  symbols: number;
  totalTrades: number;
  oldestAgeMs: number | null;
} {
  let total = 0;
  let oldest: number | null = null;
  const now = Date.now();
  for (const arr of buffers.values()) {
    total += arr.length;
    const first = arr[0];
    if (first) {
      const age = now - first.time;
      if (oldest === null || age > oldest) oldest = age;
    }
  }
  return { symbols: buffers.size, totalTrades: total, oldestAgeMs: oldest };
}
