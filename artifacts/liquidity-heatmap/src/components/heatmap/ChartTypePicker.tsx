import { useRef, useState, useEffect } from "react";
import { ChevronDown, Star } from "lucide-react";
import type { ChartType } from "@/lib/chartSettings";

const FAVORITES_KEY = "thermal.chartTypeFavorites.v1";

const TYPES: { id: ChartType; label: string; icon: string }[] = [
  { id: "candles", label: "Candles", icon: "🕯" },
  { id: "hollow_candles", label: "Hollow candles", icon: "▯" },
  { id: "line", label: "Line", icon: "╱" },
  { id: "line_markers", label: "Line with markers", icon: "•─" },
  { id: "step", label: "Step line", icon: "⌐" },
  { id: "area", label: "Area", icon: "◤" },
  { id: "hlc_area", label: "HLC area", icon: "▲" },
  { id: "baseline", label: "Baseline", icon: "═" },
  { id: "columns", label: "Columns", icon: "▌" },
  { id: "high_low", label: "High-low", icon: "│" },
];

const DEFAULT_FAVORITES: ChartType[] = ["candles", "hollow_candles"];

function loadFavorites(): ChartType[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return DEFAULT_FAVORITES;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ChartType[];
  } catch {}
  return DEFAULT_FAVORITES;
}

interface Props {
  value: ChartType;
  onChange: (v: ChartType) => void;
}

export function ChartTypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState<ChartType[]>(() => loadFavorites());
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {}
  }, [favorites]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = TYPES.find((t) => t.id === value) ?? TYPES[0];

  const favList = TYPES.filter((t) => favorites.includes(t.id));
  const restList = TYPES.filter((t) => !favorites.includes(t.id));

  const toggleFav = (id: ChartType) => {
    setFavorites((favs) =>
      favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id]
    );
  };

  return (
    <div className="relative shrink-0" ref={dropRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 h-8 text-xs font-mono bg-accent border border-border rounded-md text-muted-foreground hover:text-foreground"
        title={current.label}
        data-testid="chart-type-trigger"
      >
        <span className="text-sm leading-none">{current.icon}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-md shadow-xl z-50 max-h-[480px] overflow-y-auto py-1">
          {favList.length > 0 && (
            <>
              {favList.map((t) => (
                <Row
                  key={t.id}
                  type={t}
                  active={t.id === value}
                  starred
                  onClick={() => {
                    onChange(t.id);
                    setOpen(false);
                  }}
                  onStar={() => toggleFav(t.id)}
                />
              ))}
              <div className="my-1 border-t border-border/50" />
            </>
          )}
          {restList.map((t) => (
            <Row
              key={t.id}
              type={t}
              active={t.id === value}
              starred={false}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
              onStar={() => toggleFav(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  type,
  active,
  starred,
  onClick,
  onStar,
}: {
  type: { id: ChartType; label: string; icon: string };
  active: boolean;
  starred: boolean;
  onClick: () => void;
  onStar: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent ${
        active ? "bg-cyan-500/10 text-cyan-400" : "text-foreground"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm leading-none w-4 text-center">{type.icon}</span>
        <span>{type.label}</span>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
        className="p-0.5 rounded hover:bg-accent/50"
        aria-label={starred ? "Unpin" : "Pin"}
      >
        <Star
          className={`w-3 h-3 ${
            starred ? "fill-cyan-400 text-cyan-400" : "text-muted-foreground"
          }`}
        />
      </button>
    </div>
  );
}
