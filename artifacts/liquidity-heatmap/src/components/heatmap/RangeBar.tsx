import { Play, Clock, ChevronsRight } from "lucide-react";
import type { Interval } from "./HeatmapChart";

const RANGES: Array<{ id: string; label: string; minutes: number }> = [
  { id: "1D", label: "1D", minutes: 60 * 24 },
  { id: "5D", label: "5D", minutes: 60 * 24 * 5 },
  { id: "1M", label: "1M", minutes: 60 * 24 * 30 },
  { id: "3M", label: "3M", minutes: 60 * 24 * 90 },
  { id: "6M", label: "6M", minutes: 60 * 24 * 180 },
  { id: "YTD", label: "YTD", minutes: -1 },
  { id: "1Y", label: "1Y", minutes: 60 * 24 * 365 },
  { id: "All", label: "All", minutes: Number.POSITIVE_INFINITY },
];

const INTERVAL_MIN: Record<string, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1H": 60, "2H": 120, "4H": 240, "6H": 360, "12H": 720,
  "1D": 1440, "1W": 10080,
};

interface Props {
  interval: Interval;
  onZoomToRange: (visibleBars: number) => void;
  utcOffset?: string;
}

export function RangeBar({ interval, onZoomToRange, utcOffset }: Props) {
  const intervalMin = INTERVAL_MIN[interval] ?? 240;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour12: false });
  const tz = utcOffset ?? "UTC";

  const apply = (rangeMin: number) => {
    let bars: number;
    if (rangeMin === -1) {
      // YTD
      const start = new Date(now.getFullYear(), 0, 1).getTime();
      bars = Math.ceil((now.getTime() - start) / (intervalMin * 60_000));
    } else if (!isFinite(rangeMin)) {
      bars = Number.POSITIVE_INFINITY;
    } else {
      bars = Math.ceil(rangeMin / intervalMin);
    }
    onZoomToRange(Math.max(20, bars));
  };

  return (
    <div
      className="flex items-center justify-between gap-2 px-2 sm:px-3 h-8 border-t border-border bg-card text-xs font-mono shrink-0"
      data-testid="range-bar"
    >
      <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
        {RANGES.map((r) => (
          <button
            key={r.id}
            onClick={() => apply(r.minutes)}
            className="px-2 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase tracking-wider"
            data-testid={`range-${r.id}`}
          >
            {r.label}
          </button>
        ))}
        <div className="w-px h-4 bg-border mx-1" />
        <button
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="Bar replay"
          data-testid="range-replay"
        >
          <Play className="w-3 h-3" />
        </button>
        <button
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="Jump to realtime"
          data-testid="range-jump"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground tabular-nums shrink-0">
        <Clock className="w-3 h-3" />
        <span>{timeStr}</span>
        <span className="opacity-60">{tz}</span>
      </div>
    </div>
  );
}
