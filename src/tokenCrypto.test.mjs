import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken } from "./tokenCrypto.js";

const KEY = "0f".repeat(32);

test("encrypt/decrypt round-trips a token", () => {
  const enc = encryptToken("ya29.secret-token", KEY);
  assert.match(enc, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decryptToken(enc, KEY), "ya29.secret-token");
});

test("the same token encrypts differently each time (random IV)", () => {
  assert.notEqual(encryptToken("same", KEY), encryptToken("same", KEY));
});

test("a tampered ciphertext is rejected", () => {
  const [v, iv, tag, ct] = encryptToken("token", KEY).split(":");
  const flipped = Buffer.from(ct, "base64"); flipped[0] ^= 1;
  assert.throws(() => decryptToken([v, iv, tag, flipped.toString("base64")].join(":"), KEY));
});

test("a key that is not 64 hex characters is refused", () => {
  assert.throws(() => encryptToken("token", "short"));
  assert.throws(() => decryptToken(encryptToken("token", KEY), "zz".repeat(32)));
});
