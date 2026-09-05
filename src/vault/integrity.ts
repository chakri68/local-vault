import { uuidBytes } from "./bytes.ts";
import { unwrapFileKey } from "./crypto/keys.ts";
import { decodeHeader, decryptObject, expectedObjectSize } from "./crypto/stream.ts";
import type { ObjectHeader } from "./crypto/stream.ts";
import type { VaultTree } from "./opfs.ts";

/**
 * The checks that decide whether a stored object is the object it claims to be
 * (§35, §51). Shared by reads, by Verify Vault, and by restore — a backup that
 * is only checked for *filenames* is not checked at all.
 */

const HEADER_READ_BYTES = 256;

export interface OpenObject {
  file: File;
  header: ObjectHeader;
  headerLength: number;
  fileKey: CryptoKey;
}

export interface ObjectRef {
  objectId: string;
  /** Authoritative plaintext size, from the authenticated manifest. */
  size: number;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Open an object and prove it belongs where it is found.
 *
 * decodeHeader() has already rejected an internally inconsistent header. What
 * is left to check is everything the header cannot vouch for on its own:
 * identity (does it match the manifest entry and this vault), declared size
 * (the manifest is authenticated, the plaintext header is not), and total
 * length (GCM says nothing about bytes after the final chunk).
 */
export async function openObject(
  tree: VaultTree,
  master: CryptoKey,
  vaultId: string,
  item: ObjectRef,
): Promise<OpenObject> {
  const file = await tree.readObject(item.objectId);
  const head = new Uint8Array(await file.slice(0, HEADER_READ_BYTES).arrayBuffer());
  const { header, byteLength } = decodeHeader(head);

  if (!bytesEqual(header.fileId, uuidBytes(item.objectId))) {
    throw new Error("object ID mismatch");
  }
  if (!bytesEqual(header.vaultId, uuidBytes(vaultId))) {
    throw new Error("object belongs to a different vault");
  }
  if (header.plaintextSize !== item.size) {
    throw new Error("object size does not match the manifest");
  }
  const expected = expectedObjectSize(header, byteLength);
  if (file.size !== expected) {
    throw new Error(`object is ${file.size} bytes where ${expected} were expected`);
  }

  return { file, header, headerLength: byteLength, fileKey: await unwrapFileKey(master, header.key) };
}

/**
 * Authenticate every chunk and throw away the plaintext.
 *
 * Memory stays flat: chunks are decrypted and dropped, so this is safe to run
 * over an entire vault regardless of how large the files are.
 */
export async function authenticateObject(
  tree: VaultTree,
  master: CryptoKey,
  vaultId: string,
  item: ObjectRef,
  signal?: AbortSignal,
): Promise<void> {
  const { file, header, headerLength, fileKey } = await openObject(tree, master, vaultId, item);
  for await (const chunk of decryptObject(file, headerLength, header, fileKey, { signal })) {
    void chunk;
  }
}
