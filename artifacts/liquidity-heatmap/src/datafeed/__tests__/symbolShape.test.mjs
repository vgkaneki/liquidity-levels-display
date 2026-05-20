// Phase 3 — symbol shape correctness.
//
// /api/symbol/list and /api/symbol/search return registry rows shaped
// as { ui, base, quote, native, listed: { hl|okx|toobit: "yes"|"no" } }.
// The IDatafeed contract surfaces `exchanges: string[]` derived from
// that `listed` map. Architect round 3 caught that an earlier draft
// expected a flat `exchanges` array on the row and therefore returned
// `exchanges: []` for every symbol. These tests pin the derivation so
// it can't regress silently.

import { test } from "node:test";
import assert from "node:assert/strict";

function canonicalExchangeName(code) {
  if (code === "hl") return "hyperliquid";
  return code;
}
function exchangesFromListed(listed) {
  if (!listed || typeof listed !== "object") return [];
  const out = [];
  for (const [code, status] of Object.entries(listed)) {
    if (typeof status === "string" && status.toLowerCase() === "yes") {
      out.push(canonicalExchangeName(code));
    }
  }
  out.sort();
  return out;
}
function toSymbolInfo(row) {
  const quote = row.quote ?? "USDT";
  const exchanges = Array.isArray(row.exchanges) && row.exchanges.length > 0
    ? row.exchanges
    : exchangesFromListed(row.listed);
  return {
    ui: row.ui,
    base: row.base,
    quote,
    exchanges,
    description: `${row.base} / ${quote}`,
  };
}

test("symbol: BTCUSDT row from /api/symbol/search lists all three venues", () => {
  // Verbatim from `curl /api/symbol/search?q=BTC`.
  const row = {
    ui: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    native: { hl: "BTC", okx: "BTC-USDT-SWAP", toobit: "BTC-SWAP-USDT" },
    listed: { hl: "yes", okx: "yes", toobit: "yes" },
  };
  const info = toSymbolInfo(row);
  assert.equal(info.ui, "BTCUSDT");
  assert.deepEqual(info.exchanges, ["hyperliquid", "okx", "toobit"]);
  assert.equal(info.description, "BTC / USDT");
});

test("symbol: PUMPBTCUSDT only listed on toobit", () => {
  const row = {
    ui: "PUMPBTCUSDT",
    base: "PUMPBTC",
    quote: "USDT",
    native: { toobit: "PUMPBTC-SWAP-USDT" },
    listed: { hl: "no", okx: "no", toobit: "yes" },
  };
  const info = toSymbolInfo(row);
  assert.deepEqual(info.exchanges, ["toobit"]);
});

test("symbol: hl maps to hyperliquid (canonical name)", () => {
  const info = toSymbolInfo({
    ui: "ETHUSDT", base: "ETH", quote: "USDT",
    listed: { hl: "yes", okx: "no", toobit: "no" },
  });
  assert.deepEqual(info.exchanges, ["hyperliquid"]);
});

test("symbol: pre-flattened exchanges array is honored when present", () => {
  const info = toSymbolInfo({
    ui: "X", base: "X", quote: "USDT",
    exchanges: ["okx", "binance"],
    listed: { hl: "yes" }, // ignored when exchanges is non-empty
  });
  assert.deepEqual(info.exchanges, ["okx", "binance"]);
});

function backendExchangeCode(name) {
  if (name === "hyperliquid") return "hl";
  return name;
}

test("symbol: backendExchangeCode reverses the canonical name for outbound filters", () => {
  // Contract names → backend codes for /api/symbol/list?exchange=
  assert.equal(backendExchangeCode("hyperliquid"), "hl");
  assert.equal(backendExchangeCode("okx"), "okx");
  assert.equal(backendExchangeCode("toobit"), "toobit");
  // Pass-through for raw registry codes (caller already in backend space).
  assert.equal(backendExchangeCode("hl"), "hl");
});

test("symbol: missing listed AND missing exchanges yields []", () => {
  const info = toSymbolInfo({ ui: "X", base: "X" });
  assert.deepEqual(info.exchanges, []);
  assert.equal(info.quote, "USDT");
});
