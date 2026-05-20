// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This component is a DISPLAY-ONLY validation surface. It compares the
// strongest live DOM liquidity walls against the engine's structural /
// liquidity registry levels and surfaces the diagnostic to the user.
//
// It is NOT, and must NEVER become, part of the structural-levels
// engine or the liquidity engine. It must NEVER influence:
//   • level discovery, ranking, persistence, or decay
//   • scoring, pivots, quantile bands, confluence, presets
//   • backtest reliability or any overlay logic
//
// Allowed inputs (read-only):
//   • useDomAlignment hook — itself a read-only adapter over the
//     existing heatmap WS channel + useRegistryLevels public hook.
//
// Forbidden:
//   • Reaching into engine source modules
//   • Mutating registry state
//   • Feeding any panel state back into engine inputs
//
// If a future visual feature needs more context, add it as another
// READ-ONLY adapter. Never wire this panel into engine inputs.
// =====================================================================

import { useMemo } from "react";
import { X, Activity } from "lucide-react";
import { useDomAlignment } from "@/hooks/useDomAlignment";
import type {
  AlignmentRecord,
  Confidence,
  MatchQuality,
  SideAgreement,
} from "@/lib/domAlignment";
import { decimalsForPrice } from "@/lib/chartAxisBus";

interface DomAlignmentPanelProps {
  symbol: string;
  onClose: () => void;
}

const QUALITY_LABEL: Record<MatchQuality, string> = {
  tight: "TIGHT",
  near: "NEAR",
  loose: "LOOSE",
  none: "—",
};

const QUALITY_CLASS: Record<MatchQuality, string> = {
  tight: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  near: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  loose: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  none: "bg-muted/40 text-muted-foreground border-border",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "HIGH",
  med: "MED",
  low: "LOW",
  none: "—",
};

const CONFIDENCE_CLASS: Record<Confidence, string> = {
  high: "text-emerald-300",
  med: "text-cyan-300",
  low: "text-amber-300",
  none: "text-muted-foreground",
};

const SIDE_AGREE_LABEL: Record<SideAgreement, string> = {
  agree: "✓",
  disagree: "✗",
  "n/a": "—",
};

const SIDE_AGREE_CLASS: Record<SideAgreement, string> = {
  agree: "text-emerald-400",
  disagree: "text-rose-400",
  "n/a": "text-muted-foreground",
};

function formatPrice(p: number, decimals: number): string {
  if (!Number.isFinite(p)) return "—";
  const safe = Math.max(0, Math.min(8, decimals));
  return p.toLocaleString("en-US", {
    minimumFractionDigits: safe,
    maximumFractionDigits: safe,
  });
}

function formatSize(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s >= 1e9) return `${(s / 1e9).toFixed(2)}B`;
  if (s >= 1e6) return `${(s / 1e6).toFixed(2)}M`;
  if (s >= 1e3) return `${(s / 1e3).toFixed(2)}K`;
  if (s >= 100) return s.toFixed(0);
  if (s >= 1) return s.toFixed(2);
  return s.toFixed(4);
}

function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p < 0.01) return `${(p * 100).toFixed(2)}bp`; // sub-1bp
  if (p < 0.1) return `${p.toFixed(3)}%`;
  return `${p.toFixed(2)}%`;
}

function formatTicks(t: number): string {
  if (!Number.isFinite(t)) return "—";
  if (t < 1) return t.toFixed(1);
  if (t < 100) return t.toFixed(0);
  if (t < 1000) return t.toFixed(0);
  return `${(t / 1000).toFixed(1)}k`;
}

function formatRate(r: number): string {
  if (!Number.isFinite(r)) return "—";
  return `${Math.round(r * 100)}%`;
}

function rateChipClass(r: number): string {
  if (r >= 0.7) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (r >= 0.4) return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  if (r > 0) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-muted/30 text-muted-foreground border-border";
}

