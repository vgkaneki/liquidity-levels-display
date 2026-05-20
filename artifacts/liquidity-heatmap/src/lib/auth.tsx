import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Redirect, useLocation } from "wouter";
import { apiUrl } from "./api";
import { clearPlatformLocalStorage } from "./preferenceSync";

// ─────────────────────────────────────────────────────────────────
// Multi-user authentication client. Strict boundary around the
// trading platform: every request below this layer is assumed to be
// authenticated. The boundary itself lives on the server (requireAuth
// middleware on /api); this file is the corresponding browser-side
// session state machine.
//
// Scope guarantees:
//  • The hook NEVER touches market data, levels, candles, alerts,
//    presets, or any engine-owned state directly.
//  • Logout clears only the `thermal[.:]` localStorage namespace —
//    server-saved preferences remain intact and rehydrate on next
//    login (see lib/preferenceSync.tsx).
// ─────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  createdAt: number;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  register: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

// localStorage key the intended-destination guard writes into so the
// post-login redirect lands on the page the user originally tried to
// reach (within the artifact, never an off-site URL).
const RETURN_TO_KEY = "thermal:auth.returnTo";

async function fetchJson(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  const refresh = useCallback(async () => {
    try {
      const res = await fetchJson(apiUrl("/api/auth/me"));
      if (!res.ok) {
        setState({ user: null, loading: false });
        return;
      }
      const body = (await res.json()) as { user: AuthUser | null };
      setState({ user: body.user, loading: false });
    } catch {
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await fetchJson(apiUrl("/api/auth/login"), {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Login failed." }));
        return { ok: false as const, error: body?.error ?? "Login failed." };
      }
      // Read the user back from the response (the server returns
      // { user } on success) and seed it into context so the very next
      // render of the navigated-to page sees `user != null` and the
      // RequireAuth gate lets it through. PreferenceSync may
      // additionally trigger a hard reload after rehydrating server-
      // side preferences — that reload re-runs /api/auth/me and is
      // what guarantees every hook sees the rehydrated values on its
      // first render.
      const body = (await res.json().catch(() => null)) as { user?: AuthUser } | null;
      if (body?.user) setState({ user: body.user, loading: false });
      else await refresh();
      return { ok: true as const };
    },
    [refresh],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const res = await fetchJson(apiUrl("/api/auth/register"), {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Registration failed." }));
        return { ok: false as const, error: body?.error ?? "Registration failed." };
      }
      // Same rationale as login — seed the user into context so the
      // post-submit navigate doesn't race the RequireAuth gate. A
      // brand-new account has no server preferences to hydrate, so
      // PreferenceSync will simply set its sentinel and stay quiet.
      const body = (await res.json().catch(() => null)) as { user?: AuthUser } | null;
      if (body?.user) setState({ user: body.user, loading: false });
      else await refresh();
      return { ok: true as const };
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await fetchJson(apiUrl("/api/auth/logout"), { method: "POST" });
    } catch {
      // Network errors on logout are non-fatal — we still wipe local
      // state and redirect, because the user's intent (kick me out of
      // this browser) does not depend on the server round-trip.
    }
    // Order matters: clear localStorage BEFORE the redirect so any
    // in-flight React effect that re-reads `thermal.*` keys during the
    // redirect tick sees an empty namespace and doesn't accidentally
    // re-PUT the just-cleared values back to the server.
    clearPlatformLocalStorage();
    setState({ user: null, loading: false });
    window.location.replace(
      (import.meta.env.BASE_URL.replace(/\/$/, "") || "") + "/login",
    );
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout, refresh }),
    [state, login, register, logout, refresh],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Route guard. Wraps any subtree that should only be reachable when
 * the user is logged in. While auth state is still loading we show a
 * minimal placeholder rather than a flash-of-redirect; this also
 * prevents the redirect from racing with the initial /api/auth/me
 * fetch on first paint.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-muted-foreground font-mono text-xs">
        AUTHENTICATING...
      </div>
    );
  }
  if (!user) {
    // Stash the intended path so the login page can bounce us back
    // after a successful login. Restricted to in-artifact paths to
    // avoid any open-redirect surface (only "/..." paths).
    try {
      if (location && location.startsWith("/") && location !== "/login" && location !== "/register") {
        window.localStorage.setItem(RETURN_TO_KEY, location);
      }
    } catch { /* localStorage may be disabled */ }
    return <Redirect to="/login" />;
  }
  return <>{children}</>;
}

export function consumeReturnTo(): string {
  try {
    const v = window.localStorage.getItem(RETURN_TO_KEY);
    window.localStorage.removeItem(RETURN_TO_KEY);
    if (v && typeof v === "string" && v.startsWith("/") && !v.startsWith("//")) return v;
  } catch { /* fall through */ }
  return "/";
}
