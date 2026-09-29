/* GHL webhook authentication (X-GHL-Signature, Ed25519) and payload parsing. */
import { createHash, createPublicKey, verify } from "node:crypto";

// GHL's published Ed25519 public key (SPKI DER, base64) for X-GHL-Signature.
export const GHL_WEBHOOK_PUBLIC_KEY = "MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=";
// Public half of scripts/fixtures/ghl-test-webhook-key.mjs. Accepted only when NODE_ENV is
// "development" or "test" (see testKeyAllowed) — it fails closed when NODE_ENV is unset.
export const TEST_WEBHOOK_PUBLIC_KEY = "MCowBQYDK2VwAyEAQYyBeyYgpp08Cdxk+4wYHJIuKcsJcKGuTOE3xHhNbmg=";

const keys = new Map();
function publicKey(b64) {
  if (!keys.has(b64)) keys.set(b64, createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }));
  return keys.get(b64);
}

/** The test signing key is honoured only in an explicit development/test environment. */
export function testKeyAllowed(nodeEnv) {
  return nodeEnv === "development" || nodeEnv === "test";
}

/** True when `signature` (base64) is a valid Ed25519 signature of the exact raw body. */
export function verifyGhlSignature(rawBody, signature, { allowTestKey = false } = {}) {
  if (typeof signature !== "string" || !signature) return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  const body = Buffer.from(String(rawBody), "utf8");
  const candidates = allowTestKey ? [GHL_WEBHOOK_PUBLIC_KEY, TEST_WEBHOOK_PUBLIC_KEY] : [GHL_WEBHOOK_PUBLIC_KEY];
  return candidates.some((k) => {
    try { return verify(null, body, publicKey(k), sig); } catch { return false; }
  });
}

function kindOf(messageType) {
  const t = String(messageType ?? "");
  if (/call/i.test(t)) return "call";
  if (/comment/i.test(t)) return "comment";
  return "message";
}

/**
 * Reduce a webhook payload to the metadata we keep. Message/call content is never
 * copied out of the payload. `receivedAt` (UNIX seconds) is used when the event has no
 * usable `dateAdded`.
 */
export function parseWebhook(payload, receivedAt) {
  const type = payload?.type;
  const locationId = payload?.locationId ?? null;
  const webhookId = payload?.webhookId ?? null;
  if (type === "INSTALL" || type === "UNINSTALL") {
    return {
      event: type === "INSTALL" ? "install" : "uninstall",
      locationId, companyId: payload?.companyId ?? null, webhookId, appId: payload?.appId ?? null,
    };
  }
  if (type === "OutboundMessage") {
    const at = Date.parse(payload?.dateAdded ?? "");
    return {
      event: "activity",
      locationId,
      webhookId,
      messageId: payload?.messageId ?? null,
      userId: payload?.userId ?? null,
      kind: kindOf(payload?.messageType),
      messageType: payload?.messageType ?? null,
      source: payload?.source ?? null,
      occurredAt: Number.isFinite(at) ? Math.floor(at / 1000) : receivedAt,
    };
  }
  return { event: "ignored", locationId, webhookId };
}

/**
 * GHL signs every Marketplace app's webhooks with the same key, so a valid signature proves
 * the event came from GHL, not that it is meant for our app. When `expectedAppId`
 * (GHL_APP_ID) is set, an install/uninstall must carry that same `appId`; unset = no check.
 */
export function isForOurApp(ev, expectedAppId) {
  if (!expectedAppId) return true;
  return ev?.appId === expectedAppId;
}

/**
 * Idempotency key for an activity row (<= 100 chars, the column width). The message id is
 * preferred: the same message redelivered via another app arrives with a different
 * webhookId but the same messageId. Falls back to webhookId, then to a hash of the raw body.
 */
export function activityDedupeKey(ev, rawBody) {
  if (ev?.messageId) return `m:${ev.messageId}`.slice(0, 100);
  if (ev?.webhookId) return String(ev.webhookId).slice(0, 100);
  return createHash("sha256").update(String(rawBody)).digest("hex");
}
