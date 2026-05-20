import type { DataType, ExchangeId } from "./types";

// Routing chains advertised by the SymbolRegistry. Two important caveats
// before adding/reordering:
//
// 1. CONTRACT — what these chains actually drive at runtime:
//    * `book`         : ACTIVE. `getRealOrderbook` in routes/liquidity/index.ts
//                       calls `symbolRegistry.fallbackChain(sym, "book")` and
//                       walks the chain in order. This is the only chain
//                       whose order changes runtime fetch behavior today.
//    * `candles`      : ADVISORY. `services/candleSource.ts` is hard-coded
//                       to try Hyperliquid → Toobit (gated). It does not
//                       consult this chain. Listing OKX here would be
//                       dishonest because OKX candles are never fetched.
//    * `ticker`       : ADVISORY. `getRealTicker` (REST) and
//                       `buildHeatmapPayload` (WS) are hard-coded to try
//                       Hyperliquid → Toobit → OKX. The chain order should
//                       reflect that real ladder.
//    * `funding`/`oi` : ADVISORY. Bundled with the HL ticker fetch (HL),
//                       only fetched standalone in the OKX ticker tier.
//                       Toobit publishes neither.
//    * `liquidations` : ADVISORY. The liquidations aggregator pulls from
//                       4 venues (HL, OKX, Bybit, Binance) via separate
//                       *-liq-ws modules; this chain only models the two
//                       venues representable here.
//    * `trades`       : ADVISORY. Both OKX and HL trade streams feed the
//                       trades-store additively; chain order is informational.
//
// 2. EXPOSURE — these chains are also exposed verbatim via `/api/symbol`
//    (`preferredFor` / `fallbackChains` fields). Anything we list here is
//    something a consumer can reasonably believe will be tried in this
//    order. Keep them honest.
//
// If you want to change ACTUAL routing behavior for `candles` / `ticker`
// / etc., you must also edit the corresponding hard-coded ladder in
// `services/candleSource.ts`, `routes/liquidity/index.ts::getRealTicker`,
// or `services/wsHub/index.ts::buildHeatmapPayload`. Reordering this
// table alone will not move data.
const DEFAULT_ROUTING: Record<DataType, ExchangeId[]> = {
  // Real candle ladder is HL → Toobit (Toobit gated by ENABLE_TOOBIT).
  // OKX is reachable from this server but no OKX candle adapter is
  // wired into candleSource.ts, so omitting it from the chain matches
  // observable behavior.
  candles: ["hl", "toobit"],
  // Real book ladder; consulted by getRealOrderbook.
  book: ["okx", "hl", "toobit"],
  // Real ticker ladder used by getRealTicker and buildHeatmapPayload.
  ticker: ["hl", "toobit", "okx"],
  // Bundled with HL ticker first; OKX standalone in the OKX ticker tier.
  funding: ["hl", "okx"],
  oi: ["hl", "okx"],
  liquidations: ["hl", "okx"],
  trades: ["okx", "hl"],
};

const ENV_KEY: Record<DataType, string> = {
  candles: "CANDLES_ROUTING",
  book: "BOOK_ROUTING",
  ticker: "TICKER_ROUTING",
  funding: "FUNDING_ROUTING",
  oi: "OI_ROUTING",
  liquidations: "LIQUIDATIONS_ROUTING",
  trades: "TRADES_ROUTING",
};

const VALID_EX = new Set<ExchangeId>(["hl", "okx", "toobit"]);

function parseEnv(raw: string | undefined): ExchangeId[] | null {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0) as ExchangeId[];
  const filtered = parts.filter((p) => VALID_EX.has(p));
  return filtered.length > 0 ? filtered : null;
}

export function getRoutingChain(dt: DataType): ExchangeId[] {
  return parseEnv(process.env[ENV_KEY[dt]]) ?? DEFAULT_ROUTING[dt];
}
