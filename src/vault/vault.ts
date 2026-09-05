import { b64, randomBytes, uuidBytes, zero } from "./bytes.ts";
import { DEFAULT_KDF_PARAMS, KDF_SALT_BYTES, deriveKek } from "./crypto/argon2.ts";
import {
  generateFileKey,
  generateMasterKeyBytes,
  importMasterKey,
  openBytes,
  rewrapMasterKey,
  sealBytes,
  unwrapFileKey,
  wrapFileKey,
} from "./crypto/keys.ts";
import {
  chunkCount,
  decodeHeader,
  decryptObject,
  encryptObject,
  hashBlob,
} from "./crypto/stream.ts";
import type { ObjectHeader } from "./crypto/stream.ts";
import { exportBackup } from "./backup.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import * as opfs from "./opfs.ts";
import {
  CHUNK_SIZE,
  DEFAULT_COLLECTIONS,
  DEFAULT_SETTINGS,
  MANIFEST_FORMAT_VERSION,
  OBJECT_FORMAT_VERSION,
  VAULT_FORMAT_VERSION,
} from "./types.ts";
import type { Collection, Manifest, VaultHeader, VaultItem, VaultSettings } from "./types.ts";

export type VaultState =
  | "UNINITIALIZED"
  | "LOCKED"
  | "UNLOCKING"
  | "UNLOCKED"
  | "LOCKING"
  | "ERROR";

export interface ImportMeta {
  displayName: string;
  originalName?: string;
  collectionId?: string;
  tags: string[];
  notes?: string;
  documentDate?: string;
  expiresAt?: string;
}

export interface Progress {
  phase: "hashing" | "encrypting" | "decrypting" | "verifying";
  done: number;
  total: number;
}

type ProgressFn = (p: Progress) => void;

/** Header size cap — big enough for the fixed 72 bytes plus a wrapped key. */
const HEADER_READ_BYTES = 256;

export class Vault {
  state: VaultState = "UNINITIALIZED";

  /**
   * Non-extractable. Lives only here, only in the worker, only while unlocked.
   * Dropping the reference on lock is all we can do — JS offers no zeroing
   * guarantee for key material held by the platform (§17).
   */
  private master: CryptoKey | null = null;
  private header: VaultHeader | null = null;
  private manifest: Manifest | null = null;

  async probe(): Promise<VaultState> {
    if (this.state === "UNLOCKED") return this.state;
    this.state = (await opfs.vaultExists()) ? "LOCKED" : "UNINITIALIZED";
    return this.state;
  }

  isUnlocked(): boolean {
    return this.state === "UNLOCKED" && this.master !== null;
  }

  private require(): { master: CryptoKey; manifest: Manifest; header: VaultHeader } {
    if (!this.master || !this.manifest || !this.header) {
      throw new Error("vault is locked");
    }
    return { master: this.master, manifest: this.manifest, header: this.header };
  }

  /* ---------------- lifecycle ---------------- */

  /** §8.1. Creates the header, an empty manifest, and opens the vault. */
  async create(passphrase: string): Promise<void> {
    if (await opfs.vaultExists()) throw new Error("a vault already exists on this device");

    const vaultId = crypto.randomUUID();
    const salt = randomBytes(KDF_SALT_BYTES);
    const kek = await deriveKek(passphrase, salt, DEFAULT_KDF_PARAMS);

    const raw = generateMasterKeyBytes();
    let wrapped;
    try {
      wrapped = await sealBytes(kek, raw);
      this.master = await importMasterKey(raw);
    } finally {
      zero(raw);
    }

    const header: VaultHeader = {
      formatVersion: VAULT_FORMAT_VERSION,
      migrationVersion: VAULT_FORMAT_VERSION,
      vaultId,
      createdAt: new Date().toISOString(),
      kdf: "argon2id",
      kdfSalt: b64(salt),
      kdfParams: DEFAULT_KDF_PARAMS,
      passphrase: wrapped,
    };

    const manifest: Manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      vaultId,
      updatedAt: new Date().toISOString(),
      items: [],
      collections: DEFAULT_COLLECTIONS.map((name) => ({ id: crypto.randomUUID(), name })),
      settings: { ...DEFAULT_SETTINGS },
      changesSinceBackup: 0,
    };

