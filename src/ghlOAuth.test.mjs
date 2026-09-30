import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeCode, GHL_TOKEN_URL } from "./ghlOAuth.js";

const args = { code: "abc", clientId: "cid", clientSecret: "secret", redirectUri: "https://timeclock.noursky.com/oauth/callback" };
const fakeFetch = (status, json, seen) => async (url, init) => {
  seen?.push({ url, init });
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

test("posts the authorization code as a form to GHL's token endpoint", async () => {
  const seen = [];
  await exchangeCode({ ...args, fetchImpl: fakeFetch(200, { access_token: "a", refresh_token: "r", expires_in: 86399, scope: "x", locationId: "loc1", companyId: "c1" }, seen) });
  assert.equal(seen[0].url, GHL_TOKEN_URL);
  assert.equal(seen[0].init.method, "POST");
  const form = new URLSearchParams(String(seen[0].init.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "abc");
  assert.equal(form.get("client_id"), "cid");
  assert.equal(form.get("client_secret"), "secret");
  assert.equal(form.get("redirect_uri"), args.redirectUri);
  assert.equal(form.get("user_type"), "Location");
});

test("maps a successful response", async () => {
  const out = await exchangeCode({ ...args, fetchImpl: fakeFetch(200, {
    access_token: "acc", refresh_token: "ref", expires_in: 86399,
    scope: "conversations/message.readonly", locationId: "loc1", companyId: "c1",
  }) });
  assert.deepEqual(out, {
    accessToken: "acc", refreshToken: "ref", expiresIn: 86399,
    scopes: "conversations/message.readonly", locationId: "loc1", companyId: "c1",
  });
});

test("a refused code throws OAUTH_EXCHANGE_FAILED", async () => {
  await assert.rejects(exchangeCode({ ...args, fetchImpl: fakeFetch(400, { error: "invalid_grant" }) }), /OAUTH_EXCHANGE_FAILED/);
});

test("a token without a location throws (agency-level installs are not supported)", async () => {
  await assert.rejects(exchangeCode({ ...args, fetchImpl: fakeFetch(200, { access_token: "a", companyId: "c1" }) }), /OAUTH_EXCHANGE_FAILED/);
});

test("a network failure throws OAUTH_UNREACHABLE, not a refusal", async () => {
  const boom = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(exchangeCode({ ...args, fetchImpl: boom }), /OAUTH_UNREACHABLE/);
});

test("a timeout (TimeoutError/AbortError) throws OAUTH_UNREACHABLE", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const slow = async () => { throw new DOMException("The operation timed out", name); };
    await assert.rejects(exchangeCode({ ...args, fetchImpl: slow }), /OAUTH_UNREACHABLE/);
  }
});

test("the request carries an abort signal so a hung GHL cannot hang the install page", async () => {
  const seen = [];
  await exchangeCode({ ...args, fetchImpl: fakeFetch(200, { access_token: "a", locationId: "loc1" }, seen) });
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});
