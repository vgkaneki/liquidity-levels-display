import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Star } from "lucide-react";
import type { Interval } from "./HeatmapChart";

const FAVORITES_KEY = "thermal.intervalFavorites.v1";

const GROUPS: { label: string; items: Interval[] }[] = [
  { label: "Minutes", items: ["1m", "3m", "5m", "15m", "30m"] },
  { label: "Hours", items: ["1H", "2H", "4H", "6H", "12H"] },
  { label: "Days", items: ["1D", "3D", "1W", "1M"] },
];

const DEFAULT_FAVORITES: Interval[] = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];

function loadFavorites(): Interval[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return DEFAULT_FAVORITES;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as Interval[];
    }
  } catch {}
  return DEFAULT_FAVORITES;
}

interface Props {
  value: Interval;
  onChange: (v: Interval) => void;
}

export function IntervalPicker({ value, onChange }: Props) {
  const [favorites, setFavorites] = useState<Interval[]>(() => loadFavorites());
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    Minutes: true,
    Hours: true,
    Days: true,
  });
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {}
  }, [favorites]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggleFavorite = (iv: Interval) => {
    setFavorites((favs) =>
      favs.includes(iv) ? favs.filter((x) => x !== iv) : [...favs, iv]
    );
  };

  const toggleGroup = (label: string) => {
    setOpenGroups((g) => ({ ...g, [label]: !g[label] }));
  };

  return (
    <div className="flex items-center gap-0.5 bg-accent border border-border rounded-md overflow-visible shrink-0 relative">
      {favorites.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={`px-2 sm:px-2.5 h-8 text-xs font-mono transition-colors ${
            tf === value
              ? "bg-cyan-500/20 text-cyan-400 border-b-2 border-cyan-400"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}
          data-testid={`interval-${tf}`}
        >
          {tf}
        </button>
      ))}
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-1.5 h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-accent border-l border-border/50"
        aria-label="More intervals"
        data-testid="interval-more"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          ref={dropdownRef}
          className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-md shadow-xl z-50 max-h-[480px] overflow-y-auto py-1"
        >
          {GROUPS.map((group) => (
            <div key={group.label}>
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:bg-accent/50"
              >
                <span>{group.label}</span>
                {openGroups[group.label] ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
              {openGroups[group.label] &&
                group.items.map((iv) => (
                  <div
                    key={iv}
                    className={`flex items-center justify-between px-3 py-1.5 text-xs font-mono cursor-pointer hover:bg-accent ${
                      iv === value ? "text-cyan-400" : "text-foreground"
                    }`}
                    onClick={() => {
                      onChange(iv);
                      setOpen(false);
                    }}
                  >
                    <span>{iv}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(iv);
                      }}
                      className="p-0.5 rounded hover:bg-accent/50"
                      aria-label={favorites.includes(iv) ? "Unpin" : "Pin"}
                    >
                      <Star
                        className={`w-3 h-3 ${
                          favorites.includes(iv)
                            ? "fill-cyan-400 text-cyan-400"
                            : "text-muted-foreground"
                        }`}
                      />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
