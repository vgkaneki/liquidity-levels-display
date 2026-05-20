const fs = require('fs');

function patch(file, fn) {
  let src = fs.readFileSync(file, 'utf8');
  const next = fn(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[chart-request-debounce-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[chart-request-debounce-patch] skipped ${label}`);
    return src;
  }
  console.log(`[chart-request-debounce-patch] applied ${label}`);
  return src.replace(find, replace);
}

// chartRequestDebounceV1:
// Debounce/calm chart-side network work during rapid symbol/timeframe changes.
// Transport/UI scheduling only; protected engine formulas, scoring, confluence,
// DOM, Bookmap, absorption, and level math are untouched.

patch('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', (src) => {
  src = apply(
    src,
`    const unsubscribe = subscribe(symbol, interval, sub);

    return () => {
      cancelled = true;
      unsubscribe();
    };`,
`    // chartRequestDebounceV1: rapid timeframe sweeps can mount/unmount several
    // structural subscriptions inside a few hundred milliseconds. Delay the
    // actual /api/levels subscription slightly so obsolete intermediate
    // intervals never issue a request. Last-good is still primed above, so
    // revisited contexts render instantly while the matching fresh fetch waits.
    let unsubscribe: (() => void) | null = null;
    const debounceMs = Math.max(
      0,
      Number(import.meta.env.VITE_STRUCTURAL_FETCH_DEBOUNCE_MS ?? "350") || 350,
    );
    const subscribeTimer = window.setTimeout(() => {
      if (cancelled) return;
      unsubscribe = subscribe(symbol, interval, sub);
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(subscribeTimer);
      unsubscribe?.();
    };`,
    'chartRequestDebounceV1',
    'debounced structural levels subscription',
  );
  return src;
});

patch('artifacts/liquidity-heatmap/src/hooks/useAnalyticsOverlays.ts', (src) => {
  src = apply(
    src,
    '  pollMs = 5_000,',
    '  pollMs = 15_000,',
    'pollMs = 15_000',
    'slower analytics overlay polling default',
  );
  src = apply(
    src,
`    void poll();
    const id = window.setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      controller?.abort();
    };`,
`    // chartRequestDebounceV1: do not fire overlay requests immediately during
    // symbol/timeframe transitions. Give the primary candle/level requests a
    // short head start, then poll at the configured cadence.
    const firstPollDelayMs = Math.max(
      1_000,
      Number(import.meta.env.VITE_ANALYTICS_OVERLAY_INITIAL_DELAY_MS ?? "1500") || 1_500,
    );
    const firstPollTimer = window.setTimeout(() => void poll(), firstPollDelayMs);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void poll();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(firstPollTimer);
      window.clearInterval(id);
      controller?.abort();
    };`,
    'chartRequestDebounceV1',
    'delayed analytics overlay first poll',
  );
  return src;
});

patch('artifacts/liquidity-heatmap/src/hooks/useLiquidationClusters.ts', (src) => {
  src = apply(
    src,
    '  pollMs = 10_000,',
    '  pollMs = 30_000,',
    'pollMs = 30_000',
    'slower real liquidation cluster polling default',
  );
  src = apply(
    src,
`    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, pollMs);`,
`    // chartRequestDebounceV1: liquidations are secondary overlays. Delay the
    // first poll so fast interval changes do not launch obsolete requests, and
    // skip periodic polls while hidden.
    const firstPollDelayMs = Math.max(
      1_000,
      Number(import.meta.env.VITE_LIQUIDATION_CLUSTER_INITIAL_DELAY_MS ?? "1500") || 1_500,
    );
    const firstPollTimer = window.setTimeout(() => void poll(), firstPollDelayMs);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void poll();
    }, pollMs);`,
    'chartRequestDebounceV1',
    'delayed real liquidation first poll',
  );
  src = apply(
    src,
`      window.clearInterval(id);
      controller?.abort();`,
`      window.clearTimeout(firstPollTimer);
      window.clearInterval(id);
      controller?.abort();`,
    'window.clearTimeout(firstPollTimer)',
    'clear liquidation delayed first poll timer',
  );
  return src;
});

patch('artifacts/liquidity-heatmap/src/hooks/useChannel.ts', (src) => {
  src = apply(
    src,
`    const ms = this.reconnectMs;
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);`,
`    // chartRequestDebounceV1: avoid reconnect chatter from rapid route mounts,
    // mobile visibility flips, or immediate close/open loops. Keep the existing
    // exponential backoff but never reconnect faster than 900ms.
    const ms = Math.max(900, this.reconnectMs);
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);`,
    'never reconnect faster than 900ms',
    'websocket reconnect debounce floor',
  );
  src = apply(
    src,
`          if (this.ws) {
            try { this.ws.close(); } catch { /* swallow */ }
            this.ws = null;
          }
          this.connecting = false;`,
`          if (this.ws) {
            // chartRequestDebounceV1: do not close CONNECTING sockets from the
            // unsubscribe path; browsers log that as a noisy failure. Let the
            // existing open/paused guard close cleanly once the upgrade finishes.
            const state = this.ws.readyState;
            if (state === WebSocket.OPEN) {
              try { this.ws.close(); } catch { /* swallow */ }
              this.ws = null;
            } else if (state === WebSocket.CONNECTING) {
              // Keep the reference so connect() can still see the in-flight socket.
            } else {
              this.ws = null;
            }
          }
          this.connecting = false;`,
    'do not close CONNECTING sockets from the',
    'safe websocket unsubscribe close',
  );
  return src;
});

console.log('[chart-request-debounce-patch] complete');
