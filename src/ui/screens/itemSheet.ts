import { el } from "../dom.ts";
import { bytes, date, kind } from "../format.ts";
import { describe } from "../errors.ts";
import { confirmModal, modal } from "../modal.ts";
import { renderPdf } from "../pdf.ts";
import type { App } from "../app.ts";
import type { VaultItem } from "../../vault/types.ts";

/**
 * §37/§38/§40. The decrypted Blob exists only while this sheet is open, and its
 * object URL is revoked on close — nothing decrypted is ever persisted.
 */
export function openItem(app: App, id: string): void {
  const item = app.snapshot!.items.find((i) => i.id === id);
  if (!item) return;

  let objectUrl: string | null = null;
  let plaintext: Blob | null = null;
  let pdfView: { destroy(): void } | null = null;

  const preview = el("div", { class: "preview" }, [el("div", { class: "hint", text: "Decrypting…" })]);
  const error = el("div", { class: "notice error", hidden: true });

  const handle = modal(item.displayName, (h) => [
    preview,
    el("dl", { class: "kv" }, [
      el("dt", { text: "Type" }),
      el("dd", { text: kind(item.mimeType, item.originalName ?? "") }),
      el("dt", { text: "Size" }),
      el("dd", { text: bytes(item.size) }),
      el("dt", { text: "Added" }),
      el("dd", { text: date(item.importedAt) }),
      item.documentDate ? el("dt", { text: "Dated" }) : null,
      item.documentDate ? el("dd", { text: date(item.documentDate) }) : null,
      item.expiresAt ? el("dt", { text: "Expires" }) : null,
      item.expiresAt ? el("dd", { text: date(item.expiresAt) }) : null,
      item.originalName ? el("dt", { text: "Original" }) : null,
      item.originalName ? el("dd", { text: item.originalName }) : null,
    ].filter(Boolean) as Node[]),
    item.tags.length
      ? el("div", { class: "chips" }, item.tags.map((t) => el("span", { class: "chip static", text: t })))
      : null,
    item.notes ? el("div", { class: "card muted", text: item.notes }) : null,
    error,
    actions(app, item, h, () => plaintext),
  ]);

  const origClose = handle.close.bind(handle);
  handle.close = () => {
    pdfView?.destroy();
    pdfView = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    plaintext = null;
    origClose();
  };

  void app.client
    .call({ t: "read", id: item.id })
    .then((blob) => {
      plaintext = blob;
      objectUrl = URL.createObjectURL(blob);
      if (item.mimeType === "application/pdf") {
        preview.replaceChildren(el("div", { class: "hint", text: "Rendering…" }));
        return renderPdf(blob, preview).then((view) => {
          pdfView = view;
        });
      }
      preview.replaceChildren(renderPreview(item, blob, objectUrl));
      return undefined;
    })
    .catch((e: Error) => {
      preview.replaceChildren(
        el("div", { class: "danger-text", style: "font-size:12px;padding:12px" }, [
          el("div", { text: "This file appears to be missing or damaged." }),
          el("div", { class: "hint", style: "color:inherit", text: describe(e, "It could not be decrypted.") }),
          el("div", { class: "hint", style: "color:inherit", text: "Restore it from a backup if you have one." }),
        ]),
      );
    });
}

function renderPreview(item: VaultItem, blob: Blob, url: string): Node {
  if (item.mimeType.startsWith("image/")) {
    return el("img", { src: url, alt: item.displayName });
  }
  if (item.mimeType.startsWith("text/")) {
    const pre = el("pre", { text: "…" });
    void blob.slice(0, 200_000).text().then((t) => (pre.textContent = t));
    return pre;
  }
  // PDFs are handled before this point, by renderPdf(). Anything else has no
  // safe in-app representation.
  return el("div", { class: "hint", style: "padding:20px;text-align:center" }, [
    el("div", { text: `No in-app preview for ${kind(item.mimeType, item.originalName ?? "")}.` }),
    el("div", { text: "Save or share it to open in another app." }),
  ]);
}

function actions(
  app: App,
  item: VaultItem,
  h: { close: () => void },
  getBlob: () => Blob | null,
): HTMLElement {
  const reload = async () => {
    await app.refresh();
    app.render();
  };

  const share = el("button", {
    class: "btn",
    text: "Share",
    title: "Creates a readable copy outside the vault",
    onClick: async () => {
      const blob = getBlob();
      if (!blob) return;
      const file = new File([blob], item.originalName ?? item.displayName, { type: item.mimeType });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch {
          /* user dismissed the sheet */
        }
      } else {
        download(file);
      }
    },
  });

  return el("div", { class: "actions" }, [
    el("button", {
      class: "btn ghost",
      text: item.favorite ? "★ Pinned" : "☆ Pin",
      onClick: async () => {
        await app.client.call({ t: "update", id: item.id, patch: { favorite: !item.favorite } });
        h.close();
        await reload();
      },
    }),
    el("button", {
      class: "btn",
      text: "Edit",
      onClick: () => {
        h.close();
        openEdit(app, item);
      },
    }),
    el("button", {
      class: "btn",
      text: "Save",
      onClick: () => {
        const blob = getBlob();
        if (blob) download(new File([blob], item.originalName ?? item.displayName, { type: item.mimeType }));
      },
    }),
    share,
    el("button", {
      class: "btn danger",
      text: "Delete",
      onClick: () => {
        h.close();
        confirmModal(
          `Delete "${item.displayName}"?`,
          [
            el("div", { text: "This removes the encrypted local copy from your vault." }),
            el("div", { class: "hint", text: "Previously exported backups may still contain it." }),
          ],
          "Delete",
          async () => {
            await app.client.call({ t: "delete", id: item.id });
            await reload();
          },
          { danger: true },
        );
      },
    }),
  ]);
}

function openEdit(app: App, item: VaultItem): void {
  const snap = app.snapshot!;
  const name = el("input", { type: "text", value: item.displayName });
  const tags = el("input", { type: "text", value: item.tags.join(", ") });
  const notes = el("textarea", { text: item.notes ?? "" });
  const expires = el("input", { type: "date", value: item.expiresAt ?? "" });
  const collection = el("select", {}, [
    el("option", { value: "", text: "— none —" }),
    ...snap.collections.map((c) =>
      el("option", { value: c.id, text: c.name, selected: c.id === item.collectionId }),
    ),
  ]);

  modal("Edit", (h) => [
    el("div", { class: "field" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field" }, [el("label", { text: "Collection" }), collection]),
    el("div", { class: "field" }, [el("label", { text: "Tags" }), tags]),
    el("div", { class: "field" }, [el("label", { text: "Expires" }), expires]),
    el("div", { class: "field" }, [el("label", { text: "Notes" }), notes]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn", text: "Cancel", onClick: () => h.close() }),
      el("button", {
        class: "btn primary",
        text: "Save",
        onClick: async () => {
          await app.client.call({
            t: "update",
            id: item.id,
            patch: {
              displayName: name.value.trim() || item.displayName,
              collectionId: collection.value || undefined,
              tags: tags.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
              notes: notes.value.trim() || undefined,
              expiresAt: expires.value || undefined,
            },
          });
          h.close();
          await app.refresh();
          app.render();
        },
      }),
    ]),
  ]);
}

export function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = el("a", { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
