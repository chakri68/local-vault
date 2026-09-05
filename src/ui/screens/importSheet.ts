import { el, setWidth } from "../dom.ts";
import { bytes, kind } from "../format.ts";
import { describe } from "../errors.ts";
import { modal } from "../modal.ts";
import type { App } from "../app.ts";
import type { VaultItem } from "../../vault/types.ts";
import { hasRoomFor } from "../../platform/storage.ts";

/**
 * §15. Nothing is committed without the user seeing it first — that rule is why
 * shared files can sit in memory rather than being written somewhere.
 */
export function openImport(app: App, files: File[]): void {
  let index = 0;
  const imported: VaultItem[] = [];

  const next = () => {
    if (index >= files.length) {
      void app.refresh().then(() => app.render());
      return;
    }
    sheet(app, files[index], files.length > 1 ? `${index + 1} of ${files.length}` : null, (item) => {
      if (item) imported.push(item);
      index++;
      next();
    });
  };
  next();
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || name;
}

function sheet(
  app: App,
  file: File,
  counter: string | null,
  done: (item: VaultItem | null) => void,
): void {
  const snap = app.snapshot!;
  const name = el("input", { type: "text", value: baseName(file.name) });
  const notes = el("textarea", {});
  const tagInput = el("input", { type: "text", placeholder: "tag, tag, tag" });
  const docDate = el("input", { type: "date" });
  const expires = el("input", { type: "date" });

  const collection = el("select", {}, [
    el("option", { value: "", text: "— none —" }),
    ...snap.collections.map((c) => el("option", { value: c.id, text: c.name })),
  ]);

  const error = el("div", { class: "notice error", hidden: true });
  const dup = el("div", { class: "notice warn", hidden: true });
  const bar = el("div", { class: "bar", hidden: true }, [el("i", { style: "width:0%" })]);
  const phase = el("div", { class: "hint", text: "" });
  const save = el("button", { class: "btn primary", text: "Encrypt & Save" });

  const handle = modal(counter ? `Add to Vault · ${counter}` : "Add to Vault", (h) => [
    el("div", { class: "card" }, [
      el("div", { class: "hstack" }, [
        el("span", { class: "muted", style: "font-size:11px", text: kind(file.type, file.name) }),
        el("span", { class: "grow name", text: file.name }),
        el("span", { class: "meta num", text: bytes(file.size) }),
      ]),
    ]),
    dup,
    el("div", { class: "field" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field" }, [el("label", { text: "Collection" }), collection]),
    el("div", { class: "field" }, [
      el("label", { text: "Tags" }),
      tagInput,
      el("div", { class: "hint", text: "Comma separated. Free-form, many per document." }),
    ]),
    el("div", { class: "hstack" }, [
      el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Document date" }), docDate]),
      el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Expires" }), expires]),
    ]),
    el("div", { class: "field" }, [el("label", { text: "Notes" }), notes]),
    error,
    bar,
    phase,
    el("div", { class: "actions" }, [
      el("button", {
        class: "btn",
        text: "Cancel",
        onClick: () => {
          h.close();
          done(null);
        },
      }),
      save,
    ]),
  ]);

  const setProgress = (label: string, doneBytes: number, total: number) => {
    bar.hidden = false;
    const pct = total ? Math.round((doneBytes / total) * 100) : 0;
    setWidth(bar.firstElementChild!, pct);
    phase.textContent = `${label} · ${bytes(doneBytes)} / ${bytes(total)}`;
  };

  save.addEventListener("click", async () => {
    error.hidden = true;
    save.disabled = true;

    try {
      // §11.1/§25: the swap file means an import needs ~2× the file size free.
      const room = await hasRoomFor(file.size);
      if (!room.ok) {
        throw new Error(
          `Not enough browser storage quota. Importing needs about ${bytes(file.size * 2)} free while writing; ${bytes(room.remaining)} is available.`,
        );
      }

      // §36: hash before writing so a duplicate can be reported, not discovered.
      save.textContent = "Hashing…";
      const { sha256, duplicateOf } = await app.client.call(
        { t: "hashCandidate", file },
        (p) => setProgress("Hashing", p.done, p.total),
      );

      if (duplicateOf && dup.hidden) {
        dup.hidden = false;
        dup.replaceChildren(
          el("div", { text: "This file may already be in your vault." }),
          el("div", { class: "hint", style: "color:inherit", text: `Existing: ${duplicateOf.displayName}` }),
          el("div", { class: "hint", style: "color:inherit", text: "Save again to add a second copy." }),
        );
        save.disabled = false;
        save.textContent = "Save Another Copy";
        bar.hidden = true;
        phase.textContent = "";
        return;
      }

      save.textContent = "Encrypting…";
      const item = await app.client.call(
        {
          t: "import",
          file,
          sha256,
          meta: {
            displayName: name.value.trim() || file.name,
            originalName: file.name,
            collectionId: collection.value || undefined,
            tags: tagInput.value
              .split(",")
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean),
            notes: notes.value.trim() || undefined,
            documentDate: docDate.value || undefined,
            expiresAt: expires.value || undefined,
          },
        },
        (p) => setProgress("Encrypting", p.done, p.total),
      );

      handle.close();
      done(item);
    } catch (e) {
      save.disabled = false;
      save.textContent = "Encrypt & Save";
      bar.hidden = true;
      phase.textContent = "";
      error.textContent = describe(e, "This file could not be added to the vault.");
      error.hidden = false;
    }
  });
}
