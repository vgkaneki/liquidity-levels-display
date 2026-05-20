const fs = require('fs');

function patch(file, applyPatch) {
  let src = fs.readFileSync(file, 'utf8');
  const next = applyPatch(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[fast-page-load-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[fast-page-load-patch] skipped ${label}`);
    return src;
  }
  console.log(`[fast-page-load-patch] applied ${label}`);
  return src.replace(find, replace);
}

patch('artifacts/api-server/src/app.ts', (src) => apply(
  src,
`const app: Express = express();

app.use(compression());`,
`const app: Express = express();

app.use(compression());

// fastStaticShellV1: serve the app shell and hashed frontend assets after
// compression but before request logging, sessions, auth, JSON parsing, and API
// routing. This keeps JS/CSS compressed while avoiding session/log middleware
// overhead for page assets. Hosting glue only; no engine logic.
const earlyStaticDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(process.cwd(), "artifacts/liquidity-heatmap/dist/public");

if (fs.existsSync(earlyStaticDir)) {
  app.use(
    express.static(earlyStaticDir, {
      index: false,
      maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
      immutable: process.env.NODE_ENV === "production",
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        }
      },
    }),
  );

  app.get(/.*/, (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(earlyStaticDir, "index.html"));
  });
}`,
  'fastStaticShellV1',
  'early static shell'
));

patch('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', (src) => apply(
  src,
`  // Same max history depth (10000 bars) on every interval — matches the user
  // expectation that zoom-out distance is uniform across timeframes. The API
  // schema cap is 10000.
  const candleLimit = 10000;`,
`  // fastChartCandlesV2: render from a compact recent-history request by
  // default and do NOT auto-upgrade to a 5k request on every symbol/timeframe
  // change. The network panel showed repeated 5000-bar calls competing with
  // active chart interaction. Full/deep history is now opt-in via
  // VITE_AUTO_FULL_CANDLE_HISTORY=1, while engine lookback/formulas stay
  // untouched. UI/data transport only.
  const FAST_CANDLE_LIMIT = Math.min(
    2_500,
    Math.max(500, Number(import.meta.env.VITE_FAST_CHART_CANDLE_LIMIT ?? "1800") || 1_800),
  );
  const FULL_CANDLE_LIMIT = Math.min(
    5_000,
    Math.max(FAST_CANDLE_LIMIT, Number(import.meta.env.VITE_CHART_CANDLE_LIMIT ?? String(FAST_CANDLE_LIMIT)) || FAST_CANDLE_LIMIT),
  );
  const AUTO_FULL_CANDLE_HISTORY = import.meta.env.VITE_AUTO_FULL_CANDLE_HISTORY === "1";
  const [candleLimit, setCandleLimit] = useState(FAST_CANDLE_LIMIT);
  useEffect(() => {
    setCandleLimit(FAST_CANDLE_LIMIT);
    if (!AUTO_FULL_CANDLE_HISTORY || FULL_CANDLE_LIMIT <= FAST_CANDLE_LIMIT) return;
    const delayMs = Math.max(
      10_000,
      Number(import.meta.env.VITE_FULL_CANDLE_HISTORY_DELAY_MS ?? "30000") || 30_000,
    );
    const timer = window.setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setCandleLimit(FULL_CANDLE_LIMIT);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [symbol, interval, FAST_CANDLE_LIMIT, FULL_CANDLE_LIMIT, AUTO_FULL_CANDLE_HISTORY]);`,
  'fastChartCandlesV2',
  'fast chart candle staging without auto 5k burst'
));

console.log('[fast-page-load-patch] complete');
