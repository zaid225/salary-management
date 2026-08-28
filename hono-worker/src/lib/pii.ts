import type { CloudflareBindings } from "./context.js";
import { logger } from "./logger.js";

// Rule #5 (Zero-Trust Data & PII Tokenization): raw PII must never reach an
// external LLM call. This module is the one place that encrypts a PII value
// for storage and hands the caller back an opaque token to use everywhere
// else - including in every payload that gets TOON-encoded and sent to
// OpenRouter.

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Returns ciphertext safe to store, or null if PII_ENCRYPTION_KEY isn't
// configured - callers must still tokenize (never send the raw value
// downstream) even when this returns null; only the *reversible* mapping is
// unavailable until a key is set (env-vars.md rule 4's degrade-cleanly
// contract, applied to a crypto dependency rather than an external API).
export async function encryptPii(env: CloudflareBindings, plaintext: string): Promise<string | null> {
  if (!env.PII_ENCRYPTION_KEY) return null;
  try {
    const key = await importKey(env.PII_ENCRYPTION_KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    // iv is not secret - it must travel with the ciphertext to decrypt it.
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch (err) {
    logger.error({ err: String(err) }, "pii encryption failed");
    return null;
  }
}

export async function decryptPii(env: CloudflareBindings, ciphertextB64: string): Promise<string | null> {
  if (!env.PII_ENCRYPTION_KEY) return null;
  try {
    const key = await importKey(env.PII_ENCRYPTION_KEY);
    const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (err) {
    logger.error({ err: String(err) }, "pii decryption failed");
    return null;
  }
}
