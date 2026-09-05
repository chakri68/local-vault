/**
 * Local Vault service worker — hand written, no Workbox runtime (§7).
 *
 * Two jobs: cache the application shell so the vault opens offline (§41), and
 * receive Android share-target POSTs (§16).
 *
 * It never sees a key and never writes anything to OPFS. Shared files are held
 * in memory here for exactly as long as it takes the page to claim them.
 */

const VERSION = "v1";
const SHELL_CACHE = `local-vault-shell-${VERSION}`;

const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/jetbrains-mono-var.woff2",
  "/fonts/press-start-2p.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/* ---------------- share target (§16) ---------------- */

/**
 * token -> { files, release }
 *
 * In memory, deliberately. The worker has no master key, so anything it wrote to
 * disk would be plaintext. If the page never claims — the user walked away from
 * a locked vault — the entry simply evaporates and they re-share. Losing a
 * pending import is the correct failure; leaking one is not.
 */
const shared = new Map();
const HANDOFF_TIMEOUT_MS = 60_000;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.pathname === "/share-target") {
    // waitUntil must be called synchronously, before any await, or the worker
    // can be reaped between the redirect and the page's claim.
    let release;
    const handoff = new Promise((resolve) => (release = resolve));
    event.waitUntil(handoff);
    event.respondWith(receiveShare(event.request, release));
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/").then((hit) => hit || fetch(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          // Vite emits immutable hashed asset names, so caching them is safe.
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});

async function receiveShare(request, release) {
  const token = crypto.randomUUID();
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => f instanceof File && f.size > 0);
    shared.set(token, { files, release });
    setTimeout(() => {
      if (shared.delete(token)) release();
    }, HANDOFF_TIMEOUT_MS);
  } catch (e) {
    release();
    return Response.redirect("/?share-error=1", 303);
  }
  return Response.redirect(`/?share=${token}`, 303);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "claim-share") return;

  const entry = shared.get(data.token);
  shared.delete(data.token);
  const port = event.ports && event.ports[0];
  if (port) port.postMessage({ files: entry ? entry.files : [] });
  if (entry) entry.release();
});
