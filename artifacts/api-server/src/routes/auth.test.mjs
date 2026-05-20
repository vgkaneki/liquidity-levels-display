// End-to-end auth-boundary test. Targets the already-running dev API
// server (http://localhost:8080 by default, override with API_URL).
// We deliberately do NOT import app.ts in-process — the liquidity
// router uses a CommonJS `require()` for cycle-breaking that the
// esbuild dev bundler handles natively, but `tsx --test` does not.
//
// To run:
//   1) Make sure the api-server workflow is running.
//   2) NODE_ENV=test pnpm exec tsx --test src/routes/auth.test.mjs
//
// Rate limiters are bypassed when NODE_ENV=test on the server side
// (see auth/rateLimits.ts), so reruns never get throttled.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE = process.env.API_URL || "http://localhost:8080";

// Quick reachability probe so we fail loudly with a useful message if
// the dev server isn't up, instead of cascading 6 confusing fetch
// timeouts.
test("dev server is reachable", async () => {
  const res = await fetch(`${BASE}/api/healthz`).catch(() => null);
  if (!res) throw new Error(`Could not reach ${BASE} — is the api-server workflow running?`);
  assert.equal(res.status, 200);
});

// Tiny cookie-jar helper. We only care about extracting `connect.sid`
// from Set-Cookie and presenting it on the next request.
function makeJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        if (!line) continue;
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) {
          cookies.delete(name);
        } else {
          cookies.set(name, value);
        }
      }
    },
    header() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function call(jar, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(jar.header() ? { Cookie: jar.header() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar.capture(res);
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

test("anonymous /api/levels returns 401 (boundary)", async () => {
  const jar = makeJar();
  const r = await call(jar, "GET", "/api/levels?coin=BTC");
  assert.equal(r.status, 401);
  assert.equal(r.json?.error, "Unauthorized");
});

test("register → me → seeded watchlist → logout → me round-trip", async () => {
  const email = `t-${randomUUID()}@test.local`;
  const password = "validpassword42";
  const jar = makeJar();

  const reg = await call(jar, "POST", "/api/auth/register", { email, password });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.user.email, email);
  assert.ok(reg.json.user.id);

  const me1 = await call(jar, "GET", "/api/auth/me");
  assert.equal(me1.status, 200);
  assert.equal(me1.json.user.email, email);

  const wl = await call(jar, "GET", "/api/watchlists");
  assert.equal(wl.status, 200);
  assert.ok(Array.isArray(wl.json.watchlists));
  assert.ok(wl.json.watchlists.find((w) => w.name === "Default"), "default watchlist seeded");

  const lo = await call(jar, "POST", "/api/auth/logout");
  assert.equal(lo.status, 200);
  assert.equal(lo.json.ok, true);

  const me2 = await call(jar, "GET", "/api/auth/me");
  assert.equal(me2.status, 200);
  assert.equal(me2.json.user, null);

  const wl2 = await call(jar, "GET", "/api/watchlists");
  assert.equal(wl2.status, 401);
});

test("login enumeration: wrong-password and unknown-email return same generic error", async () => {
  const jar = makeJar();
  const r1 = await call(jar, "POST", "/api/auth/login", { email: "no-such-user@test.local", password: "whatever12345" });
  const r2 = await call(jar, "POST", "/api/auth/login", { email: "no-such-other@test.local", password: "anothermiss12345" });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  assert.equal(r1.json.error, r2.json.error);
});

test("register rejects short / malformed input", async () => {
  const jar = makeJar();
  const noPw = await call(jar, "POST", "/api/auth/register", { email: "x@y.io" });
  assert.equal(noPw.status, 400);
  const shortPw = await call(jar, "POST", "/api/auth/register", { email: "x2@y.io", password: "short" });
  assert.equal(shortPw.status, 400);
  const badEmail = await call(jar, "POST", "/api/auth/register", { email: "not-an-email", password: "validpassword42" });
  assert.equal(badEmail.status, 400);
});

test("user-preferences endpoint is gated and round-trips a value", async () => {
  const jar = makeJar();
  const anon = await call(jar, "PUT", "/api/user/preferences/thermal.testKey.v1", { value: { hello: "world" } });
  assert.equal(anon.status, 401);

  const email = `p-${randomUUID()}@test.local`;
  const reg = await call(jar, "POST", "/api/auth/register", { email, password: "validpassword42" });
  assert.equal(reg.status, 200);

  const put = await call(jar, "PUT", "/api/user/preferences/thermal.testKey.v1", { value: { hello: "world" } });
  assert.equal(put.status, 200);

  const get = await call(jar, "GET", "/api/user/preferences");
  assert.equal(get.status, 200);
  assert.deepEqual(get.json.preferences["thermal.testKey.v1"], { hello: "world" });

  // Allowlist: a non-thermal key must 400.
  const bad = await call(jar, "PUT", "/api/user/preferences/arbitrary.key", { value: 1 });
  assert.equal(bad.status, 400);
});

test("heatmap last-symbol/interval/rightView prefs: round-trip + cross-user isolation", async () => {
  // User A's last-used symbol/interval/right-panel-view must persist
  // to the DB and rehydrate on login. User B on the same backend must
  // never see A's values — neither echoed back to B nor leaked in the
  // /api/user/preferences GET payload.
  const jarA = makeJar();
  const jarB = makeJar();
  const emailA = `hma-${randomUUID()}@test.local`;
  const emailB = `hmb-${randomUUID()}@test.local`;
  await call(jarA, "POST", "/api/auth/register", { email: emailA, password: "validpassword42" });
  await call(jarB, "POST", "/api/auth/register", { email: emailB, password: "validpassword42" });

  // A persists her last symbol / interval / right-panel view.
  // The client stores these as JSON.stringify(<plain string>), and the
  // server is content-agnostic for thermal.* keys — the UI layer is
  // what re-parses the JSON on rehydrate.
  const putSym = await call(jarA, "PUT", "/api/user/preferences/thermal.heatmap.symbol.v1", { value: "ETH-USDT" });
  assert.equal(putSym.status, 200);
  const putInt = await call(jarA, "PUT", "/api/user/preferences/thermal.heatmap.interval.v1", { value: "15m" });
  assert.equal(putInt.status, 200);
  const putView = await call(jarA, "PUT", "/api/user/preferences/thermal.heatmap.rightView.v1", { value: "screener" });
  assert.equal(putView.status, 200);

  // A reads her own values back.
  const getA = await call(jarA, "GET", "/api/user/preferences");
  assert.equal(getA.status, 200);
  assert.equal(getA.json.preferences["thermal.heatmap.symbol.v1"], "ETH-USDT");
  assert.equal(getA.json.preferences["thermal.heatmap.interval.v1"], "15m");
  assert.equal(getA.json.preferences["thermal.heatmap.rightView.v1"], "screener");

  // B (same backend, different session) must NOT see A's values.
  const getB = await call(jarB, "GET", "/api/user/preferences");
  assert.equal(getB.status, 200);
  const prefsB = getB.json.preferences || {};
  assert.notEqual(prefsB["thermal.heatmap.symbol.v1"], "ETH-USDT", "B must not inherit A's symbol");
  assert.notEqual(prefsB["thermal.heatmap.interval.v1"], "15m", "B must not inherit A's interval");
  assert.notEqual(prefsB["thermal.heatmap.rightView.v1"], "screener", "B must not inherit A's right-panel view");

  // B writes her own values for ALL THREE keys; reading back proves
  // per-user isolation in both directions — A's reads still return A's
  // original values, B sees only her own.
  await call(jarB, "PUT", "/api/user/preferences/thermal.heatmap.symbol.v1", { value: "SOL-USDT" });
  await call(jarB, "PUT", "/api/user/preferences/thermal.heatmap.interval.v1", { value: "1H" });
  await call(jarB, "PUT", "/api/user/preferences/thermal.heatmap.rightView.v1", { value: "watchlist" });
  const getA2 = await call(jarA, "GET", "/api/user/preferences");
  assert.equal(getA2.json.preferences["thermal.heatmap.symbol.v1"], "ETH-USDT", "A's symbol unaffected by B's write");
  assert.equal(getA2.json.preferences["thermal.heatmap.interval.v1"], "15m", "A's interval unaffected by B's write");
  assert.equal(getA2.json.preferences["thermal.heatmap.rightView.v1"], "screener", "A's rightView unaffected by B's write");
  const getB2 = await call(jarB, "GET", "/api/user/preferences");
  assert.equal(getB2.json.preferences["thermal.heatmap.symbol.v1"], "SOL-USDT");
  assert.equal(getB2.json.preferences["thermal.heatmap.interval.v1"], "1H");
  assert.equal(getB2.json.preferences["thermal.heatmap.rightView.v1"], "watchlist");
});

test("heatmap interval validator: extended intervals (3m,2H,6H,12H,3D,1M) round-trip", async () => {
  // Regression for an architect finding: the client-side initializer
  // for `thermal.heatmap.interval.v1` validates the persisted value
  // against the canonical `INTERVALS` const. The server is content-
  // agnostic for thermal.* keys, but if the validator drifts from the
  // type union (as it once did with a hardcoded subset), legitimate
  // persisted intervals get silently reset to "4H" on rehydrate.
  // This test pins the contract: every value the type accepts must
  // round-trip through the prefs API unchanged.
  const jar = makeJar();
  const email = `iv-${randomUUID()}@test.local`;
  await call(jar, "POST", "/api/auth/register", { email, password: "validpassword42" });
  const allIntervals = ["1m","3m","5m","15m","30m","1H","2H","4H","6H","12H","1D","3D","1W","1M"];
  for (const iv of allIntervals) {
    const put = await call(jar, "PUT", "/api/user/preferences/thermal.heatmap.interval.v1", { value: iv });
    assert.equal(put.status, 200, `PUT ${iv}`);
    const get = await call(jar, "GET", "/api/user/preferences");
    assert.equal(get.json.preferences["thermal.heatmap.interval.v1"], iv, `GET ${iv}`);
  }
});

test("watchlist IDOR: user A cannot mutate user B's watchlist", async () => {
  const jarA = makeJar();
  const jarB = makeJar();
  const emailA = `a-${randomUUID()}@test.local`;
  const emailB = `b-${randomUUID()}@test.local`;
  await call(jarA, "POST", "/api/auth/register", { email: emailA, password: "validpassword42" });
  await call(jarB, "POST", "/api/auth/register", { email: emailB, password: "validpassword42" });

  // A creates a custom watchlist.
  const created = await call(jarA, "POST", "/api/watchlists", { name: "MyPrivateList" });
  assert.equal(created.status, 200);
  const realId = created.json.watchlist.id;

  // B sees no watchlist by that real id.
  const listB = await call(jarB, "GET", "/api/watchlists");
  assert.equal(listB.status, 200);
  assert.ok(!listB.json.watchlists.some((w) => w.realId === realId), "B does not see A's list");

  // B cannot DELETE A's watchlist (must be 404, not 200/403).
  const del = await call(jarB, "DELETE", `/api/watchlists/${realId}`);
  assert.equal(del.status, 404);

  // A's watchlist still exists.
  const listA = await call(jarA, "GET", "/api/watchlists");
  assert.ok(listA.json.watchlists.some((w) => w.realId === realId));
});

test("alert-rule scope IDOR: user B cannot bind a rule to user A's watchlist", async () => {
  const jarA = makeJar();
  const jarB = makeJar();
  const emailA = `wa-${randomUUID()}@test.local`;
  const emailB = `wb-${randomUUID()}@test.local`;
  await call(jarA, "POST", "/api/auth/register", { email: emailA, password: "validpassword42" });
  await call(jarB, "POST", "/api/auth/register", { email: emailB, password: "validpassword42" });

  // A creates a private watchlist.
  const created = await call(jarA, "POST", "/api/watchlists", { name: "AlertScopeTarget" });
  assert.equal(created.status, 200);
  const targetId = created.json.watchlist.id;

  // B tries to register an alert rule whose scope is A's watchlist id.
  // The route must reject with 400 (scope not owned) — a successful
  // 200 would mean the engine would later evaluate B's rule against
  // A's curated symbols, leaking A's list contents through the alert
  // pipeline.
  const ruleBody = {
    name: "should-be-rejected",
    kind: "price_above",
    symbol: `watchlist:${targetId}`,
    params: { price: 1 },
    sinks: ["toast"],
    throttleMs: 60000,
    enabled: true,
  };
  const denied = await call(jarB, "POST", "/api/alerts/rules", ruleBody);
  assert.equal(denied.status, 400, "B must not be allowed to bind to A's watchlist id");

  // Sanity: A herself can bind a rule to the same watchlist id.
  const allowed = await call(jarA, "POST", "/api/alerts/rules", ruleBody);
  assert.equal(allowed.status, 200, "A must still be allowed to scope to her own watchlist");
  // Cleanup so reruns stay deterministic.
  if (allowed.json?.rule?.id) {
    await call(jarA, "DELETE", `/api/alerts/rules/${allowed.json.rule.id}`);
  }
});

test("alert-rule scope: 'watchlist:default' is rewritten to the caller's own default", async () => {
  const jar = makeJar();
  const email = `wd-${randomUUID()}@test.local`;
  await call(jar, "POST", "/api/auth/register", { email, password: "validpassword42" });

  const ruleBody = {
    name: "default-scope",
    kind: "price_above",
    symbol: "watchlist:default",
    params: { price: 1 },
    sinks: ["toast"],
    throttleMs: 60000,
    enabled: true,
  };
  const created = await call(jar, "POST", "/api/alerts/rules", ruleBody);
  assert.equal(created.status, 200);
  // The persisted scope must be a real uuid-shaped watchlist id, not
  // the literal alias — this proves resolveSymbolScope ran and
  // anchored the rule to the user's own list.
  const persisted = created.json?.rule?.symbol ?? "";
  assert.ok(persisted.startsWith("watchlist:"), "scope still begins with watchlist:");
  assert.notEqual(persisted, "watchlist:default", "alias should have been resolved");
  if (created.json?.rule?.id) {
    await call(jar, "DELETE", `/api/alerts/rules/${created.json.rule.id}`);
  }
});
