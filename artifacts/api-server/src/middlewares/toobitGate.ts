// Toobit jurisdiction gate.
//
// Triple-checked: Toobit endpoints are unreachable unless ENABLE_TOOBIT === "1"
// (operator opt-in). Country detection prefers a trusted geo header
// (TOOBIT_GEO_HEADER, e.g. Cloudflare's `cf-ipcountry`) when set by the
// fronting infrastructure. When no such header is available (e.g. on Replit
// Deployments which are not Cloudflare-fronted), the gate falls back to an
// IP-based GeoIP lookup against the request's source IP, with an in-memory
// 24h cache. Fail-closed for US, fail-closed for unknown.
//
// Security notes:
//   - TOOBIT_GEO_HEADER must name a header the fronting infra SETS
//     authoritatively and STRIPS from inbound client requests; otherwise
//     it's trivially spoofable.
//   - The IP fallback relies on `req.ip`, which only reflects the real
//     client when `app.set("trust proxy", ...)` is configured to trust the
//     deployment's reverse proxy chain.

import type { Request, Response, NextFunction } from "express";

const ALLOWED_2LETTER = /^[A-Z]{2}$/;
// Placeholder / aggregate / anonymizer codes used by common geo providers.
// Treated as "unknown" and rejected, so they never satisfy the gate.
//   - Cloudflare: XX (no country), T1 (Tor), A1 (anon proxy), A2 (sat),
//     O1 (other country), EU/AP (regional aggregates)
//   - Common stand-ins: ZZ, UN
const UNKNOWN_CODES = new Set(["XX", "ZZ", "T1", "A1", "A2", "O1", "AP", "EU", "UN"]);
const BLOCKED_COUNTRIES = new Set(["US"]);

const GEOIP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GEOIP_CACHE_MAX = 10_000;
const GEOIP_LOOKUP_TIMEOUT_MS = 1500;

type GeoCacheEntry = { value: string; expiresAt: number };
const geoCache = new Map<string, GeoCacheEntry>();
const inflight = new Map<string, Promise<string>>();

export function toobitEnabled(): boolean {
  return process.env["ENABLE_TOOBIT"] === "1";
}

function reject(res: Response, code: string, message: string): void {
  res.status(403).json({ ok: false, code, error: message, exchange: "toobit" });
}

function readHeaderCountry(req: Request): string {
  const headerName = (process.env["TOOBIT_GEO_HEADER"] || "").trim().toLowerCase();
  if (!headerName) return "";
  const raw = req.headers[headerName];
  return (Array.isArray(raw) ? raw[0] : raw || "").toString().trim().toUpperCase();
}

function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("::ffff:")) return isPrivateOrLocalIp(ip.slice(7));
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] || "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("169.254.")) return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true;
  if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true;
  return false;
}

function getCachedGeo(ip: string): string | null {
  const hit = geoCache.get(ip);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    geoCache.delete(ip);
    return null;
  }
  return hit.value;
}

function setCachedGeo(ip: string, value: string): void {
  if (geoCache.size >= GEOIP_CACHE_MAX) {
    // Simple eviction: drop the oldest insertion (Map preserves insertion order).
    const firstKey = geoCache.keys().next().value;
    if (firstKey !== undefined) geoCache.delete(firstKey);
  }
  geoCache.set(ip, { value, expiresAt: Date.now() + GEOIP_TTL_MS });
}

async function lookupCountryByIp(ip: string): Promise<string> {
  const cached = getCachedGeo(ip);
  if (cached !== null) return cached;
  const pending = inflight.get(ip);
  if (pending) return pending;

  const p = (async (): Promise<string> => {
    // Some free GeoIP services block Node's default User-Agent; supply a
    // browser-like UA. Try the primary first; on failure, fall back to a
    // second provider so a single outage doesn't disable Toobit globally.
    const ua = "Mozilla/5.0 (compatible; ThermalGeoIP/1.0)";
    const headers = { accept: "application/json", "user-agent": ua };
    const fetchOne = async (url: string, parser: (j: unknown) => string): Promise<string> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GEOIP_LOOKUP_TIMEOUT_MS);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers });
        if (!r.ok) return "";
        return parser(await r.json());
      } catch {
        return "";
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const enc = encodeURIComponent(ip);
      // Primary: ipwho.is (free, no key)
      let cc = await fetchOne(
        `https://ipwho.is/${enc}?fields=country_code,success`,
        (j) => {
          const o = j as { success?: boolean; country_code?: string };
          if (o && o.success !== false && typeof o.country_code === "string") {
            return o.country_code.trim().toUpperCase();
          }
          return "";
        },
      );
      // Fallback: ip-api.com (free, no key, HTTP only)
      if (!cc || !ALLOWED_2LETTER.test(cc)) {
        cc = await fetchOne(
          `http://ip-api.com/json/${enc}?fields=status,countryCode`,
          (j) => {
            const o = j as { status?: string; countryCode?: string };
            if (o && o.status === "success" && typeof o.countryCode === "string") {
              return o.countryCode.trim().toUpperCase();
            }
            return "";
          },
        );
      }
      if (cc && ALLOWED_2LETTER.test(cc)) {
        setCachedGeo(ip, cc);
        return cc;
      }
      // Negative-cache unresolvable IPs briefly so we don't hammer upstreams.
      geoCache.set(ip, { value: "", expiresAt: Date.now() + 5 * 60 * 1000 });
      return "";
    } finally {
      inflight.delete(ip);
    }
  })();

  inflight.set(ip, p);
  return p;
}

export async function toobitGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env["ENABLE_TOOBIT"] !== "1") {
    reject(res, "toobit_disabled", "Toobit integration is disabled on this server.");
    return;
  }

  // Dev-only bypass: in non-production environments where the operator has
  // explicitly opted in via TOOBIT_DEV_BYPASS=1, skip jurisdiction checks.
  // This unblocks local/dev preview where req.ip is the internal proxy and
  // GeoIP cannot resolve a real country. NEVER active in production.
  if (
    process.env["NODE_ENV"] !== "production" &&
    process.env["TOOBIT_DEV_BYPASS"] === "1"
  ) {
    next();
    return;
  }

  // 1) Prefer the operator-configured trusted header (e.g. cf-ipcountry).
  let value = readHeaderCountry(req);

  // 2) Fall back to IP-based GeoIP lookup when the header is missing/unknown.
  if (!value || !ALLOWED_2LETTER.test(value) || UNKNOWN_CODES.has(value)) {
    const ip = (req.ip || "").trim();
    if (ip && !isPrivateOrLocalIp(ip)) {
      try {
        value = await lookupCountryByIp(ip);
      } catch {
        value = "";
      }
    }
  }

  if (!value || !ALLOWED_2LETTER.test(value) || UNKNOWN_CODES.has(value)) {
    reject(res, "jurisdiction_unknown", "Country could not be determined.");
    return;
  }
  if (BLOCKED_COUNTRIES.has(value)) {
    reject(res, "jurisdiction_blocked", "Toobit is not available in your region.");
    return;
  }
  next();
}
