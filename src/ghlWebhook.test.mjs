import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGhlSignature, parseWebhook, testKeyAllowed, isForOurApp, activityDedupeKey } from "./ghlWebhook.js";
import { signTestWebhook } from "../scripts/fixtures/ghl-test-webhook-key.mjs";

const body = JSON.stringify({ type: "OutboundMessage", locationId: "loc1", webhookId: "w1" });

test("a body signed with the test key verifies when the test key is allowed", () => {
  assert.equal(verifyGhlSignature(body, signTestWebhook(body), { allowTestKey: true }), true);
});

test("the test key is refused when not allowed (production)", () => {
  assert.equal(verifyGhlSignature(body, signTestWebhook(body), { allowTestKey: false }), false);
});

test("a changed body fails verification", () => {
  const sig = signTestWebhook(body);
  assert.equal(verifyGhlSignature(body.replace("loc1", "loc2"), sig, { allowTestKey: true }), false);
});

test("a missing or garbage signature fails verification", () => {
  assert.equal(verifyGhlSignature(body, undefined, { allowTestKey: true }), false);
  assert.equal(verifyGhlSignature(body, "", { allowTestKey: true }), false);
  assert.equal(verifyGhlSignature(body, "not-a-signature", { allowTestKey: true }), false);
});

test("GHL's real key rejects a signature it did not make", () => {
  assert.equal(verifyGhlSignature(body, Buffer.alloc(64, 7).toString("base64")), false);
});

test("an outbound message becomes activity with its own timestamp", () => {
  const ev = parseWebhook({
    type: "OutboundMessage", locationId: "loc1", webhookId: "w1", userId: "u1",
    messageType: "SMS", source: "app", dateAdded: "2026-09-29T08:15:30.000Z", body: "hello", messageId: "m1",
  }, 999);
  assert.deepEqual(ev, {
    event: "activity", locationId: "loc1", webhookId: "w1", messageId: "m1", userId: "u1",
    kind: "message", messageType: "SMS", source: "app", occurredAt: Date.UTC(2026, 8, 29, 8, 15, 30) / 1000,
  });
  assert.equal("body" in ev, false, "message content must never be carried forward");
});

test("calls and internal comments get their own kind", () => {
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "CALL" }, 1).kind, "call");
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "TYPE_CALL" }, 1).kind, "call");
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "InternalComment" }, 1).kind, "comment");
});

test("a missing or bad date falls back to the arrival time; a missing user stays null", () => {
  const ev = parseWebhook({ type: "OutboundMessage", locationId: "loc1", dateAdded: "nope" }, 1234);
  assert.equal(ev.occurredAt, 1234);
  assert.equal(ev.userId, null);
  assert.equal(ev.webhookId, null);
  assert.equal(ev.messageId, null);
});

test("install and uninstall events are recognised", () => {
  assert.deepEqual(parseWebhook({ type: "INSTALL", locationId: "loc1", companyId: "c1", webhookId: "w9" }, 1),
    { event: "install", locationId: "loc1", companyId: "c1", webhookId: "w9", appId: null });
  assert.equal(parseWebhook({ type: "INSTALL", locationId: "loc1", appId: "app1" }, 1).appId, "app1");
  assert.equal(parseWebhook({ type: "UNINSTALL", locationId: "loc1", appId: "app1" }, 1).appId, "app1");
  assert.equal(parseWebhook({ type: "UNINSTALL", locationId: "loc1" }, 1).event, "uninstall");
});

test("any other event type is ignored", () => {
  assert.deepEqual(parseWebhook({ type: "ContactCreate", locationId: "loc1", webhookId: "w2" }, 1),
    { event: "ignored", locationId: "loc1", webhookId: "w2" });
});

test("the test key is accepted only for an explicit development or test NODE_ENV", () => {
  assert.equal(testKeyAllowed("development"), true);
  assert.equal(testKeyAllowed("test"), true);
  assert.equal(testKeyAllowed("production"), false);
  assert.equal(testKeyAllowed(undefined), false);
  assert.equal(testKeyAllowed(""), false);
  assert.equal(testKeyAllowed("staging"), false);
});

test("with GHL_APP_ID set, an install/uninstall for another app (or with no appId) is not ours", () => {
  const mine = parseWebhook({ type: "INSTALL", locationId: "loc1", appId: "app1" }, 1);
  const foreign = parseWebhook({ type: "UNINSTALL", locationId: "loc1", appId: "other" }, 1);
  const missing = parseWebhook({ type: "INSTALL", locationId: "loc1" }, 1);
  assert.equal(isForOurApp(mine, "app1"), true);
  assert.equal(isForOurApp(foreign, "app1"), false);
  assert.equal(isForOurApp(missing, "app1"), false);
});

test("with GHL_APP_ID unset the app check is off", () => {
  assert.equal(isForOurApp(parseWebhook({ type: "INSTALL", locationId: "loc1", appId: "other" }, 1), undefined), true);
  assert.equal(isForOurApp(parseWebhook({ type: "INSTALL", locationId: "loc1" }, 1), ""), true);
});

test("the activity dedupe key prefers the message id, then the webhook id, then a hash of the body", () => {
  assert.equal(activityDedupeKey({ messageId: "m1", webhookId: "w1" }, "raw"), "m:m1");
  assert.equal(activityDedupeKey({ messageId: null, webhookId: "w1" }, "raw"), "w1");
  const h = activityDedupeKey({ messageId: null, webhookId: null }, "raw");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, activityDedupeKey({}, "raw"));
  assert.notEqual(h, activityDedupeKey({}, "other"));
  assert.equal(activityDedupeKey({ messageId: "x".repeat(300) }, "raw").length, 100);
});
