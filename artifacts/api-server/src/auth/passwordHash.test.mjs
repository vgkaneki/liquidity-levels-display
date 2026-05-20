import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "./passwordHash.ts";

test("hashPassword + verifyPassword round-trip succeeds", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(typeof hash, "string");
  assert.ok(hash.length > 30, "bcrypt hash should be ~60 chars");
  assert.ok(hash.startsWith("$2"), "bcrypt format prefix");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
});

test("verifyPassword rejects wrong password", async () => {
  const hash = await hashPassword("rightpassword42");
  assert.equal(await verifyPassword("wrongpassword42", hash), false);
});

test("verifyPassword rejects empty + oversize input safely", async () => {
  const hash = await hashPassword("anything-here");
  assert.equal(await verifyPassword("", hash), false);
  assert.equal(await verifyPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), hash), false);
  assert.equal(await verifyPassword(/** @type {any} */ (null), hash), false);
  assert.equal(await verifyPassword("anything-here", ""), false);
});

test("hashPassword refuses oversize input", async () => {
  await assert.rejects(
    () => hashPassword("x".repeat(MAX_PASSWORD_LENGTH + 1)),
    /password too long/i,
  );
});

test("constants are sane", () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 8);
  assert.ok(MAX_PASSWORD_LENGTH <= 1024);
  assert.ok(MIN_PASSWORD_LENGTH < MAX_PASSWORD_LENGTH);
});
