/* AES-256-GCM for OAuth tokens at rest. Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyFrom(hex) {
  if (!/^[0-9a-f]{64}$/i.test(String(hex ?? ""))) throw new Error("TOKEN_ENC_KEY must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

export function encryptToken(plain, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyHex), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptToken(enc, keyHex) {
  const key = keyFrom(keyHex);
  const [version, iv, tag, ct] = String(enc).split(":");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised token format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
