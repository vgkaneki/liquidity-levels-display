export interface ChartReadyForOverlaysInput {
  symbol?: string;
  interval?: string;
  candleCount: number;
  candlesLoading: boolean;
  candleErrored: boolean;
}

// chartReadyForOverlaysV1: centralizes when secondary overlays may start
// fetching. Candles/primary chart render first; analytics/liquidation overlays
// wait until the selected chart has matching candle data and no candle error.
// UI/network gating only; protected engines and level formulas are untouched.
export function isChartReadyForOverlays(input: ChartReadyForOverlaysInput): boolean {
  return Boolean(
    input.symbol &&
    input.interval &&
    input.candleCount > 0 &&
    !input.candlesLoading &&
    !input.candleErrored,
  );
}

export function chartOverlaySettleDelayMs(): number {
  const raw = Number(import.meta.env.VITE_CHART_OVERLAY_SETTLE_DELAY_MS ?? "500");
  return Math.max(0, Number.isFinite(raw) ? raw : 500);
}
