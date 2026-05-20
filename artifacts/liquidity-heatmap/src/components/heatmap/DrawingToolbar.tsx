import {
  MousePointer2,
  Minus,
  TrendingUp,
  GitBranch,
  Pencil,
  Type,
  Smile,
  Ruler,
  ZoomIn,
  Magnet,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";
import {
  clearDrawings,
  setActiveDrawingTool,
  setDrawingToggle,
  useDrawingState,
  type DrawingToolId,
} from "@/lib/drawingStore";

type ToolId = DrawingToolId | "magnet" | "lock" | "hide" | "trash";

interface Tool {
  id: ToolId;
  Icon: typeof MousePointer2;
  label: string;
  toggle?: boolean;
  destructive?: boolean;
}

const TOOLS: Tool[] = [
  { id: "cursor", Icon: MousePointer2, label: "Cross / pan" },
  { id: "trend", Icon: TrendingUp, label: "Trend line" },
  { id: "horizontal", Icon: Minus, label: "Horizontal price line" },
  { id: "fib", Icon: GitBranch, label: "Fib retracement" },
  { id: "text", Icon: Type, label: "Text note" },
  { id: "brush", Icon: Pencil, label: "Brush" },
  { id: "emoji", Icon: Smile, label: "Emoji marker" },
  { id: "ruler", Icon: Ruler, label: "Measure" },
  { id: "zoom", Icon: ZoomIn, label: "Zoom in" },
  { id: "magnet", Icon: Magnet, label: "Snap drawings to nearest visible level", toggle: true },
  { id: "lock", Icon: Lock, label: "Lock drawings", toggle: true },
  { id: "hide", Icon: Eye, label: "Hide drawings", toggle: true },
  { id: "trash", Icon: Trash2, label: "Remove drawings on active chart", destructive: true },
];

export function DrawingToolbar({ symbol, interval }: { symbol?: string; interval?: string }) {
  const state = useDrawingState();

  return (
    <div
      className="hidden lg:flex flex-col items-center gap-0.5 py-2 px-1 border-r border-border bg-card shrink-0 select-none"
      data-testid="drawing-toolbar"
    >
      {TOOLS.map(({ id, Icon, label, toggle, destructive }) => {
        const isActive = !toggle && id !== "trash" && state.activeTool === id;
        const isOn = id === "magnet" ? state.magnet : id === "lock" ? state.locked : id === "hide" ? state.hidden : false;
        const Display = id === "hide" && isOn ? EyeOff : id === "lock" && !isOn ? Unlock : Icon;
        return (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => {
              if (id === "trash") {
                clearDrawings(symbol, interval);
                return;
              }
              if (id === "magnet") setDrawingToggle("magnet", !state.magnet);
              else if (id === "lock") setDrawingToggle("locked", !state.locked);
              else if (id === "hide") setDrawingToggle("hidden", !state.hidden);
              else setActiveDrawingTool(id);
            }}
            className={
              "w-8 h-8 flex items-center justify-center rounded transition-colors " +
              (isActive
                ? "bg-cyan-500/20 text-cyan-300"
                : isOn
                ? "bg-amber-500/20 text-amber-300"
                : destructive
                ? "text-rose-300/70 hover:bg-rose-500/15 hover:text-rose-200"
                : "text-muted-foreground hover:bg-accent hover:text-foreground")
            }
            data-testid={`tool-${id}`}
          >
            <Display className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}
