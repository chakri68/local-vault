/**
 * §49. One place that asks the platform what it can do. No user-agent string
 * appears anywhere in this codebase — Safari lands on the unsupported screen
 * because it fails `opfsWritable`, not because it was named (§4).
 */
export interface PlatformCapabilities {
  // required
  opfs: boolean;
  opfsWritable: boolean;
  serviceWorker: boolean;
  webCrypto: boolean;

  // degrade
  persistentStorageRequest: boolean;
  persistentStorageGranted: boolean;
  webShare: boolean;
  webShareFiles: boolean;
  webShareTargetExpected: boolean;
  webAuthn: boolean;
  /** null = undetectable here; enrollment verifies for real (§20). */
  webAuthnPrf: boolean | null;
  fileSystemAccess: boolean;
}

const REQUIRED = ["opfs", "opfsWritable", "serviceWorker", "webCrypto"] as const;

export const REQUIRED_LABELS: Record<(typeof REQUIRED)[number], string> = {
  opfs: "Origin Private File System",
  opfsWritable: "OPFS streaming writes (createWritable)",
  serviceWorker: "Service Workers",
  webCrypto: "Web Crypto (AES-GCM)",
};

export async function detect(): Promise<PlatformCapabilities> {
  const opfs = typeof navigator.storage?.getDirectory === "function";

  // Prototype probe: no file is created, nothing is written. Safari has the
  // interface but not this method, which is exactly the line we are drawing.
  const opfsWritable =
    typeof globalThis.FileSystemFileHandle !== "undefined" &&
    typeof globalThis.FileSystemFileHandle.prototype?.createWritable === "function";

  const webShare = typeof navigator.share === "function";
  let webShareFiles = false;
  if (webShare && typeof navigator.canShare === "function") {
    try {
      webShareFiles = navigator.canShare({
        files: [new File([new Uint8Array(1)], "probe.bin", { type: "application/octet-stream" })],
      });
    } catch {
      webShareFiles = false;
    }
  }

  const webAuthn = typeof globalThis.PublicKeyCredential !== "undefined";
  let webAuthnPrf: boolean | null = webAuthn ? null : false;
  const getCaps = (
    globalThis.PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    }
  )?.getClientCapabilities;
  if (webAuthn && typeof getCaps === "function") {
    try {
      const caps = await getCaps.call(globalThis.PublicKeyCredential);
      webAuthnPrf = caps["extension:prf"] ?? null;
    } catch {
      webAuthnPrf = null;
    }
  }

  return {
    opfs,
    opfsWritable,
    serviceWorker: "serviceWorker" in navigator,
    webCrypto: typeof crypto?.subtle?.encrypt === "function",

    persistentStorageRequest: typeof navigator.storage?.persist === "function",
    persistentStorageGranted:
      typeof navigator.storage?.persisted === "function"
        ? await navigator.storage.persisted()
        : false,

    webShare,
    webShareFiles,
    // Only an installed PWA on Chromium/Android is actually registered as a
    // share target; JS cannot observe that directly (§49).
    webShareTargetExpected:
      "serviceWorker" in navigator &&
      matchMedia("(display-mode: standalone)").matches &&
      /Android/i.test(navigator.userAgent),

    webAuthn,
    webAuthnPrf,
    fileSystemAccess: typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function",
  };
}

/** §49.1 — anything listed here means the app renders the unsupported screen. */
export function missingRequired(c: PlatformCapabilities): string[] {
  return REQUIRED.filter((k) => !c[k]).map((k) => REQUIRED_LABELS[k]);
}
