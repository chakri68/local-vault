import { el } from "./dom.ts";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * PDF preview (§37).
 *
 * The browser's own viewer is unreachable here: it needs `<embed>`/`<object>` or
 * an `<iframe>`, and §43 sets `object-src 'none'` and `frame-src 'none'`. Rather
 * than widen the CSP on the one application holding decrypted identity
 * documents, we render to a canvas with self-hosted pdf.js.
 *
 * pdf.js is loaded lazily — it is roughly a megabyte, and most vault items are
 * not PDFs, so it has no business in the initial bundle.
 *
 * Bytes are handed over as `data`, never a URL. Nothing is fetched, which is
 * what lets `connect-src` stay at 'none'.
 */

type PdfLib = typeof import("pdfjs-dist");
let libPromise: Promise<PdfLib> | null = null;

async function lib(): Promise<PdfLib> {
  libPromise ??= (async () => {
    const [pdfjs, workerSrc] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default),
    ]);
    // Same-origin, hashed, emitted by Vite — satisfies worker-src 'self'.
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    return pdfjs;
  })();
  return libPromise;
}

export interface PdfView {
  destroy(): void;
}

export async function renderPdf(blob: Blob, container: HTMLElement): Promise<PdfView> {
  const pdfjs = await lib();
  const data = new Uint8Array(await blob.arrayBuffer());

  const loadingTask = pdfjs.getDocument({
    data,
    // Everything below keeps pdf.js from reaching for the network. Documents
    // relying on non-embedded standard fonts fall back to system faces.
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    isOffscreenCanvasSupported: false,
  });

  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (e) {
    data.fill(0);
    throw e;
  }

  let page = 1;
  let destroyed = false;
  let current: { cancel(): void } | null = null;

  const canvas = el("canvas", { class: "pdf-canvas" });
  const label = el("span", { class: "meta num" });
  const prev = el("button", { class: "btn ghost", text: "‹ Prev" });
  const next = el("button", { class: "btn ghost", text: "Next ›" });

  const draw = async () => {
    if (destroyed) return;
    current?.cancel();
    const p = await doc.getPage(page);
    if (destroyed) return;

    const width = Math.max(240, container.clientWidth - 24);
    const base = p.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = p.getViewport({ scale: (width / base.width) * dpr });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

    const renderTask = p.render({ canvas, viewport });
    current = renderTask;
    try {
      await renderTask.promise;
    } catch (e) {
      if ((e as Error).name !== "RenderingCancelledException") throw e;
    }
    label.textContent = `${page} / ${doc.numPages}`;
    prev.disabled = page <= 1;
    next.disabled = page >= doc.numPages;
  };

  prev.addEventListener("click", () => {
    if (page > 1) {
      page--;
      void draw();
    }
  });
  next.addEventListener("click", () => {
    if (page < doc.numPages) {
      page++;
      void draw();
    }
  });

  // The nav goes above the canvas and sticks: `.preview` is the scroll
  // container and a full page is taller than it, so a nav underneath the canvas
  // is scrolled out of reach exactly when you need it.
  const nav = el("div", { class: "pdf-nav" }, [prev, label, next]);
  container.replaceChildren(
    el("div", { class: "pdf-view" }, [doc.numPages > 1 ? nav : null, canvas]),
  );
  await draw();

  return {
    destroy() {
      destroyed = true;
      current?.cancel();
      // destroy() lives on the loading task; the proxy only offers cleanup().
      // This is what tears down the pdf.js worker.
      void loadingTask.destroy();
      data.fill(0);
    },
  };
}
