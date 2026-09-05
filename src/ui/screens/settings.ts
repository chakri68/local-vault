import { el, setWidth } from "../dom.ts";
import { ago, bytes, date } from "../format.ts";
import { describe } from "../errors.ts";
import { confirmModal, modal } from "../modal.ts";
import { requestPersistence } from "../../platform/storage.ts";
import type { App } from "../app.ts";
import type { AutoLockMs } from "../../vault/types.ts";
import { download } from "./itemSheet.ts";
import { renderRestore } from "./restore.ts";

const AUTO_LOCK: { label: string; value: AutoLockMs }[] = [
  { label: "Immediately when the app leaves the foreground", value: 0 },
  { label: "After 1 minute", value: 60_000 },
  { label: "After 5 minutes", value: 300_000 },
  { label: "After 15 minutes", value: 900_000 },
  { label: "Never while the app stays open", value: null },
];

export function openSettings(app: App, focus?: "backup"): void {
  modal("Settings", () => [
    storageSection(app),
    backupSection(app),
    securitySection(app),
    aboutSection(app),
  ]);
  if (focus === "backup") {
    document.querySelector<HTMLElement>("[data-backup-start]")?.focus();
  }
}

/* ---------------- storage (§23, §24, §48) ---------------- */

function storageSection(app: App): HTMLElement {
  const s = app.storage;
  const status = el("div", { class: "hstack" }, [
    el("span", {
      class: s?.persisted ? "ok-text" : "warn-text",
      text: s?.persisted ? "● Persistent storage enabled" : "⚠ Persistent storage not granted",
    }),
  ]);

  const retry = el("button", {
    class: "btn",
    text: "Try Again",
    hidden: !!s?.persisted,
    onClick: async () => {
      await requestPersistence();
      app.storage = await app.client.call({ t: "storage" });
      status.firstElementChild!.className = app.storage.persisted ? "ok-text" : "warn-text";
      status.firstElementChild!.textContent = app.storage.persisted
        ? "● Persistent storage enabled"
        : "⚠ Persistent storage not granted";
      retry.hidden = app.storage.persisted;
    },
  });

  return el("div", { class: "section" }, [
    el("h2", { text: "Storage" }),
    el("div", { class: "card stack" }, [
      status,
      el("dl", { class: "kv" }, [
        el("dt", { text: "Vault" }),
        el("dd", { text: `${bytes(s?.usage ?? 0)} · ${app.snapshot!.items.length} files` }),
        el("dt", { text: "Quota" }),
        el("dd", { text: `~${bytes(s?.quota ?? 0)}` }),
      ]),
      el("div", {
        class: "hint",
        text: "Quota is a browser estimate. It is not the same as free space on the disk.",
      }),
      retry,
    ]),
  ]);
}

/* ---------------- backup (§27–§30, §33, §51) ---------------- */

