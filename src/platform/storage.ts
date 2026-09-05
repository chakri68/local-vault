import type { StorageStatus } from "../worker/rpc.ts";

/**
 * §23–§25. Browser quota estimates, not physical free disk space — the UI has to
 * say so, because the two differ and only one of them is knowable from here.
 */

/** §25, adjusted for the createWritable swap file (§11.1). */
export const WARNING_FLOOR = 1024 * 1024 * 1024;
export const WARNING_FRACTION = 0.1;
export const CRITICAL_FLOOR = 250 * 1024 * 1024;
export const CRITICAL_FRACTION = 0.03;

export async function storageStatus(): Promise<StorageStatus> {
  const canRequest = typeof navigator.storage?.persist === "function";
  const persisted =
    typeof navigator.storage?.persisted === "function"
      ? await navigator.storage.persisted()
      : false;

  const est = typeof navigator.storage?.estimate === "function"
    ? await navigator.storage.estimate()
    : {};
  const usage = est.usage ?? 0;
  const quota = est.quota ?? 0;
  const remaining = Math.max(0, quota - usage);

  let level: StorageStatus["level"] = "ok";
  if (quota > 0) {
    if (remaining < Math.max(CRITICAL_FLOOR, quota * CRITICAL_FRACTION)) level = "critical";
    else if (remaining < Math.max(WARNING_FLOOR, quota * WARNING_FRACTION)) level = "warning";
  }

  return { persisted, canRequest, usage, quota, level };
}

export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator.storage?.persist !== "function") return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * An import needs roughly twice the file's size in free quota while
 * createWritable() holds its swap file (§11.1). Checking for `size` alone passes
 * immediately before the write fails.
 */
export async function hasRoomFor(bytes: number): Promise<{ ok: boolean; remaining: number }> {
  const { usage, quota } = await storageStatus();
  if (!quota) return { ok: true, remaining: 0 };
  const remaining = Math.max(0, quota - usage);
  return { ok: remaining > bytes * 2, remaining };
}
