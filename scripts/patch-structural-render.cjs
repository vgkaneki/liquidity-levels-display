const fs = require('fs');

function patchFile(file, apply) {
  let src = fs.readFileSync(file, 'utf8');
  const once = (find, replace, marker) => {
    if (src.includes(marker)) return;
    if (!src.includes(find)) {
      console.log(`[structural-render-patch] skipped ${marker}`);
      return;
    }
    src = src.replace(find, replace);
    console.log(`[structural-render-patch] applied ${marker}`);
  };
  src = apply(src, once);
  fs.writeFileSync(file, src);
}

patchFile('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', (src, once) => {
  once(
`function scheduleNext(entry: RegistryEntry): void {
  clearTimer(entry);
  const period = effectivePollMs(entry);
  if (period <= 0) return;

  entry.timer = setTimeout(() => {
    void runFetch(entry);
  }, period);
}`,
`function scheduleNext(entry: RegistryEntry): void {
  clearTimer(entry);
  const period = effectivePollMs(entry);
  if (period <= 0) return;

  entry.timer = setTimeout(() => {
    void runFetch(entry);
  }, period);
}

function scheduleSoon(entry: RegistryEntry, delayMs: number): void {
  clearTimer(entry);
  entry.timer = setTimeout(() => {
    void runFetch(entry);
  }, delayMs);
}`,
'function scheduleSoon(entry: RegistryEntry, delayMs: number): void'
  );

  once(
`  for (const sub of entry.subscribers) sub.onLoading(true);

  try {`,
`  for (const sub of entry.subscribers) sub.onLoading(true);

  let scheduledSoon = false;

  try {`,
'let scheduledSoon = false;'
  );

  once(
`    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
    });`,
`    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
      headers: {
        "x-fetch-priority": "high",
      },
    });`,
'"x-fetch-priority": "high"'
  );

  once(
`    const isUsable =
      json &&
      typeof json === "object" &&
      Array.isArray(json.zones) &&
      !isPendingSkeleton;
    if (!isUsable) {
      // Treat as transient — keep showing last-good. Do not call onData.
      return;
    }`,
`    const isUsable =
      json &&
      typeof json === "object" &&
      Array.isArray(json.zones) &&
      !isPendingSkeleton;
    const hasLastGoodZones =
      Array.isArray(entry.latest?.zones) && entry.latest.zones.length > 0;
    const isTransientEmptyReplacement =
      isUsable &&
      Array.isArray(json.zones) &&
      json.zones.length === 0 &&
      hasLastGoodZones &&
      json.unsupported !== true;
    if (!isUsable || isTransientEmptyReplacement) {
      // Treat as transient — keep showing last-good. Do not call onData.
      // Render cold starts and upstream pressure can briefly return pending
      // or empty structural payloads after a valid compute. Do not erase visible
      // structural zones with that temporary response; retry quickly instead.
      if (isPendingSkeleton || isTransientEmptyReplacement) {
        scheduledSoon = true;
        scheduleSoon(entry, 5_000);
      }
      return;
    }`,
'const isTransientEmptyReplacement ='
  );

  once(
`    scheduleNext(entry);
  }
}`,
`    if (!scheduledSoon) {
      scheduleNext(entry);
    }
  }
}`,
'if (!scheduledSoon) {'
  );

  return src;
});

patchFile('artifacts/liquidity-heatmap/src/lib/chartSettings.tsx', (src, once) => {
  once(
`    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      delete parsed.structuralLevels.maxZones;
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);`,
`    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      delete parsed.structuralLevels.maxZones;
      const sl: any = parsed.structuralLevels;
      // Render visibility migration: older saved chart settings can hide every
      // structural zone even when /api/levels returns valid zones. This is UI
      // cleanup only; it does not touch structural/liquidity formulas, scoring,
      // confluence math, DOM, Bookmap, absorption, or touch classification.
      if (sl.__visibilityCleanupV1 !== true) {
        sl.enabled = true;
        sl.confluenceOnly = false;
        if (sl.minConfidence === "high") sl.minConfidence = "medium";
        sl.showLabels = sl.showLabels !== false;
        sl.fillOpacity = Math.max(0.4, Number(sl.fillOpacity ?? 0.5));
        sl.methods = {
          ...DEFAULT_SETTINGS.structuralLevels.methods,
          ...(sl.methods && typeof sl.methods === "object" ? sl.methods : {}),
        };
        if (!Object.values(sl.methods).some(Boolean)) {
          sl.methods = { ...DEFAULT_SETTINGS.structuralLevels.methods };
        }
        sl.__visibilityCleanupV1 = true;
      }
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);`,
'__visibilityCleanupV1'
  );

  return src;
});

console.log('[structural-render-patch] complete');
