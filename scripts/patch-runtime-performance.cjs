const fs = require('fs');

function patch(file, applyPatch) {
  let src = fs.readFileSync(file, 'utf8');
  const next = applyPatch(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[runtime-performance-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[runtime-performance-patch] skipped ${label}`);
    return src;
  }
  console.log(`[runtime-performance-patch] applied ${label}`);
  return src.replace(find, replace);
}

patch('artifacts/liquidity-heatmap/src/App.tsx', (src) => {
  src = apply(
    src,
    `import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";`,
    `import { Suspense, lazy, useEffect, useState, type ComponentProps, type ComponentType } from "react";`,
    'useEffect, useState, type ComponentProps',
    'react hook imports for delayed alerts',
  );

  src = apply(
    src,
    `import { ChartSettingsDialog } from "@/components/heatmap/ChartSettingsDialog";`,
    ``,
    'lazyChartSettingsDialogV1',
    'remove eager chart settings dialog import',
  );

  src = apply(
    src,
    `const Spike = lazy(() => import("@/pages/Spike"));`,
    `const Spike = lazy(() => import("@/pages/Spike"));
// lazyChartSettingsDialogV1: keep settings UI out of the first app chunk.
// This is display/runtime only and does not touch engines, formulas, scoring,
// DOM logic, Bookmap logic, absorption, or level placement.
const ChartSettingsDialog = lazy(() =>
  import("@/components/heatmap/ChartSettingsDialog").then((m) => ({
    default: m.ChartSettingsDialog,
  })),
);`,
    'lazyChartSettingsDialogV1',
    'lazy chart settings dialog',
  );

  src = apply(
    src,
    `const queryClient = new QueryClient();`,
    `const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // queryDefaultsV1: avoid global focus-refetch storms when users switch
      // tabs or mobile wakes. Individual live queries can still opt into their
      // own intervals. Platform scheduling only; protected engines untouched.
      refetchOnWindowFocus: false,
      retry: 1,
      gcTime: 5 * 60 * 1000,
    },
  },
});`,
    'queryDefaultsV1',
    'safe query defaults',
  );

  src = apply(
    src,
`// The protected app subtree. Everything under here assumes a valid
// session (the RequireAuth wrapper enforces it). The platform's heavy
// providers — ChartSettingsProvider and the toast/alert listeners —
// only mount once a user is signed in, so the public Login/Register
// pages don't pay the cost of bootstrapping any market-data state.
function ProtectedApp() {`,
`// delayedAlertListenerV1: alerts are useful, but they should not open the
// shared websocket during first paint of the chart. Defer this non-critical
// listener so the app shell, chart, candles, and core panels load first.
function DelayedAlertToastListener() {
  const delayMs = Math.max(
    0,
    Number(import.meta.env.VITE_ALERT_LISTENER_DELAY_MS ?? "12000") || 12_000,
  );
  const [enabled, setEnabled] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const timer = window.setTimeout(() => setEnabled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);

  return enabled ? <AlertToastListener /> : null;
}

function LazyChartSettingsDialog() {
  return (
    <Suspense fallback={null}>
      <ChartSettingsDialog />
    </Suspense>
  );
}

// The protected app subtree. Everything under here assumes a valid
// session (the RequireAuth wrapper enforces it). The platform's heavy
// providers — ChartSettingsProvider and the toast/alert listeners —
// only mount once a user is signed in, so the public Login/Register
// pages don't pay the cost of bootstrapping any market-data state.
function ProtectedApp() {`,
    'delayedAlertListenerV1',
    'delayed alert websocket listener',
  );

  src = apply(
    src,
    `        <ChartSettingsDialog />`,
    `        <LazyChartSettingsDialog />`,
    '<LazyChartSettingsDialog />',
    'mount lazy chart settings dialog',
  );

  src = apply(
    src,
    `        <AlertToastListener />`,
    `        <DelayedAlertToastListener />`,
    '<DelayedAlertToastListener />',
    'mount delayed alert listener',
  );

  return src;
});

