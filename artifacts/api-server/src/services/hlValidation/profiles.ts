// Validation profile defaults.
// VALIDATION-ONLY.

import type { ProfileName } from "./types";

const STANDARD_SYMBOLS = [
  "BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","TRX",
  "MATIC","DOT","LTC","NEAR","ATOM","SUI","APT","ARB","OP","TIA",
];

const FULL_SYMBOLS = [
  ...STANDARD_SYMBOLS,
  "INJ","SEI","RNDR","FET","TON","FIL","HBAR","ETC","BCH","UNI",
  "AAVE","CRV","MKR","SNX","LDO","RUNE","KAS","ENA","ORDI","WIF",
];

export interface ProfileSpec {
  symbols: string[];
  intervals: string[];
  lookbackDays: number;
  folds: number;
  // How many anti-lookahead determinism samples to take per series.
  // smoke=2 (smallest possible while still proving the property),
  // quick=4, standard/full=10.
  antiLookaheadSamples: number;
  // Watchdog: maximum wall-clock time the entire run is allowed to take.
  // If exceeded, the run terminates with phase=failed and a clear status
  // explaining which symbol/interval was in flight.
  maxRunMinutes: number;
  // Watchdog: maximum wall-clock time the data-fetch phase is allowed
  // for the WHOLE run (not per-series). Throttle stalls beyond this
  // cause graceful failure with bars-fetched-so-far surfaced in errors.
  maxFetchMinutes: number;
}

export function profileSpec(profile: ProfileName, overrides?: Partial<ProfileSpec>): ProfileSpec {
  const base = ((): ProfileSpec => {
    switch (profile) {
      case "smoke":
        return {
          symbols: ["BTC"], intervals: ["15m"], lookbackDays: 21, folds: 2,
          antiLookaheadSamples: 2, maxRunMinutes: 8, maxFetchMinutes: 5,
        };
      case "quick":
        return {
          symbols: ["BTC","ETH","SOL"], intervals: ["15m","1h"], lookbackDays: 75, folds: 3,
          antiLookaheadSamples: 4, maxRunMinutes: 25, maxFetchMinutes: 15,
        };
      case "standard":
        return {
          symbols: STANDARD_SYMBOLS, intervals: ["15m","1h","4h","1d"], lookbackDays: 180, folds: 5,
          antiLookaheadSamples: 10, maxRunMinutes: 90, maxFetchMinutes: 60,
        };
      case "full":
        return {
          symbols: FULL_SYMBOLS, intervals: ["15m","1h","4h","1d"], lookbackDays: 365, folds: 7,
          antiLookaheadSamples: 10, maxRunMinutes: 240, maxFetchMinutes: 180,
        };
    }
  })();
  return { ...base, ...(overrides ?? {}) };
}

export function isProfileName(v: unknown): v is ProfileName {
  return v === "smoke" || v === "quick" || v === "standard" || v === "full";
}
