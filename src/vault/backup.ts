import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter, configure } from "@zip.js/zip.js";
import type { FileEntry } from "@zip.js/zip.js";
import { b64, unb64 } from "./bytes.ts";
import { deriveKek } from "./crypto/argon2.ts";
import { importMasterKey, openBytes } from "./crypto/keys.ts";
import { decryptManifest } from "./manifest.ts";
import { authenticateObject } from "./integrity.ts";
import * as opfs from "./opfs.ts";
import type { VaultTree } from "./opfs.ts";
import { BACKUP_FORMAT_VERSION, VAULT_FORMAT_VERSION } from "./types.ts";
import type { KdfParams, Manifest, VaultHeader, Wrapped } from "./types.ts";
import type { Progress } from "./vault.ts";

/**
 * Encrypted backup (§27–§29, §33).
 *
 * The archive carries the *already encrypted* objects byte for byte, plus the
 * passphrase-wrapped master key. That is what makes restore a copy rather than a
 * re-encryption, and why the passphrase alone is sufficient to restore on a new
 * device with no trace of the old WebAuthn credential (§62.17).
 *
 * STORE, never deflate: ciphertext is incompressible, so compression would burn
 * CPU to make the file marginally larger.
 */

// zip.js spins up its own workers from blob: URLs by default, which `worker-src
// 'self'` forbids (§43). We are already inside a worker and doing no compression,
// so there is nothing to gain from them anyway.
configure({ useWebWorkers: false });

const MAGIC = "LOCAL_VAULT_BACKUP";

export interface VaultBackupHeader {
  magic: typeof MAGIC;
  formatVersion: number;
  vaultId: string;
  createdAt: string;
  crypto: {
    masterKeyWrapperVersion: number;
    passphrase: {
      kdf: "argon2id";
      salt: string;
      params: KdfParams;
      /** "<base64 iv>.<base64 ciphertext>" */
      wrappedMasterKey: string;
    };
  };
  manifest: { path: "manifest.enc" };
}

const packWrapped = (w: Wrapped) => `${w.iv}.${w.ct}`;

function unpackWrapped(s: string): Wrapped {
  const dot = s.indexOf(".");
  if (dot < 1) throw new Error("malformed wrapped master key");
  return { iv: s.slice(0, dot), ct: s.slice(dot + 1) };
}

export function backupFileName(at = new Date()): string {
  return `local-vault-${at.toISOString().slice(0, 10)}.vault.zip`;
}

/* ---------------- export ---------------- */

export interface ExportOptions {
  onProgress?: (p: Progress & { files: number; totalFiles: number }) => void;
  signal?: AbortSignal;
}

/**
 * Stream the whole vault into a ZIP in `/vault/temp/`.
 *
 * Deliberately not returned as a Blob: a multi-GB Blob assembled in memory is
 * exactly what §29 forbids. The caller gets a temp filename and turns it into a
 * download or a share in a *second* user gesture (§30).
 */
export async function exportBackup(
  tree: VaultTree,
  header: VaultHeader,
  manifest: Manifest,
  opts: ExportOptions = {},
): Promise<{ tempName: string; size: number; fileName: string; createdAt: string }> {
  const createdAt = new Date().toISOString();
  const tempName = `export-${Date.now()}.zip`;

  const backupHeader: VaultBackupHeader = {
    magic: MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    vaultId: header.vaultId,
    createdAt,
    crypto: {
      masterKeyWrapperVersion: VAULT_FORMAT_VERSION,
      passphrase: {
        kdf: "argon2id",
        salt: header.kdfSalt,
        params: header.kdfParams,
        wrappedMasterKey: packWrapped(header.passphrase),
      },
    },
    manifest: { path: "manifest.enc" },
  };

  const activeSlot = await tree.readActiveSlot();
  const manifestBytes = activeSlot ? await tree.readSlot(activeSlot) : null;
  if (!manifestBytes) throw new Error("no manifest snapshot to back up");

  const writable = await tree.openTempWriter(tempName);
  const zip = new ZipWriter(writable as unknown as WritableStream<Uint8Array>, { level: 0 });

  const totalFiles = manifest.items.length + 2;
  const totalBytes = manifest.items.reduce((n, i) => n + i.size, 0);
  let files = 0;
  let done = 0;

  try {
    await zip.add("vault.json", new TextReader(JSON.stringify(backupHeader, null, 2)));
    files++;
    await zip.add("manifest.enc", new BlobReader(new Blob([manifestBytes as BufferSource])));
    files++;

    for (const item of manifest.items) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const object = await tree.readObject(item.objectId);
      await zip.add(`objects/${item.objectId}.bin`, new BlobReader(object));
      files++;
      done += item.size;
      opts.onProgress?.({ phase: "encrypting", done, total: totalBytes, files, totalFiles });
    }

    await zip.close();
  } catch (e) {
    await zip.close().catch(() => {});
    throw e;
  }

  const file = await tree.readTemp(tempName);
  return { tempName, size: file.size, fileName: backupFileName(new Date(createdAt)), createdAt };
}

/* ---------------- restore ---------------- */

/** §33.4 — reject anything that is not one of the three shapes we wrote. */
function safeEntryName(name: string): "header" | "manifest" | "object" | null {
  if (name.includes("..") || name.startsWith("/") || name.includes("\\")) return null;
  if (name === "vault.json") return "header";
  if (name === "manifest.enc") return "manifest";
  if (/^objects\/[0-9a-f-]{36}\.bin$/.test(name)) return "object";
  return null;
}

export interface RestoreOptions {
  onProgress?: (p: Progress & { files: number; totalFiles: number }) => void;
  signal?: AbortSignal;
}

