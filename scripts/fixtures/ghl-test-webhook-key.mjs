// TEST-ONLY Ed25519 key for signing fake GHL webhooks in local tests. The server accepts
// its public half only when NODE_ENV !== "production" (see src/ghlWebhook.js), so this
// private key grants nothing on the live site. Never use it for anything else.
import { createPrivateKey, sign } from "node:crypto";

const TEST_WEBHOOK_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDicbCH0SGCKrYEZ40m3pIr/Kpc2oz2Ht0tK/u10Wtep
-----END PRIVATE KEY-----
`;

const key = createPrivateKey(TEST_WEBHOOK_PRIVATE_KEY_PEM);

/** Base64 Ed25519 signature of the exact body string, as GHL sends in X-GHL-Signature. */
export function signTestWebhook(rawBody) {
  return sign(null, Buffer.from(rawBody, "utf8"), key).toString("base64");
}
