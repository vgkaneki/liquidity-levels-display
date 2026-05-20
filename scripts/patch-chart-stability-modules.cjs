const fs = require('fs');

function patch(file, fn) {
  let src = fs.readFileSync(file, 'utf8');
  const next = fn(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[chart-stability-modules-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[chart-stability-modules-patch] skipped ${label}`);
    return src;
  }
  console.log(`[chart-stability-modules-patch] applied ${label}`);
  return src.replace(find, replace);
}

// chartStabilityModulesV1:
// First safe split of HeatmapChart responsibilities plus WebSocket diagnostics.
// Adds chart-readiness gating for secondary overlays, so candles/levels paint
// before analytics/liquidation polling starts. UI/network scheduling only;
// protected engines/formulas/scoring/confluence/DOM/Bookmap/absorption/touch
// classification are untouched.

patch('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', (src) => {
  src = apply(
    src,
    '} from "@/lib/drawingStore";\n',
    '} from "@/lib/drawingStore";\nimport { chartOverlaySettleDelayMs, isChartReadyForOverlays } from "@/lib/chartReadiness";\n',
    'isChartReadyForOverlays',
    'chart readiness import',
  );

  src = apply(
    src,
    '  settingsRef.current = settings;\n',
    '  settingsRef.current = settings;\n  // chartStabilityModulesV1: secondary overlays are gated until the selected\n  // chart has matching candle data and has settled for a short delay.\n  const [chartReadyForOverlays, setChartReadyForOverlays] = useState(false);\n',
    'chartReadyForOverlays',
    'chart-ready state',
  );

  src = apply(
    src,
    '  const anyOverlayEnabled = !compact && (overlayCfg.funding || overlayCfg.oiDelta || overlayCfg.takerPressure || overlayCfg.cvd || overlayCfg.magnetZones);',
    '  const anyOverlayEnabled = chartReadyForOverlays && !compact && (overlayCfg.funding || overlayCfg.oiDelta || overlayCfg.takerPressure || overlayCfg.cvd || overlayCfg.magnetZones);',
    'chartReadyForOverlays && !compact',
    'gate analytics overlays behind chart ready',
  );

  src = apply(
    src,
    '  const realLiqEnabled = !!realLiqIndicator;',
    '  const realLiqEnabled = chartReadyForOverlays && !!realLiqIndicator;',
    'chartReadyForOverlays && !!realLiqIndicator',
    'gate real liquidation overlays behind chart ready',
  );

  src = apply(
    src,
`  candleStateRef.current = {
    loading: candlesLoading,
    errored: !!candleError,
  };
`,
`  candleStateRef.current = {
    loading: candlesLoading,
    errored: !!candleError,
  };

  // chartStabilityModulesV1: give primary chart data priority. Overlay polling
  // remains disabled until matching candles are present, not loading, not
  // errored, and the chart has had a short settle window. This prevents
  // secondary analytics/liquidation requests from competing with candle/level
  // loads during rapid symbol/timeframe changes.
  useEffect(() => {
    setChartReadyForOverlays(false);
    const ready = isChartReadyForOverlays({
      symbol,
      interval,
      candleCount: candleResponse?.candles?.length ?? 0,
      candlesLoading,
      candleErrored: !!candleError,
    });
    if (!ready) return;
    const timer = window.setTimeout(() => {
      setChartReadyForOverlays(true);
    }, chartOverlaySettleDelayMs());
    return () => window.clearTimeout(timer);
  }, [symbol, interval, candleResponse?.candles?.length, candlesLoading, candleError]);
`,
    'give primary chart data priority',
    'chart-ready settle effect',
  );

  return src;
});

patch('artifacts/liquidity-heatmap/src/hooks/useChannel.ts', (src) => {
  src = apply(
    src,
    'import { normalizeSymbolKey } from "@/datafeed/normalize";\n',
    'import { normalizeSymbolKey } from "@/datafeed/normalize";\nimport { recordWsDiagnostic } from "@/lib/chartNetworkDiagnostics";\n',
    'recordWsDiagnostic',
    'ws diagnostics import',
  );

  src = apply(
    src,
`    let ws: WebSocket;
    try {
      ws = new WebSocket(this.socketUrl());
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
`,
`    let ws: WebSocket;
    const url = this.socketUrl();
    try {
      ws = new WebSocket(url);
      recordWsDiagnostic("connect-start", {
        url,
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
    } catch {
      recordWsDiagnostic("error", {
        url,
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
`,
    'recordWsDiagnostic("connect-start"',
    'diagnose websocket connect start',
  );

  src = apply(
    src,
`      this.connecting = false;
      this.reconnectMs = 500;
`,
`      this.connecting = false;
      this.reconnectMs = 500;
      recordWsDiagnostic("open", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
`,
    'recordWsDiagnostic("open"',
    'diagnose websocket open',
  );

  src = apply(
    src,
`      this.ws = null;

      if (!this.paused) {
`,
`      this.ws = null;
      recordWsDiagnostic("close", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });

      if (!this.paused) {
`,
    'recordWsDiagnostic("close"',
    'diagnose websocket close',
  );

  src = apply(
    src,
`    ws.addEventListener("error", () => {
      try {
`,
`    ws.addEventListener("error", () => {
      recordWsDiagnostic("error", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
      try {
`,
    'recordWsDiagnostic("error", {',
    'diagnose websocket error',
  );

  src = apply(
    src,
`    const ms = Math.max(900, this.reconnectMs);
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);
`,
`    const ms = Math.max(900, this.reconnectMs);
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);
    recordWsDiagnostic("reconnect-scheduled", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });
`,
    'recordWsDiagnostic("reconnect-scheduled"',
    'diagnose websocket reconnect scheduling',
  );

  src = apply(
    src,
`  pause(): void {
    this.paused = true;
`,
`  pause(): void {
    this.paused = true;
    recordWsDiagnostic("pause", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });
`,
    'recordWsDiagnostic("pause"',
    'diagnose websocket pause',
  );

  src = apply(
    src,
`    this.paused = false;

    if (this.listeners.size > 0) {
`,
`    this.paused = false;
    recordWsDiagnostic("resume", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    if (this.listeners.size > 0) {
`,
    'recordWsDiagnostic("resume"',
    'diagnose websocket resume',
  );

  src = apply(
    src,
`    set.add(fn);

    if (!this.wanted.has(channel)) {
`,
`    set.add(fn);
    recordWsDiagnostic("subscribe", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    if (!this.wanted.has(channel)) {
`,
    'recordWsDiagnostic("subscribe"',
    'diagnose websocket subscribe',
  );

  src = apply(
    src,
`      cur.delete(fn);

      if (cur.size === 0) {
`,
`      cur.delete(fn);
      recordWsDiagnostic("unsubscribe", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });

      if (cur.size === 0) {
`,
    'recordWsDiagnostic("unsubscribe"',
    'diagnose websocket unsubscribe',
  );

  return src;
});

console.log('[chart-stability-modules-patch] complete');
