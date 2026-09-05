import { detect, missingRequired } from "../platform/capabilities.ts";
import type { PlatformCapabilities } from "../platform/capabilities.ts";
import { requestPersistence } from "../platform/storage.ts";
import { VaultClient } from "../worker/client.ts";
import type { Snapshot, StorageStatus } from "../worker/rpc.ts";
import type { VaultState } from "../vault/vault.ts";
import { buildIndex } from "./search.ts";
import type { IndexEntry } from "./search.ts";
import { clear } from "./dom.ts";
import { renderUnsupported } from "./screens/unsupported.ts";
import { renderSetup } from "./screens/setup.ts";
import { renderUnlock } from "./screens/unlock.ts";
import { renderBrowse } from "./screens/browse.ts";
import { openImport } from "./screens/importSheet.ts";

export class App {
  readonly client = new VaultClient();
  caps!: PlatformCapabilities;
  state: VaultState = "UNINITIALIZED";
  snapshot: Snapshot | null = null;
  storage: StorageStatus | null = null;
  index: IndexEntry[] = [];
  query = "";
  activeCollection: string | null = null;
  /** Files handed over by the share target, held in memory only (§16). */
  pending: File[] = [];
  /** Non-sensitive device-unlock config, or null when not enrolled (§21). */
  deviceUnlock: { credentialId: string; prfSalt: string } | null = null;

  private lockTimer: number | undefined;
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async boot(): Promise<void> {
    this.caps = await detect();
    const missing = missingRequired(this.caps);
    if (missing.length) {
      clear(this.root);
      this.root.appendChild(renderUnsupported(missing));
      return;
    }

    this.state = await this.client.call({ t: "probe" });
    this.deviceUnlock = await this.client.call({ t: "deviceInfo" });
    this.render();
    this.watchActivity();
  }

  /** Pull metadata and rebuild the in-memory index (§13). */
  async refresh(): Promise<void> {
    if (this.state !== "UNLOCKED") return;
    this.snapshot = await this.client.call({ t: "snapshot" });
    this.index = buildIndex(this.snapshot.items, this.snapshot.collections);
    this.storage = await this.client.call({ t: "storage" });
    this.deviceUnlock = await this.client.call({ t: "deviceInfo" });
    this.armAutoLock();
  }

  async onUnlocked(): Promise<void> {
    this.state = "UNLOCKED";
    await this.refresh();
    if (this.caps.persistentStorageRequest && !this.caps.persistentStorageGranted) {
      // §23: ask again at a meaningful moment; the answer is shown either way.
      const granted = await requestPersistence();
      this.caps = { ...this.caps, persistentStorageGranted: granted };
      this.storage = await this.client.call({ t: "storage" });
    }
    this.render();
  }

  async lock(): Promise<void> {
    await this.client.call({ t: "lock" });
    this.snapshot = null;
    this.index = [];
    this.query = "";
    this.activeCollection = null;
    this.pending = [];
    this.state = await this.client.call({ t: "probe" });
    clearTimeout(this.lockTimer);
    this.render();
  }

  render(): void {
    clear(this.root);
    if (this.state === "UNINITIALIZED") this.root.appendChild(renderSetup(this));
    else if (this.state === "UNLOCKED") this.root.appendChild(renderBrowse(this));
    else this.root.appendChild(renderUnlock(this));
  }

  /* ---------------- auto-lock (§17) ---------------- */

  private watchActivity(): void {
    const bump = () => this.armAutoLock();
    for (const evt of ["pointerdown", "keydown"]) {
      document.addEventListener(evt, bump, { passive: true });
    }
    // Document-level, so it is registered exactly once for the app's lifetime.
    document.addEventListener("paste", (e) => {
      if (this.state !== "UNLOCKED") return;
      if (document.querySelector(".backdrop")) return; // a sheet is already open
      const files = [...((e as ClipboardEvent).clipboardData?.files ?? [])];
      if (files.length) openImport(this, files);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      if (this.state === "UNLOCKED" && this.snapshot?.settings.autoLockMs === 0) {
        void this.lock();
      }
    });
  }

  armAutoLock(): void {
    clearTimeout(this.lockTimer);
    const ms = this.snapshot?.settings.autoLockMs;
    if (this.state !== "UNLOCKED" || ms === null || ms === undefined || ms <= 0) return;
    this.lockTimer = setTimeout(() => void this.lock(), ms) as unknown as number;
  }
}
