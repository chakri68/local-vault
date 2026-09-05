import type { ManifestSlot } from "./types.ts";

/**
 * OPFS layout (§11), organised into *generations* so that replacing a vault is
 * atomic (§33, §34).
 *
 *   /current          text: the name of the live generation
 *   /vault/           legacy generation, from before generations existed
 *   /g-<uuid>/        a generation
 *       header.json
 *       manifest/{active, manifest-a.enc, manifest-b.enc}
 *       objects/<uuid>
 *       temp/
 *
 * Restore writes an entirely new generation, verifies it end to end, and only
 * then rewrites `/current`. Until that one small write lands, the existing vault
 * is untouched and still live; if anything fails — a bad archive, a quota wall,
 * a crash — the half-written generation is orphaned garbage rather than the
 * user's only copy. This is the same write-verify-flip trick as the manifest
 * A/B slots (§12), applied one level up.
 *
 * Everything here runs inside the vault worker (§11.1).
 */

const CURRENT = "current";
const LEGACY_GENERATION = "vault";
const GENERATION_PREFIX = "g-";

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function fileOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null;
    throw e;
  }
}

async function dirOrNull(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null;
    throw e;
  }
}

async function writeWhole(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array | string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(typeof data === "string" ? data : (data as BufferSource));
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
  await w.close();
}

const SLOT_FILE: Record<ManifestSlot, string> = {
  a: "manifest-a.enc",
  b: "manifest-b.enc",
};

/** One generation's directory tree. All vault I/O goes through an instance. */
export class VaultTree {
  readonly generation: string;
  private dir: FileSystemDirectoryHandle;

  constructor(dir: FileSystemDirectoryHandle, generation: string) {
    this.dir = dir;
    this.generation = generation;
  }

  private sub(name: string): Promise<FileSystemDirectoryHandle> {
    return this.dir.getDirectoryHandle(name, { create: true });
  }

  /* ---------- header ---------- */

  async readHeaderRaw(): Promise<string | null> {
    const f = await fileOrNull(this.dir, "header.json");
    return f ? f.text() : null;
  }

  async writeHeaderRaw(json: string): Promise<void> {
    await writeWhole(this.dir, "header.json", json);
  }

  /* ---------- manifest slots (§12) ---------- */

  async readActiveSlot(): Promise<ManifestSlot | null> {
    const f = await fileOrNull(await this.sub("manifest"), "active");
    if (!f) return null;
    const v = (await f.text()).trim();
    return v === "a" || v === "b" ? v : null;
  }

  async setActiveSlot(slot: ManifestSlot): Promise<void> {
    await writeWhole(await this.sub("manifest"), "active", slot);
  }

  async readSlot(slot: ManifestSlot): Promise<Uint8Array | null> {
    const f = await fileOrNull(await this.sub("manifest"), SLOT_FILE[slot]);
    return f ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  async writeSlot(slot: ManifestSlot, bytes: Uint8Array): Promise<void> {
    await writeWhole(await this.sub("manifest"), SLOT_FILE[slot], bytes);
  }

  /* ---------- objects ---------- */

  /**
   * createWritable() stages into a swap file and commits on close(), so nothing
   * is visible at the path until the write succeeds — and an in-flight write
   * transiently costs twice the object's size in quota (§11.1, §25).
   */
  async openObjectWriter(id: string): Promise<FileSystemWritableFileStream> {
    const handle = await (await this.sub("objects")).getFileHandle(id, { create: true });
    return handle.createWritable();
  }

  async readObject(id: string): Promise<File> {
    return (await (await this.sub("objects")).getFileHandle(id)).getFile();
  }

  async objectExists(id: string): Promise<boolean> {
    return (await fileOrNull(await this.sub("objects"), id)) !== null;
  }

  async deleteObject(id: string): Promise<void> {
    try {
      await (await this.sub("objects")).removeEntry(id);
    } catch (e) {
      if ((e as DOMException).name !== "NotFoundError") throw e;
    }
  }

  async listObjectIds(): Promise<string[]> {
    const out: string[] = [];
    for await (const name of (await this.sub("objects")).keys()) out.push(name);
    return out;
  }

  /* ---------- temp ---------- */

  async openTempWriter(name: string): Promise<FileSystemWritableFileStream> {
    const handle = await (await this.sub("temp")).getFileHandle(name, { create: true });
    return handle.createWritable();
  }

  async readTemp(name: string): Promise<File> {
    return (await (await this.sub("temp")).getFileHandle(name)).getFile();
  }

  async deleteTemp(name: string): Promise<void> {
    try {
      await (await this.sub("temp")).removeEntry(name);
    } catch (e) {
      if ((e as DOMException).name !== "NotFoundError") throw e;
    }
  }

  /**
   * Unconditional temp sweep, at boot and on lock (§16).
   *
   * Backup and restore stage here. Shared files deliberately never do — they are
   * handed service-worker-to-page in memory precisely so nothing plaintext lands
   * on disk.
   */
  async sweepTemp(): Promise<number> {
    const dir = await dirOrNull(this.dir, "temp");
    if (!dir) return 0;
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    for (const name of names) {
      try {
        await dir.removeEntry(name, { recursive: true });
      } catch {
        /* still held open by a writer; the next sweep gets it */
      }
    }
    return names.length;
  }
}

/* ---------------- generations ---------------- */

async function readCurrentName(): Promise<string | null> {
  const root = await opfsRoot();
  const f = await fileOrNull(root, CURRENT);
  if (f) {
    const name = (await f.text()).trim();
    if (name) return name;
  }

  // Migrate a pre-generation vault by *naming* it, not by copying it.
  const legacy = await dirOrNull(root, LEGACY_GENERATION);
  if (legacy && (await fileOrNull(legacy, "header.json"))) {
    await writeWhole(root, CURRENT, LEGACY_GENERATION);
    return LEGACY_GENERATION;
  }
  return null;
}

export async function openCurrent(): Promise<VaultTree | null> {
  const name = await readCurrentName();
  if (!name) return null;
  const dir = await dirOrNull(await opfsRoot(), name);
  return dir ? new VaultTree(dir, name) : null;
}

/** A fresh, unreferenced generation. Nothing points at it until activate(). */
export async function createGeneration(): Promise<VaultTree> {
  const name = `${GENERATION_PREFIX}${crypto.randomUUID()}`;
  const dir = await (await opfsRoot()).getDirectoryHandle(name, { create: true });
  return new VaultTree(dir, name);
}

/** The flip. One small write, and the new generation is live. */
export async function activate(tree: VaultTree): Promise<void> {
  await writeWhole(await opfsRoot(), CURRENT, tree.generation);
}

export async function vaultExists(): Promise<boolean> {
  const tree = await openCurrent();
  return tree !== null && (await tree.readHeaderRaw()) !== null;
}

/**
 * Delete every generation except the live one. Orphans are the debris of failed
 * or superseded restores; collecting them is safe precisely because nothing
 * references them.
 */
export async function pruneOrphanGenerations(): Promise<string[]> {
  const root = await opfsRoot();
  const keep = await readCurrentName();
  const dropped: string[] = [];
  const names: string[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    if (name === keep) continue;
    if (name !== LEGACY_GENERATION && !name.startsWith(GENERATION_PREFIX)) continue;
    names.push(name);
  }
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
      dropped.push(name);
    } catch {
      /* leave it; the next prune will retry */
    }
  }
  return dropped;
}

/** Destroy everything. Only ever called with explicit consent (§34, §39). */
export async function destroyAll(): Promise<void> {
  const root = await opfsRoot();
  const names: string[] = [];
  for await (const [name] of root.entries()) names.push(name);
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}
