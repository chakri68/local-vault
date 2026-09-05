import { el, setWidth } from "../dom.ts";
import { bytes } from "../format.ts";
import { BAD_PASSPHRASE_OR_DAMAGED, describe } from "../errors.ts";
import type { App } from "../app.ts";

/**
 * §33. Everything is validated — magic, version, passphrase, manifest, object
 * inventory — before a single byte on disk is touched, so a bad passphrase or a
 * damaged archive leaves an existing vault exactly as it was.
 */
export function renderRestore(app: App, done: () => void): HTMLElement {
  const picker = el("input", { type: "file", accept: ".zip,application/zip" });
  const pass = el("input", { type: "password", autocomplete: "current-password" });
  const error = el("div", { class: "notice error", hidden: true });
  const progress = el("div", { class: "bar", hidden: true }, [el("i", { style: "width:0%" })]);
  const status = el("div", { class: "hint", text: "" });
  const go = el("button", { class: "btn primary", text: "Restore" });

  const replaceWarning =
    app.state !== "UNINITIALIZED"
      ? el("div", { class: "notice warn" }, [
          el("div", { text: "A vault already exists on this device." }),
          el("div", {
            class: "hint",
            style: "color:inherit;opacity:.85",
            text: "Restoring replaces it. Export the current vault first if you might still need it.",
          }),
        ])
      : null;

  go.addEventListener("click", async () => {
    error.hidden = true;
    const file = picker.files?.[0];
    if (!file) {
      error.textContent = "Choose a .vault.zip file.";
      error.hidden = false;
      return;
    }
    go.disabled = true;
    go.textContent = "Validating…";
    progress.hidden = false;

    try {
      const result = await app.client.call(
        { t: "restoreBackup", file, passphrase: pass.value },
        (p) => {
          go.textContent = "Restoring…";
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          setWidth(progress.firstElementChild!, pct);
          status.textContent = `${bytes(p.done)} / ${bytes(p.total)}`;
        },
      );
      pass.value = "";
      status.textContent = `Restored ${result.items} items.`;
      done();
      app.state = await app.client.call({ t: "probe" });
      app.render();
    } catch (e) {
      go.disabled = false;
      go.textContent = "Restore";
      progress.hidden = true;
      error.textContent = describe(
        e,
        `Backup could not be restored. ${BAD_PASSPHRASE_OR_DAMAGED}`,
      );
      error.hidden = false;
    }
  });

  return el("div", {}, [
    replaceWarning,
    el("div", { class: "field" }, [el("label", { text: "Backup archive" }), picker]),
    el("div", { class: "field" }, [
      el("label", { text: "Vault passphrase" }),
      pass,
      el("div", {
        class: "hint",
        text: "The passphrase the backup was created with. Device unlock is not involved.",
      }),
    ]),
    error,
    progress,
    status,
    el("div", { class: "actions" }, [go]),
  ]);
}