/**
 * Validate everything, then replace.
 *
 * Nothing on disk is touched until the passphrase has unwrapped the master key,
 * the manifest has decrypted, and every item the manifest references has been
 * matched to an entry in the archive. A bad passphrase or a damaged archive
 * therefore fails with the existing vault untouched (§33).
 */
export async function restoreBackup(
  file: File,
  passphrase: string,
  opts: RestoreOptions = {},
): Promise<{ items: number }> {
  const reader = new ZipReader(new BlobReader(file));
  let staged: VaultTree | null = null;

  try {
    const entries = await reader.getEntries();

    const byName = new Map<string, FileEntry>();
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!safeEntryName(entry.filename)) {
        throw new Error(`archive contains an unexpected path: ${entry.filename}`);
      }
      byName.set(entry.filename, entry as FileEntry);
    }

    const headerEntry = byName.get("vault.json");
    const manifestEntry = byName.get("manifest.enc");
    if (!headerEntry || !manifestEntry) throw new Error("this is not a Local Vault backup");

    const headerText = await (await headerEntry.getData<Blob>(new BlobWriter())).text();
    const backupHeader = JSON.parse(headerText) as VaultBackupHeader;
    if (backupHeader.magic !== MAGIC) throw new Error("this is not a Local Vault backup");
    if (backupHeader.formatVersion > BACKUP_FORMAT_VERSION) {
      throw new Error("this backup was made by a newer version of Local Vault");
    }

    const wrapped = unpackWrapped(backupHeader.crypto.passphrase.wrappedMasterKey);
    const kek = await deriveKek(
      passphrase,
      unb64(backupHeader.crypto.passphrase.salt),
      backupHeader.crypto.passphrase.params,
    );

    // Throws on a wrong passphrase, long before anything is written.
    const masterRaw = await openBytes(kek, wrapped);
    let master: CryptoKey;
    try {
      master = await importMasterKey(masterRaw);
    } finally {
      masterRaw.fill(0);
    }

    const manifestBlob = await manifestEntry.getData<Blob>(new BlobWriter());
    const manifestBytes = new Uint8Array(await manifestBlob.arrayBuffer());
    const manifest = await decryptManifest(master, manifestBytes);
    if (manifest.vaultId !== backupHeader.vaultId) {
      throw new Error("backup header and manifest disagree about the vault");
    }

    for (const item of manifest.items) {
      if (!byName.has(`objects/${item.objectId}.bin`)) {
        throw new Error(`backup is missing an object for "${item.displayName}"`);
      }
    }

    const totalBytes = manifest.items.reduce((n, i) => n + i.size, 0);
    const room = await navigator.storage.estimate();
    if (room.quota && room.usage !== undefined && room.quota - room.usage < totalBytes * 1.2) {
      throw new Error("not enough browser storage quota to restore this backup");
    }

    // Everything from here lands in a brand-new generation. The live vault is
    // not touched, so a corrupt archive, a quota wall, or a crash costs the user
    // nothing but some orphaned bytes (§33, §34).
    staged = await opfs.createGeneration();

    const totalFiles = manifest.items.length;
    let files = 0;
    let done = 0;

    for (const item of manifest.items) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const entry = byName.get(`objects/${item.objectId}.bin`)!;
      const blob = await entry.getData<Blob>(new BlobWriter());

      const writer = await staged.openObjectWriter(item.objectId);
      try {
        await writer.write(blob as unknown as BufferSource);
        await writer.close();
      } catch (e) {
        await writer.abort().catch(() => {});
        throw e;
      }
      files++;
      done += item.size;
      opts.onProgress?.({ phase: "encrypting", done, total: totalBytes, files, totalFiles });
    }

    // Authenticate every chunk of every object, read back off disk.
    //
    // Checking that an archive merely *contains* a file of the right name is not
    // checking it at all: a truncated, corrupted or substituted object would
    // otherwise be restored, reported as a success, and only discovered months
    // later when the document is opened -- by which time the healthy vault it
    // replaced is long gone. This doubles restore I/O and is worth every byte.
    files = 0;
    done = 0;
    for (const item of manifest.items) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await authenticateObject(staged, master, manifest.vaultId, item, opts.signal);
      } catch (e) {
        // A failed GCM tag surfaces as OperationError with an empty message, so
        // only append a reason when there actually is one.
        const reason = (e as Error).message?.trim();
        throw new Error(
          `backup is damaged: "${item.displayName}" failed verification` +
            (reason ? ` (${reason})` : ""),
        );
      }
      files++;
      done += item.size;
      opts.onProgress?.({ phase: "verifying", done, total: totalBytes, files, totalFiles });
    }

    const restoredHeader: VaultHeader = {
      formatVersion: VAULT_FORMAT_VERSION,
      migrationVersion: VAULT_FORMAT_VERSION,
      vaultId: backupHeader.vaultId,
      createdAt: backupHeader.createdAt,
      kdf: "argon2id",
      kdfSalt: backupHeader.crypto.passphrase.salt,
      kdfParams: backupHeader.crypto.passphrase.params,
      passphrase: wrapped,
    };

    await staged.writeSlot("a", manifestBytes);
    await staged.setActiveSlot("a");
    await staged.writeHeaderRaw(JSON.stringify(restoredHeader, null, 2));

    // The flip. One small write; before it the old vault is live, after it the
    // new one is, and there is no moment where neither is.
    await opfs.activate(staged);
    staged = null;

    return { items: manifest.items.length };
  } finally {
    await reader.close().catch(() => {});
    // Whether we flipped or failed, anything not referenced by `current` is
    // debris -- the superseded vault on success, the half-written generation on
    // failure. Either way it is safe to drop precisely because nothing points
    // at it.
    await opfs.pruneOrphanGenerations().catch(() => {});
  }
}

export const _internal = { safeEntryName, packWrapped, unpackWrapped, b64 };
