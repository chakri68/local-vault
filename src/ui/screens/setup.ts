import { el } from "../dom.ts";
import { modal } from "../modal.ts";
import type { App } from "../app.ts";
import { renderRestore } from "./restore.ts";

const MIN_PASSPHRASE = 10;

/** §8.1 first run, plus §33's "restore existing vault" entry point. */
export function renderSetup(app: App): HTMLElement {
  const pass = el("input", { type: "password", autocomplete: "new-password" });
  const confirm = el("input", { type: "password", autocomplete: "new-password" });
  const error = el("div", { class: "notice error", hidden: true });
  const create = el("button", { class: "btn primary", text: "Create Vault" });

  const fail = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };

  create.addEventListener("click", async () => {
    error.hidden = true;
    if (pass.value.length < MIN_PASSPHRASE) {
      return fail(`Use at least ${MIN_PASSPHRASE} characters. Longer beats complicated.`);
    }
    if (pass.value !== confirm.value) return fail("The two passphrases don't match.");

    create.disabled = true;
    create.textContent = "Deriving key…";
    try {
      await app.client.call({ t: "create", passphrase: pass.value });
      pass.value = confirm.value = "";
      await app.onUnlocked();
    } catch (e) {
      create.disabled = false;
      create.textContent = "Create Vault";
      fail((e as Error).message);
    }
  });

  return el("div", { class: "center" }, [
    el("div", { class: "panel" }, [
      el("h1", { text: "LOCAL VAULT" }),
      el("p", {
        class: "muted",
        style: "font-size:12px;margin:0",
        text: "Encrypted documents that stay on this device.",
      }),

      el("div", { class: "card", style: "font-size:12px" }, [
        el("div", { class: "stack" }, [
          el("div", { text: "· Your files never leave this device." }),
          el("div", { text: "· Everything is encrypted before it is written." }),
          el("div", { text: "· Clearing site data destroys the local copy." }),
          el("div", { class: "warn-text", text: "· Export a backup. OPFS is not a backup." }),
        ]),
      ]),

      el("div", { class: "field" }, [
        el("label", { text: "Vault passphrase" }),
        pass,
        el("div", {
          class: "hint",
          text: "There is no reset. Lose this and the vault is gone — including its backups.",
        }),
      ]),
      el("div", { class: "field" }, [el("label", { text: "Confirm passphrase" }), confirm]),

      error,

      el("div", { class: "hstack" }, [
        create,
        el("button", {
          class: "btn ghost",
          text: "Restore a backup",
          onClick: () => {
            modal("Restore Backup", (h) => [renderRestore(app, () => h.close())]);
          },
        }),
      ]),
    ]),
  ]);
}