function backupSection(app: App): HTMLElement {
  const snap = app.snapshot!;
  const bar = el("div", { class: "bar", hidden: true }, [el("i", { style: "width:0%" })]);
  const status = el("div", { class: "hint", text: "" });
  const error = el("div", { class: "notice error", hidden: true });
  const ready = el("div", { class: "stack", hidden: true });

  const start = el("button", {
    class: "btn primary",
    text: "Create Backup",
    "data-backup-start": "true",
  });

  start.addEventListener("click", async () => {
    error.hidden = true;
    ready.hidden = true;
    start.disabled = true;
    bar.hidden = false;
    try {
      const result = await app.client.call({ t: "exportBackup" }, (p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        setWidth(bar.firstElementChild!, pct);
        status.textContent = `${bytes(p.done)} / ${bytes(p.total)}`;
      });

      setWidth(bar.firstElementChild!, 100);
      status.textContent = "";
      start.disabled = false;
      start.textContent = "Create Backup";

      // §30: the archive is ready, but navigator.share() needs a *fresh* user
      // gesture. Hence a second, separate tap rather than one continuous action.
      ready.hidden = false;
      ready.replaceChildren(
        el("div", { class: "notice ok", text: `Backup ready · ${bytes(result.size)}` }),
        el("div", { class: "hstack" }, [
          el("button", {
            class: "btn primary",
            text: "Save",
            onClick: async () => {
              const file = await app.client.call({ t: "readBackup", tempName: result.tempName });
              const streamed = await saveFile(file, result.fileName, app);
              // A File handed out of OPFS is a lazy handle to the path, not a
              // snapshot. Deleting the temp file while the browser is still
              // pulling bytes through an object URL truncates the download, so
              // only the picker path — which resolves when the write is done —
              // is safe to clean up immediately. The rest is ciphertext in
              // /vault/temp/ and sweepTemp() collects it on the next lock.
              await finish(app, result.tempName, result.createdAt, streamed);
            },
          }),
          app.caps.webShareFiles
            ? el("button", {
                class: "btn",
                text: "Share",
                onClick: async () => {
                  const file = await app.client.call({ t: "readBackup", tempName: result.tempName });
                  const named = new File([file], result.fileName, { type: "application/zip" });
                  try {
                    await navigator.share({ files: [named] });
                    await finish(app, result.tempName, result.createdAt, false);
                  } catch {
                    /* dismissed, or the platform refused a file this large */
                  }
                },
              })
            : null,
          el("button", {
            class: "btn ghost",
            text: "Discard",
            onClick: async () => {
              await app.client.call({ t: "discardBackup", tempName: result.tempName });
              ready.hidden = true;
              bar.hidden = true;
            },
          }),
        ]),
      );
    } catch (e) {
      start.disabled = false;
      bar.hidden = true;
      error.textContent = describe(e, "The backup could not be created.");
      error.hidden = false;
    }
  });

  return el("div", { class: "section" }, [
    el("h2", { text: "Backup & Restore" }),
    el("div", { class: "card stack" }, [
      el("dl", { class: "kv" }, [
        el("dt", { text: "Last backup" }),
        el("dd", { text: snap.lastBackupAt ? `${date(snap.lastBackupAt)} (${ago(snap.lastBackupAt)})` : "never" }),
        el("dt", { text: "Changes since" }),
        el("dd", { text: String(snap.changesSinceBackup) }),
      ]),
      start,
      bar,
      status,
      ready,
      error,
      el("button", {
        class: "btn",
        text: "Restore Backup",
        onClick: () => modal("Restore Backup", (h) => [renderRestore(app, () => h.close())]),
      }),
      el("button", { class: "add-btn", text: "Verify Vault", onClick: () => verify(app) }),
    ]),
  ]);
}

