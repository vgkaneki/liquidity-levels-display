import { Suspense, lazy, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout/Layout";
import { ChartSettingsProvider } from "@/lib/chartSettings";

import { AlertToastListener } from "@/components/AlertToastListener";
import { AuthProvider, RequireAuth, useAuth } from "@/lib/auth";
import { PreferenceSync } from "@/lib/preferenceSync";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import { AppErrorBoundary } from "@/components/system/AppErrorBoundary";
import { PerformanceDiagnosticsBadge } from "@/components/system/PerformanceDiagnosticsBadge";

const Heatmap = lazy(() => import("@/pages/Heatmap"));
const MarketOverview = lazy(() => import("@/pages/MarketOverview"));
const Scanner = lazy(() => import("@/pages/Scanner"));
const Alerts = lazy(() => import("@/pages/Alerts"));
const Spike = lazy(() => import("@/pages/Spike"));
// lazyChartSettingsDialogV1: keep settings UI out of the first app chunk.
// This is display/runtime only and does not touch engines, formulas, scoring,
// DOM logic, Bookmap logic, absorption, or level placement.
const ChartSettingsDialog = lazy(() =>
  import("@/components/heatmap/ChartSettingsDialog").then((m) => ({
    default: m.ChartSettingsDialog,
  })),
);

const queryClient = new QueryClient({
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
});
const spikeEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_SPIKE === "true";

function RouteFallback() {
  return (
    <div className="flex-1 bg-background flex items-center justify-center">
      <div className="text-muted-foreground font-mono text-xs animate-pulse">
        LOADING VIEW...
      </div>
    </div>
  );
}

function withSuspense<T extends ComponentType<any>>(Component: T) {
  return function SuspendedRoute(props: ComponentProps<T>) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

const HeatmapRoute = withSuspense(Heatmap);
const MarketOverviewRoute = withSuspense(MarketOverview);
const ScannerRoute = withSuspense(Scanner);
const AlertsRoute = withSuspense(Alerts);
const SpikeRoute = withSuspense(Spike);

// delayedAlertListenerV1: alerts are useful, but they should not open the
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
function ProtectedApp() {
  return (
    <RequireAuth>
      <ChartSettingsProvider>
        <Layout>
          <Switch>
            <Route path="/" component={HeatmapRoute} />
            <Route path="/market" component={MarketOverviewRoute} />
            <Route path="/scanner" component={ScannerRoute} />
            <Route path="/alerts" component={AlertsRoute} />
            {spikeEnabled ? <Route path="/spike" component={SpikeRoute} /> : null}
            <Route component={NotFound} />
          </Switch>
        </Layout>
        <LazyChartSettingsDialog />
        <DelayedAlertToastListener />
      </ChartSettingsProvider>
    </RequireAuth>
  );
}

// Lives inside <AuthProvider>; reads the current user so PreferenceSync
// can hydrate at the right moment without leaking the AuthProvider's
// internals to anyone else. Returns the inner sync component (which
// itself renders nothing).
function PreferenceSyncBridge() {
  const { user } = useAuth();
  return <PreferenceSync user={user} />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route component={ProtectedApp} />
    </Switch>
  );
}

function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <PreferenceSyncBridge />
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRouter />
            </WouterRouter>
          </AuthProvider>
          <PerformanceDiagnosticsBadge />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;