export function DomAlignmentPanel({ symbol, onClose }: DomAlignmentPanelProps) {
  const { records, summary, isCold } = useDomAlignment(symbol);

  // Pick price decimals from the records (first valid price) or fall
  // back to the symbol-magnitude heuristic. We never reach back into
  // the engine for this — it's a pure display formatting choice.
  const priceDecimals = useMemo(() => {
    const sample =
      records[0]?.wall.price ?? summary.markPrice ?? 0;
    return decimalsForPrice(sample);
  }, [records, summary.markPrice]);

  return (
    <div
      className="absolute top-2 right-2 z-20 w-[380px] max-h-[calc(100%-1rem)] flex flex-col bg-card/95 backdrop-blur-sm border border-border rounded-md shadow-lg overflow-hidden"
      data-testid="dom-alignment-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0">
        <Activity className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-xs font-mono font-semibold text-foreground tracking-wide">
          DOM ALIGN
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          read-only
        </span>
        <button
          onClick={onClose}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close DOM alignment panel"
          data-testid="dom-alignment-close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <SummaryChip
          label="DOM→Lvl"
          value={formatRate(summary.domCoverageRate)}
          tone={rateChipClass(summary.domCoverageRate)}
          tooltip={`Of the top ${summary.domWallCount || 0} DOM walls, ${summary.matchedDomWalls} sit within the near band of one of our levels.`}
        />
        <SummaryChip
          label="Lvl→DOM"
          value={formatRate(summary.registrySupportRate)}
          tone={rateChipClass(summary.registrySupportRate)}
          tooltip={`Of ${summary.registryLevelsInRange} registry levels in the visible window, ${summary.registryWithDomSupport} have a top DOM wall within the near band.`}
        />
        <SummaryChip
          label="Side✓"
          value={
            summary.sideAgreeTotal > 0
              ? formatRate(summary.sideAgreeRate)
              : "—"
          }
          tone={
            summary.sideAgreeTotal > 0
              ? rateChipClass(summary.sideAgreeRate)
              : "bg-muted/30 text-muted-foreground border-border"
          }
          tooltip={`Of ${summary.sideAgreeTotal} matched walls, ${summary.sideAgreeCount} have the order-book's dominant side agreeing with the engine's support/resistance side.`}
        />
      </div>

      {/* Mark + tick size strip */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] font-mono text-muted-foreground border-b border-border bg-card/60 shrink-0">
        <span>
          MARK{" "}
          <span className="text-foreground">
            {summary.markPrice
              ? formatPrice(summary.markPrice, priceDecimals)
              : "—"}
          </span>
        </span>
        <span>
          TICK{" "}
          <span className="text-foreground">
            {summary.tickSize > 0
              ? formatPrice(summary.tickSize, priceDecimals)
              : "—"}
          </span>
        </span>
        <span className="ml-auto">
          {summary.domWallCount} wall{summary.domWallCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[28px_minmax(0,1fr)_56px_minmax(0,1fr)_72px_56px_44px] gap-1 px-3 py-1.5 text-[9.5px] font-mono uppercase text-muted-foreground border-b border-border shrink-0">
        <span></span>
        <span>DOM $</span>
        <span className="text-right">Size</span>
        <span>Lvl $</span>
        <span className="text-right">Dist</span>
        <span className="text-center">Match</span>
        <span className="text-right">Conf</span>
      </div>

      {/* Table body */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden text-[10.5px] font-mono"
        data-testid="dom-alignment-rows"
      >
        {records.length === 0 ? (
          <div className="flex items-center justify-center px-3 py-6 text-muted-foreground text-xs">
            {isCold
              ? "Waiting for orderbook + registry…"
              : "No DOM walls in current depth."}
          </div>
        ) : (
          records.map((rec) => (
            <AlignmentRow
              key={`${rec.wall.price}:${rec.wall.dominantSide}`}
              rec={rec}
              priceDecimals={priceDecimals}
            />
          ))
        )}
      </div>

      {/* Footer note */}
      <div className="px-3 py-1.5 text-[9.5px] font-mono text-muted-foreground border-t border-border bg-card/60 shrink-0">
        diagnostic only · does not influence engines
      </div>
    </div>
  );
}

function SummaryChip({
  label,
  value,
  tone,
  tooltip,
}: {
  label: string;
  value: string;
  tone: string;
  tooltip: string;
}) {
  return (
    <div
      className={`flex flex-col items-start px-2 py-1 rounded border ${tone}`}
      title={tooltip}
    >
      <span className="text-[9px] font-mono uppercase tracking-wider opacity-70">
        {label}
      </span>
      <span className="text-sm font-mono font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function AlignmentRow({
  rec,
  priceDecimals,
}: {
  rec: AlignmentRecord;
  priceDecimals: number;
}) {
  const sideTint =
    rec.wall.dominantSide === "bid"
      ? "text-emerald-300"
      : "text-rose-300";
  const sideBg =
    rec.wall.dominantSide === "bid"
      ? "bg-emerald-500/10"
      : "bg-rose-500/10";

  const distancePrice = rec.distance ? formatPrice(rec.distance.price, priceDecimals) : "—";
  const distanceTicks = rec.distance ? formatTicks(rec.distance.ticks) : "—";
  const distancePct = rec.distance ? formatPct(rec.distance.percent) : "—";
  const distTooltip =
    rec.distance != null
      ? `${distancePrice} · ${distanceTicks} tick${rec.distance.ticks === 1 ? "" : "s"} · ${distancePct}`
      : "no nearby level";

  return (
    <div
      className="grid grid-cols-[28px_minmax(0,1fr)_56px_minmax(0,1fr)_72px_56px_44px] gap-1 px-3 py-1 hover:bg-accent/30 border-b border-border/30 items-center"
      data-testid="dom-alignment-row"
      data-match={rec.matchQuality}
    >
      <span
        className={`flex items-center justify-center text-[10px] font-bold rounded ${sideBg} ${sideTint}`}
        title={
          rec.wall.dominantSide === "bid"
            ? `Bid wall · ${formatSize(rec.wall.bidSize)}`
            : `Ask wall · ${formatSize(rec.wall.askSize)}`
        }
      >
        {rec.wall.dominantSide === "bid" ? "B" : "A"}
      </span>
      <span className="truncate text-foreground tabular-nums" title={String(rec.wall.price)}>
        {formatPrice(rec.wall.price, priceDecimals)}
      </span>
      <span className={`text-right tabular-nums ${sideTint}`}>
        {formatSize(rec.wall.size)}
      </span>
      <span
        className="truncate text-muted-foreground tabular-nums"
        title={
          rec.nearestLevel
            ? `${rec.nearestLevel.side} L${rec.nearestLevel.tier} · strength ${rec.nearestLevel.strength.toFixed(2)} · touches ${rec.nearestLevel.touches}`
            : "no nearby level"
        }
      >
        {rec.nearestLevel ? formatPrice(rec.nearestLevel.price, priceDecimals) : "—"}
      </span>
      <span
        className="flex flex-col items-end leading-tight tabular-nums"
        title={distTooltip}
      >
        <span className="text-foreground">{distanceTicks}t</span>
        <span className="text-[9px] text-muted-foreground">{distancePct}</span>
      </span>
      <span className="flex items-center justify-center gap-1">
        <span
          className={`px-1 py-px rounded border text-[9px] font-semibold tracking-wide ${QUALITY_CLASS[rec.matchQuality]}`}
        >
          {QUALITY_LABEL[rec.matchQuality]}
        </span>
        <span
          className={`text-[11px] ${SIDE_AGREE_CLASS[rec.sideAgreement]}`}
          title={
            rec.sideAgreement === "agree"
              ? "DOM-side and engine-side agree"
              : rec.sideAgreement === "disagree"
                ? "DOM-side and engine-side disagree"
                : "no matched level"
          }
        >
          {SIDE_AGREE_LABEL[rec.sideAgreement]}
        </span>
      </span>
      <span className={`text-right text-[10px] font-semibold ${CONFIDENCE_CLASS[rec.confidence]}`}>
        {CONFIDENCE_LABEL[rec.confidence]}
      </span>
    </div>
  );
}
