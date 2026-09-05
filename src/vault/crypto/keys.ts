import { b64, unb64, randomBytes, zero } from "../bytes.ts";
import { NONCE_BYTES } from "../types.ts";
import type { Wrapped } from "../types.ts";

/**
 * Master key handling (§9.1, §9.3, §9.4).
 *
 * The live master key is a **non-extractable** CryptoKey. Passphrase change does
 * not need it: the wrapper is plain AES-GCM over the raw 32 bytes, so re-wrapping
 * means decrypt-with-old-KEK / encrypt-with-new-KEK, and the raw bytes exist only
 * for the few microseconds in between. See rewrapMasterKey().
 */

const MASTER_USAGES: KeyUsage[] = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];

export function generateMasterKeyBytes(): Uint8Array {
  return randomBytes(32);
}

export async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, MASTER_USAGES);
}

/** AES-GCM encrypt arbitrary bytes under a KEK. Fresh random nonce each call. */
export async function sealBytes(kek: CryptoKey, plain: Uint8Array): Promise<Wrapped> {
  const iv = randomBytes(NONCE_BYTES);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, kek, plain as BufferSource);
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Throws on a wrong key or tampered ciphertext — this is the passphrase check. */
export async function openBytes(kek: CryptoKey, w: Wrapped): Promise<Uint8Array> {
  const iv = unb64(w.iv);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    kek,
    unb64(w.ct) as BufferSource,
  );
  return new Uint8Array(plain);
}

/**
 * Re-wrap the master key under a new KEK without ever holding it as an
 * extractable CryptoKey, and without touching a single stored object (§9.3).
 */
export async function rewrapMasterKey(
  oldKek: CryptoKey,
  newKek: CryptoKey,
  current: Wrapped,
): Promise<Wrapped> {
  const raw = await openBytes(oldKek, current);
  try {
    return await sealBytes(newKek, raw);
  } finally {
    zero(raw);
  }
}

/**
 * A fresh per-file key (§9.4). Extractable only so that wrapKey can read it;
 * the copy that comes back out of unwrapFileKey is not.
 */
export async function generateFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export interface WrappedFileKey {
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function wrapFileKey(
  master: CryptoKey,
  fileKey: CryptoKey,
): Promise<WrappedFileKey> {
  const iv = randomBytes(NONCE_BYTES);
  const ct = await crypto.subtle.wrapKey("raw", fileKey, master, {
    name: "AES-GCM",
    iv: iv as BufferSource,
  });
  return { iv, ct: new Uint8Array(ct) };
}

export async function unwrapFileKey(
  master: CryptoKey,
  w: WrappedFileKey,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    w.ct as BufferSource,
    master,
    { name: "AES-GCM", iv: w.iv as BufferSource },
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