/** Returns true when the bytes are provably written and the temp file is free. */
async function saveFile(file: File, name: string, app: App): Promise<boolean> {
  const picker = (globalThis as {
    showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;

  // Desktop Chromium streams straight to the chosen path. Elsewhere the object
  // URL is served off the temp file, so the heap never holds the archive (§30).
  if (app.caps.fileSystemAccess && picker) {
    const handle = await picker({
      suggestedName: name,
      types: [{ description: "Local Vault backup", accept: { "application/zip": [".zip"] } }],
    });
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable as unknown as WritableStream<Uint8Array>);
    return true;
  }
  download(new File([file], name, { type: "application/zip" }));
  return false;
}

async function finish(
  app: App,
  tempName: string,
  createdAt: string,
  discard: boolean,
): Promise<void> {
  await app.client.call({ t: "markBackedUp", at: createdAt });
  if (discard) await app.client.call({ t: "discardBackup", tempName });
  await app.refresh();
}

/** §51. Authenticates every chunk without holding a whole file. */
function verify(app: App): void {
  const bar = el("div", { class: "bar" }, [el("i", { style: "width:0%" })]);
  const out = el("div", { class: "stack" });
  modal("Verify Vault", () => [bar, out]);

  void app.client
    .call({ t: "verify" }, (p) => {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      setWidth(bar.firstElementChild!, pct);
    })
    .then((report) => {
      setWidth(bar.firstElementChild!, 100);
      const clean = !report.missing.length && !report.damaged.length && !report.orphaned.length;
      out.replaceChildren(
        el("div", { class: `notice ${clean ? "ok" : "error"}` }, [
          el("div", { text: clean ? `All ${report.checked} objects authenticate.` : "Problems found." }),
        ]),
        ...report.missing.map((i) =>
          el("div", { class: "danger-text", text: `Missing: ${i.displayName}` }),
        ),
        ...report.damaged.map((d) =>
          el("div", { class: "danger-text", text: `Damaged: ${d.item.displayName} — ${d.reason}` }),
        ),
        report.orphaned.length
          ? el("div", { class: "hint", text: `${report.orphaned.length} unreferenced object(s) on disk.` })
          : el("div", {}),
      );
    })
    .catch((e: Error) => {
      out.replaceChildren(
        el("div", { class: "notice error", text: describe(e, "Verification could not finish.") }),
      );
    });
}

/* ---------------- security (§17, §9.3, §18) ---------------- */

function securitySection(app: App): HTMLElement {
  const snap = app.snapshot!;
  const autoLock = el(
    "select",
    {
      onChange: async (e: Event) => {
        const raw = (e.target as HTMLSelectElement).value;
        await app.client.call({
          t: "settings",
          patch: { autoLockMs: raw === "null" ? null : Number(raw) },
        });
        await app.refresh();
      },
    },
    AUTO_LOCK.map((o) =>
      el("option", {
        value: String(o.value),
        text: o.label,
        selected: o.value === snap.settings.autoLockMs,
      }),
    ),
  );

  const deviceUnlock = el("div", { class: "hint" }, [
    el("div", {
      text:
        app.caps.webAuthnPrf === false
          ? "Device unlock isn't securely supported by this browser or device. Your passphrase still works."
          : "Device unlock lands next. It will never replace the passphrase.",
    }),
  ]);

  return el("div", { class: "section" }, [
    el("h2", { text: "Security" }),
    el("div", { class: "card stack" }, [
      el("div", { class: "field" }, [el("label", { text: "Auto-lock" }), autoLock]),
      el("button", { class: "btn", text: "Change Passphrase", onClick: () => changePassphrase(app) }),
      el("div", { class: "field" }, [el("label", { text: "Unlock with this device" }), deviceUnlock]),
      el("button", {
        class: "btn danger",
        text: "Delete Vault",
        onClick: () =>
          confirmModal(
            "Delete this vault?",
            [
              el("div", { text: "Every encrypted file and all metadata on this device is removed." }),
              el("div", { class: "hint", text: "Exported backups are not affected. This cannot be undone." }),
            ],
            "Delete Vault",
            async () => {
              await app.client.call({ t: "destroy" });
              app.snapshot = null;
              app.index = [];
              app.state = await app.client.call({ t: "probe" });
              document.querySelectorAll(".backdrop").forEach((n) => n.remove());
              app.render();
            },
            { danger: true },
          ),
      }),
    ]),
  ]);
}

function changePassphrase(app: App): void {
  const current = el("input", { type: "password", autocomplete: "current-password" });
  const next = el("input", { type: "password", autocomplete: "new-password" });
  const confirm = el("input", { type: "password", autocomplete: "new-password" });
  const error = el("div", { class: "notice error", hidden: true });

  modal("Change Passphrase", (h) => [
    el("div", {
      class: "hint",
      text: "Only the wrapped master key is re-encrypted. No stored file is touched.",
    }),
    el("div", { class: "field" }, [el("label", { text: "Current" }), current]),
    el("div", { class: "field" }, [el("label", { text: "New" }), next]),
    el("div", { class: "field" }, [el("label", { text: "Confirm new" }), confirm]),
    error,
    el("div", { class: "actions" }, [
      el("button", { class: "btn", text: "Cancel", onClick: () => h.close() }),
      el("button", {
        class: "btn primary",
        text: "Change",
        onClick: async (e: Event) => {
          const btn = e.target as HTMLButtonElement;
          error.hidden = true;
          if (next.value.length < 10) {
            error.textContent = "Use at least 10 characters.";
            error.hidden = false;
            return;
          }
          if (next.value !== confirm.value) {
            error.textContent = "The new passphrases don't match.";
            error.hidden = false;
            return;
          }
          btn.disabled = true;
          btn.textContent = "Deriving…";
          try {
            await app.client.call({
              t: "changePassphrase",
              current: current.value,
              next: next.value,
            });
            h.close();
          } catch {
            btn.disabled = false;
            btn.textContent = "Change";
            error.textContent = "That current passphrase is not correct.";
            error.hidden = false;
          }
        },
      }),
    ]),
  ]);
}

function aboutSection(app: App): HTMLElement {
  return el("div", { class: "section" }, [
    el("h2", { text: "About" }),
    el("div", { class: "card stack" }, [
      el("dl", { class: "kv" }, [
        el("dt", { text: "Build" }),
        el("dd", { text: __BUILD_ID__ }),
        el("dt", { text: "Share target" }),
        el("dd", { text: app.caps.webShareTargetExpected ? "registered" : "not available here" }),
      ]),
      el("div", {
        class: "hint",
        text:
          "Local Vault makes no network requests while you use it. Everything above happens on this device.",
      }),
      el("div", {
        class: "hint",
        text:
          "Chromium only. Safari has no streaming OPFS writes and no share target, so it is not supported.",
      }),
    ]),
  ]);
}
