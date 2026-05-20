const fs = require('fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, src) { fs.writeFileSync(file, src); }
function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[frontend-timeframe-debounce-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[frontend-timeframe-debounce-patch] skipped ${label}`);
    return src;
  }
  console.log(`[frontend-timeframe-debounce-patch] applied ${label}`);
  return src.replace(find, replace);
}

// Frontend request-pressure cleanup only.
// Keeps the timeframe picker visually instant while delaying the network-heavy
// chart/levels/candle interval commit until rapid taps settle. Protected
// liquidity/structural formulas, confluence/scoring, DOM/Bookmap, absorption,
// touch classification, and level placement rules are untouched.
{
  const file = 'artifacts/liquidity-heatmap/src/pages/Heatmap.tsx';
  let src = read(file);

  src = apply(
    src,
`  const [interval, setInterval] = useState<Interval>(getInitialInterval);
  // Persist the active interval / timeframe.
  useEffect(() => { writePersistedString(INTERVAL_KEY, interval); }, [interval]);`,
`  // timeframeSwitchDebounceV1: keep the picker UI immediate, but debounce the
  // chart/data interval commit so rapid mobile taps do not start a separate
  // candle + levels request pair for every intermediate timeframe. This is
  // transport/UI scheduling only; level formulas and engine outputs are untouched.
  const [requestedInterval, setRequestedInterval] = useState<Interval>(getInitialInterval);
  const [interval, setActiveInterval] = useState<Interval>(requestedInterval);
  const intervalCommitTimerRef = useRef<number | null>(null);
  const setInterval = (next: Interval) => {
    setRequestedInterval(next);
    if (intervalCommitTimerRef.current != null) {
      window.clearTimeout(intervalCommitTimerRef.current);
    }
    const delayMs = Math.max(
      120,
      Number(import.meta.env.VITE_TIMEFRAME_SWITCH_DEBOUNCE_MS ?? "220") || 220,
    );
    intervalCommitTimerRef.current = window.setTimeout(() => {
      intervalCommitTimerRef.current = null;
      setActiveInterval(next);
    }, delayMs);
  };
  useEffect(() => {
    return () => {
      if (intervalCommitTimerRef.current != null) {
        window.clearTimeout(intervalCommitTimerRef.current);
        intervalCommitTimerRef.current = null;
      }
    };
  }, []);
  // Persist the user's selected interval immediately, while network-heavy chart
  // consumers receive the debounced active interval above.
  useEffect(() => { writePersistedString(INTERVAL_KEY, requestedInterval); }, [requestedInterval]);`,
    'timeframeSwitchDebounceV1',
    'debounced interval commit',
  );

  src = apply(
    src,
    '<IntervalPicker value={interval} onChange={setInterval} />',
    '<IntervalPicker value={requestedInterval} onChange={setInterval} />',
    'value={requestedInterval}',
    'show pending interval immediately',
  );

  write(file, src);
}

console.log('[frontend-timeframe-debounce-patch] complete');
