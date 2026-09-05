import type { ImportMeta, Progress, VaultState } from "../vault/vault.ts";
import type { Collection, VaultItem, VaultSettings } from "../vault/types.ts";

/**
 * The entire surface between the UI and the master key.
 *
 * Everything below the worker boundary can touch plaintext; nothing above it can
 * reach a key. Keeping this list short is the point — every new verb is another
 * thing the view layer can ask the vault to do (§7).
 */
export type Req =
  | { t: "probe" }
  | { t: "create"; passphrase: string }
  | { t: "unlock"; passphrase: string }
  | { t: "lock" }
  | { t: "snapshot" }
  | { t: "hashCandidate"; file: Blob }
  | { t: "import"; file: File; meta: ImportMeta; sha256?: string }
  | { t: "read"; id: string }
  | { t: "update"; id: string; patch: Partial<VaultItem> }
  | { t: "delete"; id: string }
  | { t: "addCollection"; name: string }
  | { t: "settings"; patch: Partial<VaultSettings> }
  | { t: "changePassphrase"; current: string; next: string }
  | { t: "verify" }
  | { t: "storage" }
  | { t: "exportBackup" }
  | { t: "readBackup"; tempName: string }
  | { t: "discardBackup"; tempName: string }
  | { t: "restoreBackup"; file: File; passphrase: string }
  | { t: "markBackedUp"; at: string }
  | { t: "destroy" };

export interface Snapshot {
  items: VaultItem[];
  collections: Collection[];
  settings: VaultSettings;
  lastBackupAt?: string;
  changesSinceBackup: number;
}

export interface StorageStatus {
  persisted: boolean;
  canRequest: boolean;
  usage: number;
  quota: number;
  level: "ok" | "warning" | "critical";
}

export interface VerifyReport {
  checked: number;
  missing: VaultItem[];
  damaged: { item: VaultItem; reason: string }[];
  orphaned: string[];
}

export interface BackupResult {
  tempName: string;
  size: number;
  fileName: string;
  createdAt: string;
}

export interface ResMap {
  probe: VaultState;
  create: void;
  unlock: void;
  lock: void;
  snapshot: Snapshot;
  hashCandidate: { sha256: string; duplicateOf?: VaultItem };
  import: VaultItem;
  read: Blob;
  update: VaultItem;
  delete: void;
  addCollection: Collection;
  settings: VaultSettings;
  changePassphrase: void;
  verify: VerifyReport;
  storage: StorageStatus;
  exportBackup: BackupResult;
  readBackup: File;
  discardBackup: void;
  restoreBackup: { items: number };
  markBackedUp: void;
  destroy: void;
}

export type Res<K extends Req["t"] = Req["t"]> = ResMap[K];

export type Envelope =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }
  | { id: number; progress: Progress };
