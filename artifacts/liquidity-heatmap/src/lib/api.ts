export const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(
  /\/$/,
  "",
);

export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

export function wsUrl(path = "/ws"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;

  if (API_BASE) {
    const wsBase = API_BASE.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    return `${wsBase}${normalized}`;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${normalized}`;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export async function readJson<T>(res: Response, fallback: T): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}