patch('artifacts/liquidity-heatmap/src/pages/Heatmap.tsx', (src) => {
  src = apply(
    src,
    `import { useState, useEffect, useRef } from "react";`,
    `import { Suspense, lazy, useState, useEffect, useRef } from "react";`,
    'lazyHeatmapPanelsV1',
    'react imports for lazy heatmap panels',
  );

  src = apply(
    src,
    `import { WatchlistPanel } from "@/components/heatmap/WatchlistPanel";\n`,
    ``,
    'lazyHeatmapPanelsV1',
    'remove eager watchlist import',
  );

  src = apply(
    src,
    `import { IndicatorsModal } from "@/components/heatmap/IndicatorsModal";\n`,
    ``,
    'lazyHeatmapPanelsV1',
    'remove eager indicators import',
  );

  src = apply(
    src,
    `import { DomAlignmentPanel } from "@/components/heatmap/DomAlignmentPanel";\n`,
    ``,
    'lazyHeatmapPanelsV1',
    'remove eager DOM alignment import',
  );

  src = apply(
    src,
    `} from "lucide-react";`,
    `} from "lucide-react";

// lazyHeatmapPanelsV1: split non-critical panels from the first chart chunk.
// The visible chart, DOM ladder, Bookmap/heatmap strip, symbol picker, and
// interval controls remain immediate. Secondary panels load only when rendered
// or opened. UI/runtime only; protected engines untouched.
const WatchlistPanel = lazy(() =>
  import("@/components/heatmap/WatchlistPanel").then((m) => ({ default: m.WatchlistPanel })),
);
const IndicatorsModal = lazy(() =>
  import("@/components/heatmap/IndicatorsModal").then((m) => ({ default: m.IndicatorsModal })),
);
const DomAlignmentPanel = lazy(() =>
  import("@/components/heatmap/DomAlignmentPanel").then((m) => ({ default: m.DomAlignmentPanel })),
);

function PanelFallback({ label = "LOADING PANEL..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center min-w-[180px] h-full bg-card text-[10px] font-mono text-muted-foreground animate-pulse">
      {label}
    </div>
  );
}`,
    'lazyHeatmapPanelsV1',
    'lazy heatmap panel declarations',
  );

  src = apply(
    src,
    `<DomAlignmentPanel
                  symbol={symbol}
                  onClose={() => setDomAlignOpen(false)}
                />`,
    `<Suspense fallback={<PanelFallback label="LOADING DOM ALIGN..." />}>
                  <DomAlignmentPanel
                    symbol={symbol}
                    onClose={() => setDomAlignOpen(false)}
                  />
                </Suspense>`,
    'LOADING DOM ALIGN',
    'lazy DOM alignment panel render',
  );

  src = apply(
    src,
    `<WatchlistPanel
            key={rightViewKey}
            symbol={symbol}
            onSelectSymbol={setSymbol}
            initialView={rightView}
          />`,
    `<Suspense fallback={<PanelFallback label="LOADING WATCHLIST..." />}>
            <WatchlistPanel
              key={rightViewKey}
              symbol={symbol}
              onSelectSymbol={setSymbol}
              initialView={rightView}
            />
          </Suspense>`,
    'LOADING WATCHLIST',
    'lazy desktop watchlist render',
  );

  src = apply(
    src,
    `<WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} />`,
    `<Suspense fallback={<PanelFallback label="LOADING WATCHLIST..." />}>
                <WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} />
              </Suspense>`,
    'mobile lazy watchlist render',
    'lazy mobile watchlist render',
  );

  src = apply(
    src,
    `<IndicatorsModal
        open={indicatorsOpen}
        onClose={() => setIndicatorsOpen(false)}
        active={settings.indicators}
        onAdd={(inst) => set("indicators", [...settings.indicators, inst])}
        onRemove={(id) =>
          set("indicators", settings.indicators.filter((x) => x.id !== id))
        }
      />`,
    `{indicatorsOpen && (
        <Suspense fallback={null}>
          <IndicatorsModal
            open={indicatorsOpen}
            onClose={() => setIndicatorsOpen(false)}
            active={settings.indicators}
            onAdd={(inst) => set("indicators", [...settings.indicators, inst])}
            onRemove={(id) =>
              set("indicators", settings.indicators.filter((x) => x.id !== id))
            }
          />
        </Suspense>
      )}`,
    'lazy indicators modal render',
    'lazy indicators modal render',
  );

  return src;
});

patch('artifacts/liquidity-heatmap/vite.config.ts', (src) => apply(
  src,
`    react(),
    tailwindcss(),
    runtimeErrorOverlay(),`,
`    react(),
    tailwindcss(),
    // productionViteSlimV1: Replit runtime error overlays are useful in dev,
    // but they add unnecessary plugin work and code paths to production builds.
    ...(process.env.NODE_ENV === "production" ? [] : [runtimeErrorOverlay()]),`,
  'productionViteSlimV1',
  'production vite plugin slim',
));

console.log('[runtime-performance-patch] complete');
