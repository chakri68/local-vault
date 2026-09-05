import { argon2id } from "hash-wasm";
import { zero } from "../bytes.ts";
import type { KdfParams } from "../types.ts";

/**
 * Argon2id via hash-wasm.
 *
 * The WASM is embedded in the JS bundle as base64, so there is no `.wasm` fetch.
 * That is what lets `connect-src` stay at 'none' (§43) — do not swap this library
 * for one that fetches its binary without also opening that directive.
 */

/**
 * OWASP's baseline second profile: 64 MiB, t=3, p=1. Roughly 0.5–1s on a
 * mid-range phone, which is the §9.2 target. Stored per-vault in the header, so
 * raising it later only affects new vaults and re-wraps (§9.2).
 */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  memorySize: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

export const KDF_SALT_BYTES = 16;

/** Derive the Key Encryption Key. Non-extractable: it only ever wraps. */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  const raw = (await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: 32,
    outputType: "binary",
  })) as Uint8Array;

  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    zero(raw);
  }
}
