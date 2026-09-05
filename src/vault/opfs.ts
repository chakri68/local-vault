import { fromUtf8, utf8 } from "./bytes.ts";
import type { ManifestSlot } from "./types.ts";

/**
 * OPFS layout (§11). Paths reveal nothing: opaque IDs and ciphertext only.
 *
 *   /vault/header.json
 *   /vault/manifest/{active, manifest-a.enc, manifest-b.enc}
 *   /vault/objects/<uuid>
 *   /vault/temp/
 *
 * Everything in this module runs inside the vault worker (§11.1). The main thread
 * never touches OPFS.
 */

const ROOT = "vault";

async function root(): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  return opfs.getDirectoryHandle(ROOT, { create: true });
}

/**
 * Read paths must not create. Otherwise probing a destroyed vault silently
 * rebuilds an empty /vault/ tree as a side effect of asking whether one exists.
 */
async function rootOrNull(): Promise<FileSystemDirectoryHandle | null> {
  const opfs = await navigator.storage.getDirectory();
  try {
    return await opfs.getDirectoryHandle(ROOT, { create: false });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null;
    throw e;
  }
}

async function subOrNull(name: string): Promise<FileSystemDirectoryHandle | null> {
  const dir = await rootOrNull();
  if (!dir) return null;
  try {
    return await dir.getDirectoryHandle(name, { create: false });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null;
    throw e;
  }
}

async function sub(name: string): Promise<FileSystemDirectoryHandle> {
  return (await root()).getDirectoryHandle(name, { create: true });
}

export const objectsDir = () => sub("objects");
export const manifestDir = () => sub("manifest");
export const tempDir = () => sub("temp");

async function readFileOrNull(
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

/**
 * Write a whole small file. createWritable() stages into a swap file and only
 * commits on close(), so a crash mid-write leaves the previous contents intact
 * rather than a half-file (§11.1).
 */
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
    await w.abort();
    throw e;
  }
  await w.close();
}

/* ---------- header ---------- */

export async function readHeaderRaw(): Promise<string | null> {
  const dir = await rootOrNull();
  if (!dir) return null;
  const f = await readFileOrNull(dir, "header.json");
  return f ? f.text() : null;
}

export async function writeHeaderRaw(json: string): Promise<void> {
  await writeWhole(await root(), "header.json", json);
}

export async function vaultExists(): Promise<boolean> {
  return (await readHeaderRaw()) !== null;
}

/* ---------- manifest slots ---------- */

const SLOT_FILE: Record<ManifestSlot, string> = {
  a: "manifest-a.enc",
  b: "manifest-b.enc",
};

export async function readActiveSlot(): Promise<ManifestSlot | null> {
  const f = await readFileOrNull(await manifestDir(), "active");
  if (!f) return null;
  const v = (await f.text()).trim();
  return v === "a" || v === "b" ? v : null;
}

export async function setActiveSlot(slot: ManifestSlot): Promise<void> {
  await writeWhole(await manifestDir(), "active", slot);
}

export async function readSlot(slot: ManifestSlot): Promise<Uint8Array | null> {
  const f = await readFileOrNull(await manifestDir(), SLOT_FILE[slot]);
  return f ? new Uint8Array(await f.arrayBuffer()) : null;
}

export async function writeSlot(slot: ManifestSlot, bytes: Uint8Array): Promise<void> {
  await writeWhole(await manifestDir(), SLOT_FILE[slot], bytes);
}

/* ---------- objects ---------- */

/**
 * Open a streaming writer for an object. The caller writes ciphertext chunks and
 * closes; nothing is visible at the path until close() commits.
 *
 * Note the write amplification this implies: the swap file means the object costs
 * roughly twice its size in quota while in flight (§11.1, §25).
 */
export async function openObjectWriter(id: string): Promise<FileSystemWritableFileStream> {
  const handle = await (await objectsDir()).getFileHandle(id, { create: true });
  return handle.createWritable();
}

export async function readObject(id: string): Promise<File> {
  return (await (await objectsDir()).getFileHandle(id)).getFile();
}

export async function objectExists(id: string): Promise<boolean> {
  return (await readFileOrNull(await objectsDir(), id)) !== null;
}

export async function deleteObject(id: string): Promise<void> {
  try {
    await (await objectsDir()).removeEntry(id);
  } catch (e) {
    if ((e as DOMException).name !== "NotFoundError") throw e;
  }
}

export async function listObjectIds(): Promise<string[]> {
  const out: string[] = [];
  for await (const name of (await objectsDir()).keys()) out.push(name);
  return out;
}

/* ---------- temp ---------- */

export async function openTempWriter(name: string): Promise<FileSystemWritableFileStream> {
  const handle = await (await tempDir()).getFileHandle(name, { create: true });
  return handle.createWritable();
}

export async function readTemp(name: string): Promise<File> {
  return (await (await tempDir()).getFileHandle(name)).getFile();
}

export async function deleteTemp(name: string): Promise<void> {
  try {
    await (await tempDir()).removeEntry(name);
  } catch (e) {
    if ((e as DOMException).name !== "NotFoundError") throw e;
  }
}

/**
 * Unconditional temp sweep. Runs at boot and on lock (§16).
 *
 * Backup and restore stage here. Shared files deliberately never do — they are
 * handed service-worker-to-page in memory precisely so that nothing plaintext
 * ever lands on disk.
 */
export async function sweepTemp(): Promise<number> {
  const dir = await subOrNull("temp");
  if (!dir) return 0;
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names) {
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* a file still held open by a writer will be caught by the next sweep */
    }
  }
  return names.length;
}

/** Destroy the whole vault directory. Only ever called with explicit consent (§34). */
export async function destroyVault(): Promise<void> {
  const opfs = await navigator.storage.getDirectory();
  try {
    await opfs.removeEntry(ROOT, { recursive: true });
  } catch (e) {
    if ((e as DOMException).name !== "NotFoundError") throw e;
  }
}

export const encodeText = (s: string) => utf8.encode(s);
export const decodeText = (b: Uint8Array) => fromUtf8.decode(b);
