import { useEffect, useRef } from "react";
import { apiUrl } from "./api";
// Type-only import to avoid a runtime circular dependency:
// lib/auth.tsx imports `clearPlatformLocalStorage` from this file
// for its logout flow, and we only need the AuthUser shape.
import type { AuthUser } from "./auth";

// ─────────────────────────────────────────────────────────────────
// Per-user preference sync layer.
//
// Mechanism: at boot we monkey-patch `localStorage.setItem` so any
// write under the `thermal[.:]` namespace is debounce-mirrored to
// /api/user/preferences. On user login we GET /api/user/preferences,
// write each value into localStorage, and force a full reload so
// every chart/scanner/etc hook reads the rehydrated state on its
// first render (instead of mid-session, which would break a number
// of useState-from-localStorage initializers).
//
// Scope: this module ONLY persists the platform-state surface
// (chartSettings, scanner mode/filters, indicator/chart-type/interval
// favorites, watchlist name selection). It NEVER touches:
//  • liquidity engine internals
//  • structure engine internals
//  • DOM ladder / DOM Align state
//  • candle generation
//  • exchange clients
//  • level scoring
//  • confluence logic
// All of those continue to live in component state or in their own
// module-internal stores and are unaffected by this layer.
// ─────────────────────────────────────────────────────────────────

const PLATFORM_KEY_RE = /^thermal[.:]/;
// Key namespace keys this sync layer writes for its own bookkeeping.
// We must NEVER mirror these to the server (they're client-only).
const SYNC_BLOCKLIST = new Set<string>([
  "thermal:auth.returnTo",
  "thermal:prefs.hydrated.for",
]);
const HYDRATED_FOR_KEY = "thermal:prefs.hydrated.for";
const DEBOUNCE_MS = 500;
const MAX_VALUE_BYTES = 64 * 1024;

// Per-key debounce timers and the most recent value seen for each
// key. The most-recent value wins so we never PUT stale data when a
// rapid burst of writes lands inside one debounce window.
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

let installed = false;

function isPlatformKey(k: string): boolean {
  return typeof k === "string" && PLATFORM_KEY_RE.test(k) && !SYNC_BLOCKLIST.has(k);
}

async function pushPreference(key: string, rawValue: string): Promise<void> {
  // Server stores arbitrary JSON. Try to parse the localStorage
  // string as JSON first (which is how the platform writes everything
  // via JSON.stringify); fall back to wrapping the raw string so
  // primitive scalars also round-trip.
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  const body = JSON.stringify({ value });
  if (body.length > MAX_VALUE_BYTES) {
    // Silently drop — the server would 413 anyway. We keep the local
    // value (it's the user's actual preference) but stop trying to
    // mirror it. This is rare in practice (largest blob is ~6KB).
    return;
  }
  try {
    await fetch(apiUrl(`/api/user/preferences/${encodeURIComponent(key)}`), {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    // Network failure is non-fatal: the local value persists and the
    // next change to the same key will retry. We deliberately do not
    // surface this to the user — preference sync is a best-effort
    // background convenience, not a critical-path operation.
  }
}

function scheduleMirror(key: string, value: string): void {
  const prev = pendingTimers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pendingTimers.delete(key);
    void pushPreference(key, value);
  }, DEBOUNCE_MS);
  pendingTimers.set(key, t);
}

/**
 * Install the localStorage interceptor exactly once. Idempotent across
 * HMR — we tag the patched function so a second mount doesn't double-
 * wrap and PUT every change twice. Safe to call from React effects.
 */
export function installPreferenceMirror(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  const ls = window.localStorage;
  const original = ls.setItem.bind(ls);
  // Detect a previous install (e.g. across Vite HMR) by tagging.
  if ((ls.setItem as { __thermalPatched?: boolean }).__thermalPatched) {
    installed = true;
    return;
  }
  function patched(this: Storage, key: string, value: string): void {
    original(key, value);
    if (isPlatformKey(key)) {
      try { scheduleMirror(key, value); } catch { /* ignore */ }
    }
  }
  (patched as unknown as { __thermalPatched?: boolean }).__thermalPatched = true;
  ls.setItem = patched as typeof ls.setItem;
  installed = true;
}

/**
 * Wipe every platform-namespaced localStorage and sessionStorage key.
 * Used by the logout flow. Does NOT remove server-persisted prefs —
 * those are exactly what the next login will rehydrate.
 */
export function clearPlatformLocalStorage(): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && PLATFORM_KEY_RE.test(k)) keys.push(k);
      }
      for (const k of keys) storage.removeItem(k);
    } catch { /* storage may be disabled */ }
  }
  // Reset the hydration sentinel so the next login (potentially a
  // different user) re-hydrates from the server.
  try { window.localStorage.removeItem(HYDRATED_FOR_KEY); } catch { /* ignore */ }
}

interface PreferencesPayload {
  preferences: Record<string, unknown>;
}

async function fetchPreferences(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(apiUrl("/api/user/preferences"), { credentials: "include" });
    if (!res.ok) return null;
    const body = (await res.json()) as PreferencesPayload;
    return body?.preferences ?? {};
  } catch {
    return null;
  }
}

/**
 * React component (no DOM output) that drives the post-login hydrate.
 * Mounted once inside <AuthProvider>. When a user becomes available
 * AND we haven't yet hydrated for this user-id, it pulls server prefs,
 * writes them into localStorage, and reloads the page so every hook
 * sees the rehydrated values from its initial render.
 */
export function PreferenceSync({ user }: { user: AuthUser | null }): null {
  const lastHydratedFor = useRef<string | null>(null);

  useEffect(() => {
    installPreferenceMirror();
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let alreadyHydrated = false;
    try {
      alreadyHydrated = window.localStorage.getItem(HYDRATED_FOR_KEY) === user.id;
    } catch { /* ignore */ }
    if (alreadyHydrated) {
      lastHydratedFor.current = user.id;
      return;
    }
    if (lastHydratedFor.current === user.id) return;

    void (async () => {
      const prefs = await fetchPreferences();
      if (cancelled) return;
      if (!prefs) {
        // Network error — mark as hydrated to avoid an infinite reload
        // loop. The mirror layer will still pick up any local change
        // from this point forward.
        try { window.localStorage.setItem(HYDRATED_FOR_KEY, user.id); } catch { /* ignore */ }
        lastHydratedFor.current = user.id;
        return;
      }
      // Apply each preference. We bypass the patched setItem (so we
      // don't immediately PUT-back the value we just GET'd) by
      // suspending mirror writes during the hydrate burst — done by
      // temporarily clearing pending timers after the writes.
      let wroteAny = false;
      for (const [key, val] of Object.entries(prefs)) {
        if (!PLATFORM_KEY_RE.test(key)) continue;
        try {
          const stringified = typeof val === "string" ? val : JSON.stringify(val);
          window.localStorage.setItem(key, stringified);
          wroteAny = true;
        } catch { /* skip bad entry */ }
      }
      // Drop any mirror timers our own hydrate writes scheduled — we
      // already have the canonical value from the server.
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();

      try { window.localStorage.setItem(HYDRATED_FOR_KEY, user.id); } catch { /* ignore */ }
      lastHydratedFor.current = user.id;

      if (wroteAny) {
        // Hard reload so every useState-from-localStorage hook (chart
        // settings, scanner mode, favorites, etc) sees the hydrated
        // values on first render. This is the cleanest correctness
        // guarantee — no half-rehydrated state.
        window.location.reload();
      }
    })();

    return () => { cancelled = true; };
  }, [user]);

  return null;
}
