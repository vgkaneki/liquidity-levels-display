export interface DrawingRenderContext {
  ctx: CanvasRenderingContext2D;
  chartW: number;
  chartH: number;
  compact: boolean;
}

// chartDrawingRendererV1: extraction target for drawing-tool rendering helpers.
// Display-only module; it does not own market data, level accuracy, scoring,
// confluence, DOM, Bookmap, absorption, or touch-classification logic.
export function drawingStrokeWidth(compact: boolean, selected = false): number {
  if (selected) return compact ? 1.25 : 1.75;
  return compact ? 0.9 : 1.25;
}

export function shouldShowDrawingHandle(compact: boolean, selected: boolean): boolean {
  return selected && !compact;
}
