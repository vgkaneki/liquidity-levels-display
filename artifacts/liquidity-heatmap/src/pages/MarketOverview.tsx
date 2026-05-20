import { useGetMarketOverview } from "@workspace/api-client-react";
import { useChannelSnapshot } from "@/hooks/useChannel";
import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, Flame } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function MarketOverview() {
  // Cold-start REST fetch — same as before, gives an instant render even
  // before the WS connects. Disable refetch interval; live updates flow
  // through the `market:overview` channel below.
  const { data: apiData, isLoading, isError } = useGetMarketOverview({
    query: { refetchInterval: false },
  });

  // Live updates: server pushes a fresh overview every ~5s. The payload
  // shape is identical to the REST response, so we just take the latest
  // snapshot whole.
  const { data: liveOverview } = useChannelSnapshot<typeof apiData>("market:overview");

  // Real-only: when both REST and the live channel are empty (cold start
  // or upstream outage) we render the loading state below instead of
  // fabricating per-symbol stats from a hard-coded table.
  const data = liveOverview ?? apiData;

  const formatCurrency = (val: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(val);
  const formatPct = (val: number) => new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val / 100);

  if (!data) {
    return (
      <div className="flex-1 bg-card flex flex-col justify-center items-center gap-4">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <div className="text-muted-foreground font-mono text-xs animate-pulse">
          {isError ? "MARKET DATA UNAVAILABLE — RETRYING…" : "ACQUIRING MARKET DATA..."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-y-auto p-3 sm:p-6 font-mono text-sm">
      <div className="max-w-5xl mx-auto space-y-4 sm:space-y-6">

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-card border border-border p-4 rounded-sm flex flex-col gap-2 relative overflow-hidden">
            <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/10 rounded-full blur-xl"></div>
            <span className="text-muted-foreground text-xs font-bold">TOTAL OI</span>
            <span className="text-2xl font-bold text-foreground">{formatCurrency(data.totalOpenInterest)}</span>
          </div>
          <div className="bg-card border border-border p-4 rounded-sm flex flex-col gap-2 relative overflow-hidden">
            <div className="absolute -right-4 -top-4 w-24 h-24 bg-cyan-500/10 rounded-full blur-xl"></div>
            <span className="text-muted-foreground text-xs font-bold">24H VOLUME</span>
            <span className="text-2xl font-bold text-foreground">{formatCurrency(data.totalVolume24h)}</span>
          </div>
        </div>

        <div className="bg-card border border-border rounded-sm overflow-hidden">
          <div className="p-3 sm:p-4 border-b border-border flex items-center gap-2 bg-accent/30">
            <Flame className="w-5 h-5 text-primary" />
            <h2 className="font-bold text-base sm:text-lg">TOP LIQUIDITY PAIRS</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[640px]">
            <thead className="bg-muted/30 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-4 py-3 font-bold">Symbol</th>
                <th className="px-4 py-3 font-bold text-right">Mark Price</th>
                <th className="px-4 py-3 font-bold text-right">24h Change</th>
                <th className="px-4 py-3 font-bold text-right">Volume</th>
                <th className="px-4 py-3 font-bold text-right">Open Interest</th>
                <th className="px-4 py-3 font-bold text-center">Liq Score</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.mostLiquid.map((symbol, i) => {
                const isPos = symbol.priceChange24h >= 0;
                return (
                  <tr key={symbol.symbol} className="hover:bg-white/5 transition-colors group">
                    <td className="px-4 py-3 font-bold text-foreground">
                      <Link href={`/?symbol=${symbol.symbol}`} className="hover:text-primary transition-colors flex items-center gap-2">
                        {symbol.symbol}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-cyan-400">
                      ${symbol.markPrice.toLocaleString(undefined, { minimumFractionDigits: symbol.markPrice < 1 ? 4 : 2, maximumFractionDigits: symbol.markPrice < 1 ? 4 : 2 })}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono flex items-center justify-end gap-1 ${isPos ? 'text-green-400' : 'text-red-400'}`}>
                      {isPos ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {Math.abs(symbol.priceChange24h).toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {formatCurrency(symbol.volume24h)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {formatCurrency(symbol.openInterest)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 to-primary"
                          style={{ width: `${Math.min(100, (symbol.liquidityScore / 5) * 100)}%` }}
                        ></div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        asChild
                        size="sm"
                        variant="ghost"
                        className="min-h-0 px-3 py-1 text-primary text-xs font-bold rounded-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                      >
                        <Link href={`/?symbol=${symbol.symbol}`}>VIEW</Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

      </div>
    </div>
  );
}