    await opfs.writeHeaderRaw(JSON.stringify(header, null, 2));
    await saveManifest(this.master, manifest);

    this.header = header;
    this.manifest = manifest;
    this.state = "UNLOCKED";
  }

  /**
   * §50: fails closed. A wrong passphrase throws out of the AES-GCM tag check
   * before anything is decrypted, so no metadata is ever partially revealed.
   */
  async unlock(passphrase: string): Promise<void> {
    this.state = "UNLOCKING";
    try {
      const raw = await opfs.readHeaderRaw();
      if (!raw) throw new Error("no vault on this device");
      const header = JSON.parse(raw) as VaultHeader;
      if (header.formatVersion > VAULT_FORMAT_VERSION) {
        throw new Error("this vault was created by a newer version of Local Vault");
      }

      const kek = await deriveKek(passphrase, unb64Safe(header.kdfSalt), header.kdfParams);
      const masterRaw = await openBytes(kek, header.passphrase);
      try {
        this.master = await importMasterKey(masterRaw);
      } finally {
        zero(masterRaw);
      }

      this.manifest = await loadManifest(this.master);
      if (this.manifest.vaultId !== header.vaultId) {
        throw new Error("manifest does not belong to this vault");
      }
      this.header = header;
      this.state = "UNLOCKED";
      await opfs.sweepTemp();
    } catch (e) {
      this.lock();
      this.state = "LOCKED";
      throw e;
    }
  }

  lock(): void {
    this.state = "LOCKING";
    this.master = null;
    this.manifest = null;
    this.state = this.header ? "LOCKED" : "UNINITIALIZED";
    void opfs.sweepTemp();
  }

  /** §9.3: re-derive, re-wrap. No stored object is touched. */
  async changePassphrase(current: string, next: string): Promise<void> {
    const { header } = this.require();
    const oldKek = await deriveKek(current, unb64Safe(header.kdfSalt), header.kdfParams);
    await openBytes(oldKek, header.passphrase); // proves `current` is right before we move

    const salt = randomBytes(KDF_SALT_BYTES);
    const newKek = await deriveKek(next, salt, DEFAULT_KDF_PARAMS);
    const rewrapped = await rewrapMasterKey(oldKek, newKek, header.passphrase);

    const updated: VaultHeader = {
      ...header,
      kdfSalt: b64(salt),
      kdfParams: DEFAULT_KDF_PARAMS,
      passphrase: rewrapped,
    };
    await opfs.writeHeaderRaw(JSON.stringify(updated, null, 2));
    this.header = updated;
  }

  /* ---------------- reading ---------------- */

  snapshot(): { items: VaultItem[]; collections: Collection[]; settings: VaultSettings; lastBackupAt?: string; changesSinceBackup: number } {
    const { manifest } = this.require();
    return {
      items: manifest.items,
      collections: manifest.collections,
      settings: manifest.settings,
      lastBackupAt: manifest.lastBackupAt,
      changesSinceBackup: manifest.changesSinceBackup,
    };
  }

  private async openObject(item: VaultItem): Promise<{
    file: File;
    header: ObjectHeader;
    headerLength: number;
    fileKey: CryptoKey;
  }> {
    const { master, header: vaultHeader } = this.require();
    const file = await opfs.readObject(item.objectId);
    const head = new Uint8Array(await file.slice(0, HEADER_READ_BYTES).arrayBuffer());
    const { header, byteLength } = decodeHeader(head);

    // §51: the object must be the one the manifest points at. Both IDs are also
    // in every chunk's AAD, so a swapped file fails to decrypt anyway — this just
    // produces a comprehensible error instead of a tag failure.
    if (bytesEqual(header.fileId, uuidBytes(item.objectId)) === false) {
      throw new Error("object ID mismatch");
    }
    if (bytesEqual(header.vaultId, uuidBytes(vaultHeader.vaultId)) === false) {
      throw new Error("object belongs to a different vault");
    }

    return { file, header, headerLength: byteLength, fileKey: await unwrapFileKey(master, header.key) };
  }

  /**
   * Decrypt an item back to a Blob.
   *
   * Chunks are converted to Blobs as they arrive so the bytes move into
   * browser-managed blob storage instead of accumulating on the JS heap.
   */
  async readItem(id: string, onProgress?: ProgressFn, signal?: AbortSignal): Promise<Blob> {
    const item = this.item(id);
    const { file, header, headerLength, fileKey } = await this.openObject(item);

    const parts: Blob[] = [];
    let done = 0;
    for await (const chunk of decryptObject(file, headerLength, header, fileKey, { signal })) {
      parts.push(new Blob([chunk as BufferSource]));
      done += chunk.length;
      onProgress?.({ phase: "decrypting", done, total: header.plaintextSize });
    }
    return new Blob(parts, { type: item.mimeType || "application/octet-stream" });
  }

  item(id: string): VaultItem {
    const { manifest } = this.require();
    const item = manifest.items.find((i) => i.id === id);
    if (!item) throw new Error("item not found");
    return item;
  }

  /* ---------------- writing ---------------- */

  /** §36: hash first so a duplicate can be reported before anything is written. */
  async hashCandidate(file: Blob, onProgress?: ProgressFn, signal?: AbortSignal): Promise<{
    sha256: string;
    duplicateOf?: VaultItem;
  }> {
    const { manifest } = this.require();
    const sha256 = await hashBlob(file, {
      signal,
      onProgress: (done, total) => onProgress?.({ phase: "hashing", done, total }),
    });
    return { sha256, duplicateOf: manifest.items.find((i) => i.sha256 === sha256) };
  }

  async importFile(
    file: File | Blob,
    meta: ImportMeta,
    opts: { sha256?: string; onProgress?: ProgressFn; signal?: AbortSignal } = {},
  ): Promise<VaultItem> {
    const { master, manifest, header: vaultHeader } = this.require();

    const objectId = crypto.randomUUID();
    const fileKey = await generateFileKey();
    const wrapped = await wrapFileKey(master, fileKey);

    const objectHeader: ObjectHeader = {
      version: OBJECT_FORMAT_VERSION,
      vaultId: uuidBytes(vaultHeader.vaultId),
      fileId: uuidBytes(objectId),
      chunkSize: CHUNK_SIZE,
      plaintextSize: file.size,
      totalChunks: chunkCount(file.size),
      key: wrapped,
    };

    const writer = await opfs.openObjectWriter(objectId);
    let sha256: string;
    try {
      const result = await encryptObject(
        file,
        fileKey,
        objectHeader,
        { write: (chunk) => writer.write(chunk as BufferSource) },
        {
          signal: opts.signal,
          onProgress: (done, total) => opts.onProgress?.({ phase: "encrypting", done, total }),
        },
      );
      sha256 = result.sha256;
      await writer.close();
    } catch (e) {
      // The swap file is discarded, so nothing partial is left at the path.
      await writer.abort().catch(() => {});
      await opfs.deleteObject(objectId);
      throw e;
    }

    const now = new Date().toISOString();
    const item: VaultItem = {
      id: crypto.randomUUID(),
      displayName: meta.displayName,
      originalName: meta.originalName,
      mimeType: (file as File).type || "application/octet-stream",
      size: file.size,
      createdAt: (file as File).lastModified ? new Date((file as File).lastModified).toISOString() : now,
      importedAt: now,
      modifiedAt: now,
      tags: meta.tags,
      collectionId: meta.collectionId,
      notes: meta.notes,
      documentDate: meta.documentDate,
      expiresAt: meta.expiresAt,
      objectId,
      sha256: opts.sha256 ?? sha256,
      favorite: false,
      archived: false,
    };

    manifest.items.push(item);
    manifest.changesSinceBackup++;
    try {
      await saveManifest(master, manifest);
    } catch (e) {
      // Never leave an object the manifest does not know about.
      manifest.items.pop();
      manifest.changesSinceBackup--;
      await opfs.deleteObject(objectId);
      throw e;
    }
    return item;
  }

  async updateItem(id: string, patch: Partial<VaultItem>): Promise<VaultItem> {
    const { master, manifest } = this.require();
    const item = this.item(id);
    const before = { ...item };
    Object.assign(item, patch, {
      id: item.id,
      objectId: item.objectId,
      modifiedAt: new Date().toISOString(),
    });
    manifest.changesSinceBackup++;
    try {
      await saveManifest(master, manifest);
    } catch (e) {
      Object.assign(item, before);
      manifest.changesSinceBackup--;
      throw e;
    }
    return item;
  }

  /** §39: explicit intent only, and the object goes with the metadata. */
  async deleteItem(id: string): Promise<void> {
    const { master, manifest } = this.require();
    const item = this.item(id);
    const index = manifest.items.indexOf(item);

    manifest.items.splice(index, 1);
    manifest.changesSinceBackup++;
    try {
      await saveManifest(master, manifest);
    } catch (e) {
      manifest.items.splice(index, 0, item);
      manifest.changesSinceBackup--;
      throw e;
    }
    await opfs.deleteObject(item.objectId);
  }

  async addCollection(name: string): Promise<Collection> {
    const { master, manifest } = this.require();
    const existing = manifest.collections.find(
      (c) => c.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (existing) return existing;
    const collection: Collection = { id: crypto.randomUUID(), name: name.trim() };
    manifest.collections.push(collection);
    await saveManifest(master, manifest);
    return collection;
  }

  async updateSettings(patch: Partial<VaultSettings>): Promise<VaultSettings> {
    const { master, manifest } = this.require();
    manifest.settings = { ...manifest.settings, ...patch };
    await saveManifest(master, manifest);
    return manifest.settings;
  }

  async markBackedUp(at: string): Promise<void> {
    const { master, manifest } = this.require();
    manifest.lastBackupAt = at;
    manifest.changesSinceBackup = 0;
    await saveManifest(master, manifest);
  }

  /* ---------------- backup ---------------- */

  /**
   * §29/§30: streams to a temp file and hands back a name, never a Blob. The
   * caller turns it into a download or a share on a second, separate gesture.
   */
  async exportBackup(
    onProgress?: (p: Progress & { files: number; totalFiles: number }) => void,
    signal?: AbortSignal,
  ) {
    const { header, manifest } = this.require();
    return exportBackup(header, manifest, { onProgress, signal });
  }

  /* ---------------- integrity ---------------- */

  /**
   * §51. Authenticates every chunk of every object without ever holding a whole
   * file: chunks are decrypted and dropped.
   */
  async verify(onProgress?: ProgressFn, signal?: AbortSignal): Promise<{
    checked: number;
    missing: VaultItem[];
    damaged: { item: VaultItem; reason: string }[];
    orphaned: string[];
  }> {
    const { manifest } = this.require();
    const missing: VaultItem[] = [];
    const damaged: { item: VaultItem; reason: string }[] = [];
    let checked = 0;

    for (const item of manifest.items) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      onProgress?.({ phase: "verifying", done: checked, total: manifest.items.length });

      if (!(await opfs.objectExists(item.objectId))) {
        missing.push(item);
        checked++;
        continue;
      }
      try {
        const { file, header, headerLength, fileKey } = await this.openObject(item);
        for await (const _chunk of decryptObject(file, headerLength, header, fileKey, { signal })) {
          void _chunk;
        }
        if (header.plaintextSize !== item.size) throw new Error("size mismatch with manifest");
      } catch (e) {
        damaged.push({ item, reason: (e as Error).message });
      }
      checked++;
    }

    const referenced = new Set(manifest.items.map((i) => i.objectId));
    const orphaned = (await opfs.listObjectIds()).filter((id) => !referenced.has(id));

    return { checked, missing, damaged, orphaned };
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function unb64Safe(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
