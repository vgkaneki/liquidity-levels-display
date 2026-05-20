import { useSyncExternalStore } from "react";

export type DrawingToolId =
  | "cursor"
  | "trend"
  | "horizontal"
  | "fib"
  | "brush"
  | "text"
  | "emoji"
  | "ruler"
  | "zoom";

export interface DrawingPoint {
  index: number;
  price: number;
}

export interface ChartDrawing {
  id: string;
  tool: Exclude<DrawingToolId, "cursor" | "zoom">;
  symbol: string;
  interval: string;
  points: DrawingPoint[];
  text?: string;
  createdAt: number;
}

export interface DrawingState {
  activeTool: DrawingToolId;
  magnet: boolean;
  locked: boolean;
  hidden: boolean;
  drawings: ChartDrawing[];
}

const initialState: DrawingState = {
  activeTool: "cursor",
  magnet: false,
  locked: false,
  hidden: false,
  drawings: [],
};

let state: DrawingState = initialState;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<DrawingState>): void {
  state = { ...state, ...next };
  emit();
}

export function getDrawingState(): DrawingState {
  return state;
}

export function subscribeDrawings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDrawingState(): DrawingState {
  return useSyncExternalStore(subscribeDrawings, getDrawingState, getDrawingState);
}

export function setActiveDrawingTool(tool: DrawingToolId): void {
  setState({ activeTool: tool });
}

export function setDrawingToggle(toggle: "magnet" | "locked" | "hidden", value: boolean): void {
  setState({ [toggle]: value } as Partial<DrawingState>);
}

export function clearDrawings(symbol?: string, interval?: string): void {
  const drawings = symbol && interval
    ? state.drawings.filter((d) => !(d.symbol === symbol && d.interval === interval))
    : [];
  setState({ drawings });
}

export function addDrawing(drawing: Omit<ChartDrawing, "id" | "createdAt">): ChartDrawing {
  const full: ChartDrawing = {
    ...drawing,
    id: `draw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  setState({ drawings: [...state.drawings, full] });
  return full;
}

export function removeDrawing(id: string): void {
  setState({ drawings: state.drawings.filter((d) => d.id !== id) });
}
