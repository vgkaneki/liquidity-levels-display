const fs = require('fs');
const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

if (!src.includes('structuralDiagnosticBadgeV1')) {
  const find = `      {!compact && sl.enabled && structuralUnsupported && (
        <div
          className="absolute z-20 pointer-events-none font-mono text-[10px] tracking-wider"
          style={{ right: 8, top: 8 }}
          data-testid="structural-levels-unsupported"
        >
          <div className="px-2 py-1 rounded border border-white/15 bg-black/55 text-white/70 backdrop-blur-sm">
            Structural levels aren&apos;t available for this symbol
          </div>
        </div>
      )}`;

  const replacement = `      {!compact && sl.enabled && (
        <div
          className="absolute z-20 pointer-events-none font-mono text-[10px] tracking-wider"
          style={{ right: 8, top: structuralUnsupported ? 36 : 8 }}
          data-testid="structural-diagnostic-badge"
        >
          <div className="px-2 py-1 rounded border border-emerald-400/40 bg-black/65 text-emerald-200 backdrop-blur-sm">
            {/* structuralDiagnosticBadgeV1 */}
            SL zones: {structuralZones.length}
          </div>
        </div>
      )}
      {!compact && sl.enabled && structuralUnsupported && (
        <div
          className="absolute z-20 pointer-events-none font-mono text-[10px] tracking-wider"
          style={{ right: 8, top: 8 }}
          data-testid="structural-levels-unsupported"
        >
          <div className="px-2 py-1 rounded border border-white/15 bg-black/55 text-white/70 backdrop-blur-sm">
            Structural levels aren&apos;t available for this symbol
          </div>
        </div>
      )}`;

  if (!src.includes(find)) {
    console.log('[structural-diagnostic-badge-patch] skipped target not found');
  } else {
    src = src.replace(find, replacement);
    fs.writeFileSync(file, src);
    console.log('[structural-diagnostic-badge-patch] applied structuralDiagnosticBadgeV1');
  }
} else {
  console.log('[structural-diagnostic-badge-patch] already applied');
}
