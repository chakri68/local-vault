import { concat, fromUtf8, randomBytes, utf8, uuidBytes } from "./bytes.ts";
import { MANIFEST_FORMAT_VERSION, NONCE_BYTES } from "./types.ts";
import type { Manifest, ManifestSlot } from "./types.ts";
import type { VaultTree } from "./opfs.ts";

/**
 * The encrypted manifest (§10, §12).
 *
 *   0   1   manifestFormatVersion
 *   1  16   vaultId
 *  17  12   nonce
 *  29   n   AES-GCM(manifest JSON), AAD = version || vaultId
 *
 * Crash safety is the alternating-snapshot scheme from §12: write the whole next
 * snapshot into the *inactive* slot, read it back and decrypt it to prove it
 * landed, and only then flip `active`. A torn write can therefore only ever
 * damage the slot nobody is pointing at.
 */

const PREFIX = 1 + 16;

function seal(vaultIdBytes: Uint8Array): Uint8Array {
  return concat(new Uint8Array([MANIFEST_FORMAT_VERSION]), vaultIdBytes);
}

export async function encryptManifest(
  master: CryptoKey,
  manifest: Manifest,
): Promise<Uint8Array> {
  const idBytes = uuidBytes(manifest.vaultId);
  const aad = seal(idBytes);
  const iv = randomBytes(NONCE_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    master,
    utf8.encode(JSON.stringify(manifest)) as BufferSource,
  );
  return concat(aad, iv, new Uint8Array(ct));
}

export async function decryptManifest(
  master: CryptoKey,
  bytes: Uint8Array,
): Promise<Manifest> {
  if (bytes.length < PREFIX + NONCE_BYTES) throw new Error("manifest truncated");
  const version = bytes[0];
  if (version !== MANIFEST_FORMAT_VERSION) {
    throw new Error(`unsupported manifest version ${version}`);
  }
  const aad = bytes.slice(0, PREFIX);
  const iv = bytes.slice(PREFIX, PREFIX + NONCE_BYTES);
  const ct = bytes.slice(PREFIX + NONCE_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    master,
    ct as BufferSource,
  );
  return JSON.parse(fromUtf8.decode(new Uint8Array(plain))) as Manifest;
}

const other = (s: ManifestSlot): ManifestSlot => (s === "a" ? "b" : "a");

/**
 * Write-verify-flip. Returns the slot now active.
 *
 * The read-back is not paranoia theatre: it is the only thing that distinguishes
 * "the bytes are on disk and decrypt" from "createWritable resolved". §12 requires
 * the snapshot be verified before `active` moves.
 */
export async function saveManifest(
  tree: VaultTree,
  master: CryptoKey,
  manifest: Manifest,
): Promise<ManifestSlot> {
  const current = await tree.readActiveSlot();
  const target = current ? other(current) : "a";

  const bytes = await encryptManifest(master, { ...manifest, updatedAt: new Date().toISOString() });
  await tree.writeSlot(target, bytes);

  const readBack = await tree.readSlot(target);
  if (!readBack) throw new Error("manifest write vanished");
  await decryptManifest(master, readBack); // throws if the snapshot is not intact

  await tree.setActiveSlot(target);
  return target;
}

/**
 * Load the active snapshot, falling back to the other slot.
 *
 * The fallback covers the one window the flip cannot: `active` updated but its
 * target somehow unreadable. Failing closed (§50) means we surface the error
 * rather than showing a half-decrypted vault.
 */
export async function loadManifest(tree: VaultTree, master: CryptoKey): Promise<Manifest> {
  const active = await tree.readActiveSlot();
  const order: ManifestSlot[] = active ? [active, other(active)] : ["a", "b"];

  let lastError: unknown = new Error("no manifest snapshot found");
  for (const slot of order) {
    const bytes = await tree.readSlot(slot);
    if (!bytes) continue;
    try {
      return await decryptManifest(master, bytes);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
