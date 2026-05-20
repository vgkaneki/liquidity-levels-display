// Time-weighted orderbook snapshots per symbol — anti-spoof smoothing.
//
// The raw `/liquidity/heatmap` endpoint reflects whatever orderbook happens
// to be on the screen at the moment of the request. That single snapshot is
// noisy: large bid/ask "walls" frequently appear for a few seconds and then
// vanish (spoofing or fast cancels). Treating those ephemeral walls as real
// liquidity makes elite-tier levels flicker between requests and rewards
// price points that no real flow has ever transacted at.
//
// To fix that, every heatmap request first pushes the live orderbook into a
// per-symbol ring buffer of recent snapshots, then asks for a *smoothed*
// snapshot back. The smoother bins prices into narrow buckets (5bp of mark
// price wide) and sums each bucket's size across the buffer with an
// exponential time decay (30s half-life). Walls that persist across many
// snapshots survive the averaging at near-full size; walls that appeared
// once and disappeared decay out within a few snapshots. The output is the
// same shape `buildHeatLevels` already consumes, so the rest of the pipeline
// is unchanged.
//
// In-process, in-memory only — no datastore, no network. Per the task plan.

interface Snapshot {
  t: number;
  bids: [number, number][];
  asks: [number, number][];
}

const MAX_SNAPSHOTS_PER_SYMBOL = 12;
const SNAPSHOT_WINDOW_MS = 60_000;
const SMOOTHING_HALFLIFE_MS = 30_000;
const PRICE_BIN_FACTOR = 0.0005;
const MAX_TRACKED_SYMBOLS = 200;

const history = new Map<string, Snapshot[]>();

function evictIfNeeded(): void {
  if (history.size <= MAX_TRACKED_SYMBOLS) return;
  const entries = Array.from(history.entries()).map(([k, snaps]) => ({
    k,
    newest: snaps.length ? snaps[snaps.length - 1].t : 0,
  }));
  entries.sort((a, b) => a.newest - b.newest);
  const toRemove = entries.length - MAX_TRACKED_SYMBOLS;
  for (let i = 0; i < toRemove; i++) {
    history.delete(entries[i].k);
  }
}

export function pushOrderbookSnapshot(
  symbol: string,
  bids: [number, number][],
  asks: [number, number][],
  now: number = Date.now(),
): void {
  const key = symbol.toUpperCase();
  let snaps = history.get(key);
  if (!snaps) {
    snaps = [];
    history.set(key, snaps);
    evictIfNeeded();
  }
  snaps.push({
    t: now,
    bids: bids.slice(0, 300),
    asks: asks.slice(0, 300),
  });
  // Drop snapshots beyond the window OR beyond the cap.
  while (snaps.length > MAX_SNAPSHOTS_PER_SYMBOL) snaps.shift();
  while (snaps.length > 1 && now - snaps[0].t > SNAPSHOT_WINDOW_MS) snaps.shift();
}

/**
 * Time-weighted-average orderbook for a symbol. Returns the smoothed bids/asks
 * that should be fed to `buildHeatLevels` instead of the raw single-snapshot
 * book. Falls back to the most recent raw snapshot when only one sample
 * exists.
 */
export function getSmoothedOrderbook(
  symbol: string,
  markPrice: number,
  now: number = Date.now(),
): { bids: [number, number][]; asks: [number, number][] } | null {
  const key = symbol.toUpperCase();
  const snaps = history.get(key);
  if (!snaps || snaps.length === 0) return null;
  if (snaps.length === 1) {
    return { bids: snaps[0].bids, asks: snaps[0].asks };
  }

  const binWidth = Math.max(markPrice * PRICE_BIN_FACTOR, Number.EPSILON);
  const bidBins = new Map<number, number>();
  const askBins = new Map<number, number>();
  let weightSum = 0;

  for (const snap of snaps) {
    const age = now - snap.t;
    const w = Math.exp((-Math.LN2 * age) / SMOOTHING_HALFLIFE_MS);
    weightSum += w;
    for (const [p, s] of snap.bids) {
      const k = Math.floor(p / binWidth);
      bidBins.set(k, (bidBins.get(k) ?? 0) + s * w);
    }
    for (const [p, s] of snap.asks) {
      const k = Math.floor(p / binWidth);
      askBins.set(k, (askBins.get(k) ?? 0) + s * w);
    }
  }

  if (weightSum <= 0) return { bids: snaps[snaps.length - 1].bids, asks: snaps[snaps.length - 1].asks };

  // Normalize so a perfectly persistent wall keeps its original size after
  // smoothing (rather than being inflated by the number of snapshots).
  const bids: [number, number][] = Array.from(bidBins.entries())
    .map(([k, s]) => [(k + 0.5) * binWidth, s / weightSum] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  const asks: [number, number][] = Array.from(askBins.entries())
    .map(([k, s]) => [(k + 0.5) * binWidth, s / weightSum] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  return { bids, asks };
}

export function _resetBookHistoryForTests(): void {
  history.clear();
}
