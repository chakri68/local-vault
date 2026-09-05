/**
 * Page side of the Android share handoff (§16).
 *
 * The Service Worker parked the incoming files in memory under a token and
 * redirected here. We claim them over postMessage; the bytes are Blob-backed, so
 * a 500 MB share does not become 500 MB of JS heap.
 *
 * If this fails — the worker was reaped, the user took too long — the import is
 * simply lost and they re-share. That is the intended failure: nothing was ever
 * written to disk unencrypted.
 */
export async function claimSharedFiles(): Promise<File[]> {
  const params = new URLSearchParams(location.search);
  const token = params.get("share");
  if (!token) return [];

  history.replaceState(null, "", location.pathname);

  const worker = await navigator.serviceWorker?.ready.catch(() => null);
  const target = worker?.active ?? navigator.serviceWorker?.controller;
  if (!target) return [];

  return new Promise<File[]>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve([]), 10_000);

    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      const data = e.data as { files?: File[] };
      resolve(data.files ?? []);
    };
    target.postMessage({ type: "claim-share", token }, [channel.port2]);
  });
}

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    /* the app works without it; only offline and share target need it */
  }
}
