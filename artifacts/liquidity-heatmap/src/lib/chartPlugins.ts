export interface ChartPluginContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  symbol: string;
  interval: string;
  view: { startIdx: number; endIdx: number; total: number };
  priceArea: { top: number; bottom: number; left: number; right: number };
}

export type ChartPlugin = (ctx: ChartPluginContext) => void;

const plugins = new Set<ChartPlugin>();

export function registerChartPlugin(p: ChartPlugin): () => void {
  plugins.add(p);
  return () => plugins.delete(p);
}

export function unregisterChartPlugin(p: ChartPlugin): void {
  plugins.delete(p);
}

export function runChartPlugins(ctx: ChartPluginContext): void {
  plugins.forEach((p) => {
    try {
      ctx.ctx.save();
      p(ctx);
    } catch (err) {
      console.error("[chart plugin]", err);
    } finally {
      ctx.ctx.restore();
    }
  });
}

export function listChartPlugins(): ChartPlugin[] {
  return Array.from(plugins);
}
