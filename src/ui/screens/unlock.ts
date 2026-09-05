import { el } from "../dom.ts";
import { modal } from "../modal.ts";
import type { App } from "../app.ts";
import { renderRestore } from "./restore.ts";
import { decodeB64url, evaluatePrf } from "../../platform/webauthn.ts";
import { unb64 } from "../../vault/bytes.ts";
import { describe } from "../errors.ts";

/** §21. Passphrase always works; §50 says a wrong one reveals nothing. */
export function renderUnlock(app: App): HTMLElement {
  const pass = el("input", { type: "password", autocomplete: "current-password" });
  const error = el("div", { class: "notice error", hidden: true });
  const unlock = el("button", { class: "btn primary", text: "Unlock" });

  const submit = async () => {
    error.hidden = true;
    unlock.disabled = true;
    unlock.textContent = "Deriving key…";
    try {
      await app.client.call({ t: "unlock", passphrase: pass.value });
      pass.value = "";
      await app.onUnlocked();
    } catch (e) {
      unlock.disabled = false;
      unlock.textContent = "Unlock";
      error.textContent =
        (e as Error).message === "no vault on this device"
          ? "No vault on this device."
          : "Vault could not be unlocked. The passphrase may be incorrect, or the vault data may be damaged.";
      error.hidden = false;
      pass.select();
    }
  };

  unlock.addEventListener("click", () => void submit());
  pass.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void submit();
  });

  // §21: offered only when a PRF wrapper actually exists. Failure here always
  // falls back to the passphrase, which is never not an option (§22).
  const device = el("button", {
    class: "btn primary",
    text: "Unlock with this device",
    hidden: !app.deviceUnlock,
  });
  device.addEventListener("click", async () => {
    const info = app.deviceUnlock;
    if (!info) return;
    error.hidden = true;
    device.disabled = true;
    device.textContent = "Waiting for this device…";
    try {
      const prfOutput = await evaluatePrf(decodeB64url(info.credentialId), unb64(info.prfSalt));
      await app.client.call({ t: "unlockDevice", prfOutput });
      await app.onUnlocked();
    } catch (e) {
      device.disabled = false;
      device.textContent = "Unlock with this device";
      error.textContent = describe(e, "This device couldn't unlock the vault. Use your passphrase.");
      error.hidden = false;
    }
  });

  const pendingNote =
    app.pending.length > 0
      ? el("div", { class: "notice warn" }, [
          el("div", {
            text: `${app.pending.length} shared file${app.pending.length > 1 ? "s" : ""} waiting to be imported.`,
          }),
          el("div", {
            class: "hint",
            style: "color:inherit;opacity:.8",
            text: "Held in memory only. Closing the app now discards them — nothing plaintext is written to disk.",
          }),
        ])
      : null;

  return el("div", { class: "center" }, [
    el("div", { class: "panel" }, [
      el("h1", { text: "LOCAL VAULT" }),
      pendingNote,
      device,
      app.deviceUnlock ? el("div", { class: "hint", text: "or" }) : null,
      el("div", { class: "field" }, [el("label", { text: "Vault passphrase" }), pass]),
      error,
      el("div", { class: "hstack" }, [
        unlock,
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
