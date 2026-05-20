import { LiquidityHeatmap } from "@workspace/api-client-react";

interface MarketStatsBarProps {
  data: LiquidityHeatmap | null;
}

export function MarketStatsBar({ data }: MarketStatsBarProps) {
  if (!data) {
    return (
      <div className="h-12 border-b border-border bg-card flex items-center px-4 animate-pulse">
        <div className="h-4 bg-muted w-1/3 rounded"></div>
      </div>
    );
  }

  const formatCurrency = (val: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: val < 1 ? 4 : 2 }).format(val);
  const formatCompact = (val: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(val);
  const formatPct = (val: number) => new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val / 100);

  const isPositive = data.priceChange24h >= 0;

  return (
    <div className="h-12 border-b border-border bg-card flex items-center px-3 sm:px-4 gap-4 sm:gap-6 text-xs overflow-x-auto scrollbar-hide shrink-0">
      <div className="flex flex-col">
        <span className="text-muted-foreground">Symbol</span>
        <span className="font-bold text-foreground">{data.symbol}</span>
      </div>
      <div className="w-px h-6 bg-border" />
      <div className="flex flex-col">
        {/*
          The label here used to hard-code "Mark Price" but the field
          is only a true funding mark when the price source is
          Hyperliquid. Toobit / OKX fallbacks publish a last-traded
          price instead — calling that "Mark Price" was misleading. The
          backend now tags every payload with `priceType` ("mark" |
          "last") and we render the label from that tag so the user can
          tell at a glance which they're looking at.
        */}
        <span
          className="text-muted-foreground"
          data-testid="price-label"
          data-price-type={data.priceType ?? "mark"}
        >
          {data.priceType === "last" ? "Last Price" : "Mark Price"}
        </span>
        <span className="font-bold text-cyan-400">{formatCurrency(data.markPrice)}</span>
      </div>
      <div className="w-px h-6 bg-border" />
      <div className="flex flex-col">
        <span className="text-muted-foreground">24h Change</span>
        <span className={`font-bold ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
          {isPositive ? '+' : ''}{data.priceChange24h.toFixed(2)}%
        </span>
      </div>
      <div className="w-px h-6 bg-border" />
      <div className="flex flex-col">
        <span className="text-muted-foreground">24h Volume</span>
        <span className="font-bold text-foreground">{formatCompact(data.volume24h)}</span>
      </div>
      <div className="w-px h-6 bg-border" />
      <div className="flex flex-col">
        <span className="text-muted-foreground">Open Interest</span>
        <span className="font-bold text-foreground">{formatCompact(data.openInterest)}</span>
      </div>
      <div className="w-px h-6 bg-border" />
      <div className="flex flex-col">
        <span className="text-muted-foreground">Funding Rate</span>
        <span className={`font-bold ${data.fundingRate >= 0 ? 'text-orange-400' : 'text-cyan-400'}`}>
          {formatPct(data.fundingRate)}
        </span>
      </div>
    </div>
  );
}
