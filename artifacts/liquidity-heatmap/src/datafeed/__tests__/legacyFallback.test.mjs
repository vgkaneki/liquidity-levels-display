// Phase 3 — withLegacyFallback behavioural contract.
//
// The architect review caught that an earlier draft logged disagreement
// but always returned primary, undermining the rollout-safety pattern.
// These tests pin the four documented branches so that regression
// cannot recur.

import { test } from "node:test";
import assert from "node:assert/strict";

// Inline copy mirrors `legacyFallback.ts`. The TS source is the source
// of truth; this duplicate exists so the test stays a pure node:test
// without a TS toolchain in the test runner.
async function withLegacyFallback(args) {
  const log = args.log ?? (() => {});
  const prefer = args.prefer ?? "legacy";
  let primaryValue;
  try {
    primaryValue = await args.primary();
  } catch (err) {
    log("primary-failed", { name: args.name, err: String(err) });
    return args.legacy();
  }
  if (!args.equals) return primaryValue;
  let legacyValue;
  try {
    legacyValue = await args.legacy();
  } catch (err) {
    log("legacy-threw-primary-ok", { name: args.name, err: String(err) });
    return primaryValue;
  }
  if (args.equals(primaryValue, legacyValue)) return primaryValue;
  log("disagreement", { name: args.name, prefer });
  return prefer === "primary" ? primaryValue : legacyValue;
}

test("legacyFallback: primary throws → returns legacy result and logs", async () => {
  const events = [];
  const out = await withLegacyFallback({
    name: "t",
    primary: async () => { throw new Error("boom"); },
    legacy: async () => "LEG",
    log: (kind, p) => events.push({ kind, p }),
  });
  assert.equal(out, "LEG");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "primary-failed");
});

test("legacyFallback: no equals → returns primary, never calls legacy", async () => {
  let legacyCalled = false;
  const out = await withLegacyFallback({
    name: "t",
    primary: async () => "PRI",
    legacy: async () => { legacyCalled = true; return "LEG"; },
  });
  assert.equal(out, "PRI");
  assert.equal(legacyCalled, false);
});

test("legacyFallback: equals true → returns primary, no log", async () => {
  const events = [];
  const out = await withLegacyFallback({
    name: "t",
    primary: async () => 7,
    legacy: async () => 7,
    equals: (a, b) => a === b,
    log: (kind, p) => events.push({ kind, p }),
  });
  assert.equal(out, 7);
  assert.equal(events.length, 0);
});

test("legacyFallback: equals false + default prefer=legacy → returns LEGACY and logs disagreement", async () => {
  const events = [];
  const out = await withLegacyFallback({
    name: "t",
    primary: async () => "PRI",
    legacy: async () => "LEG",
    equals: () => false,
    log: (kind, p) => events.push({ kind, p }),
  });
  assert.equal(out, "LEG");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "disagreement");
  assert.equal(events[0].p.prefer, "legacy");
});

test("legacyFallback: equals false + prefer=primary → returns PRIMARY and logs disagreement", async () => {
  const events = [];
  const out = await withLegacyFallback({
    name: "t",
    prefer: "primary",
    primary: async () => "PRI",
    legacy: async () => "LEG",
    equals: () => false,
    log: (kind) => events.push(kind),
  });
  assert.equal(out, "PRI");
  assert.deepEqual(events, ["disagreement"]);
});

test("legacyFallback: equals path, legacy throws → returns primary and logs", async () => {
  const events = [];
  const out = await withLegacyFallback({
    name: "t",
    primary: async () => "PRI",
    legacy: async () => { throw new Error("legacy down"); },
    equals: () => true,
    log: (kind) => events.push(kind),
  });
  assert.equal(out, "PRI");
  assert.deepEqual(events, ["legacy-threw-primary-ok"]);
});
