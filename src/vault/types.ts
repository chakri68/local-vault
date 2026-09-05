/**
 * Persisted shapes and format versions.
 *
 * Every structure that touches disk carries a version (§55). Nothing here is
 * allowed to change meaning without bumping one of these.
 */

export const VAULT_FORMAT_VERSION = 1;
export const MANIFEST_FORMAT_VERSION = 1;
export const OBJECT_FORMAT_VERSION = 1;
export const BACKUP_FORMAT_VERSION = 1;

/** Plaintext bytes per AES-GCM chunk. Ciphertext is this + 16 (§9.5). */
export const CHUNK_SIZE = 1024 * 1024;
export const TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const UUID_BYTES = 16;

export interface KdfParams {
  /** KiB, per Argon2 convention. */
  memorySize: number;
  iterations: number;
  parallelism: number;
}

/** AES-GCM ciphertext + its nonce, both base64. */
export interface Wrapped {
  iv: string;
  ct: string;
}

export interface DeviceUnlock {
  version: number;
  credentialId: string;
  prfSalt: string;
  wrapped: Wrapped;
}

/**
 * `/vault/header.json` — the only file that is deliberately plaintext.
 * It holds nothing sensitive: random IDs, KDF parameters, and ciphertext (§11).
 */
export interface VaultHeader {
  formatVersion: number;
  migrationVersion: number;
  vaultId: string;
  createdAt: string;
  kdf: "argon2id";
  kdfSalt: string;
  kdfParams: KdfParams;
  /** Passphrase-wrapped master key. Always present — this is §22. */
  passphrase: Wrapped;
  /** Optional convenience wrapper. Never the only one. */
  deviceUnlock?: DeviceUnlock;
}

export interface VaultItem {
  id: string;
  displayName: string;
  originalName?: string;

  mimeType: string;
  size: number;

  createdAt: string;
  importedAt: string;
  modifiedAt: string;

  tags: string[];
  collectionId?: string;
  notes?: string;

  documentDate?: string;
  expiresAt?: string;

  objectId: string;

  /** SHA-256 of the plaintext, for duplicate detection (§36). Never leaves the device. */
  sha256?: string;

  favorite: boolean;
  archived: boolean;
}

export type ManifestSlot = "a" | "b";

export interface Collection {
  id: string;
  name: string;
}

/** null = never auto-lock while the app is open; 0 = lock on losing foreground. */
export type AutoLockMs = number | null;

export interface VaultSettings {
  autoLockMs: AutoLockMs;
  backupReminderDays: number | null;
}

/** The decrypted manifest. Persisted only as ciphertext (§10). */
export interface Manifest {
  formatVersion: number;
  vaultId: string;
  updatedAt: string;
  items: VaultItem[];
  collections: Collection[];
  settings: VaultSettings;
  lastBackupAt?: string;
  /** Items added/changed/removed since the last successful backup (§32). */
  changesSinceBackup: number;
}

export const DEFAULT_SETTINGS: VaultSettings = {
  autoLockMs: 60_000,
  backupReminderDays: 14,
};

/** §14. Seeded on vault creation; the user can add more. */
export const DEFAULT_COLLECTIONS: readonly string[] = [
  "Identity",
  "Employment",
  "Finance",
  "Education",
  "Travel",
  "Insurance",
  "Receipts",
  "Photos",
  "Certificates",
  "Miscellaneous",
];
